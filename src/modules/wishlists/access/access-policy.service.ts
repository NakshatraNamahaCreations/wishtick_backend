import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  WishlistParticipant,
  type WishlistParticipantDocument,
} from '../schemas/wishlist-participant.schema';
import type { WishlistDocument } from '../schemas/wishlist.schema';
import { ParticipantRole, ParticipantState, WishlistVisibility } from '../wishlist.types';
import { DENY_ALL, Relationship, type AccessContext, type AccessDecision } from './access.types';
import { EVENT_PARTICIPATION, type IEventParticipation } from './event-participation.port';

/**
 * The single place that decides who may do what to a wishlist.
 *
 * Every other module calls this and nothing re-implements it. That rule is the
 * whole point: wishlists, items, chat (Sprint 8), and gifting (Sprint 6) all
 * need the same answer, and four copies of "is this person allowed" is four
 * chances to leak a surprise gift or a private list. If a caller needs a new
 * question answered, it is added here — never worked around locally.
 *
 * ─── The matrix ──────────────────────────────────────────────────────────────
 *
 * Resolution is priority-ordered: the first relationship that matches wins, so
 * an owner arriving via their own share link is still an owner.
 *
 * | visibility   | owner | participant | event invitee | link holder | stranger |
 * |--------------|-------|-------------|---------------|-------------|----------|
 * | public       | VCM   | VCG         | VCG           | VG(+C)      | V(+G)    |
 * | private      | VCM   | VCG         | —             | —           | —        |
 * | event_only   | VCM   | VCG         | VCG           | —           | —        |
 * | invite_only  | VCM   | VCG         | —             | VG          | —        |
 *
 * V=view C=comment G=gift M=manage
 *
 * Deliberate choices:
 *
 * - **The owner cannot gift.** Reserving your own item is meaningless, and
 *   allowing it would let an owner's own reservation hide an item from real
 *   gifters. Owners mark items fulfilled through `canManage` instead.
 * - **A share link grants nothing on a private list.** "Private" means the
 *   people you chose; if a forwarded link could open it, the setting would be a
 *   suggestion. INVITE_ONLY exists precisely for "unlisted but link-shareable".
 * - **Only the owner manages.** A moderator moderates chat (Sprint 8); handing
 *   them edit rights would let an invited guest delete the list.
 * - **Gifting requires an account.** Sprint 6 must attribute a reservation to
 *   somebody, and an anonymous hold cannot be released or chased.
 * - **Commenting requires an account and `chatEnabled`,** and on non-public
 *   lists a bare VIEWER stays read-only — the owner chose who may talk.
 */
@Injectable()
export class AccessPolicyService {
  constructor(
    @InjectModel(WishlistParticipant.name)
    private readonly participants: Model<WishlistParticipantDocument>,
    @Inject(EVENT_PARTICIPATION) private readonly events: IEventParticipation,
  ) {}

  /**
   * Resolves the caller's rights over one wishlist.
   *
   * Deliberately uncached. A permission cache is a correctness problem wearing a
   * performance costume: revoking a participant or rotating a share slug has to
   * take effect on the *next* request, and a 60-second TTL means a removed
   * person keeps reading a private list for a minute. The reads here are two
   * indexed lookups; when that is genuinely the bottleneck, cache the wishlist
   * document, never the decision.
   */
  async resolve(wishlist: WishlistDocument, ctx: AccessContext): Promise<AccessDecision> {
    // An archived list is readable by its owner only — it is gone from the
    // product but retained so gifting history does not dangle.
    if (wishlist.archivedAt && wishlist.ownerId.toString() !== ctx.userId) {
      return DENY_ALL;
    }

    if (ctx.userId && wishlist.ownerId.toString() === ctx.userId) {
      return {
        canView: true,
        canComment: wishlist.chatEnabled,
        canGift: false,
        canManage: true,
        relationship: Relationship.OWNER,
        role: null,
      };
    }

    const participant = ctx.userId
      ? await this.findActiveParticipant(wishlist._id, ctx.userId)
      : null;
    if (participant) {
      return this.grant(Relationship.PARTICIPANT, participant.role, wishlist);
    }

    // Event membership grants access ONLY on an EVENT_ONLY list.
    //
    // A wishlist can carry an eventId while still being PRIVATE — attached to
    // the occasion, but shared with a hand-picked few. Consulting the event on
    // every visibility would hand the whole guest list access to a private
    // list, which is the opposite of what its owner chose. PUBLIC needs no
    // special case: the public fallback below already grants an invitee the
    // same rights.
    if (
      wishlist.visibility === WishlistVisibility.EVENT_ONLY &&
      ctx.userId &&
      wishlist.eventId &&
      (await this.events.isAcceptedInvitee(wishlist.eventId, ctx.userId))
    ) {
      // Event invitees behave like contributors: they were invited to the
      // occasion, so they may talk and gift.
      return this.grant(Relationship.EVENT_PARTICIPANT, ParticipantRole.CONTRIBUTOR, wishlist);
    }

    if (ctx.share && this.shareLinkGrantsAccess(wishlist, ctx.share)) {
      return {
        canView: true,
        // A link holder is not someone the owner picked, so they stay out of
        // the chat unless the list is public.
        canComment:
          wishlist.chatEnabled &&
          Boolean(ctx.userId) &&
          wishlist.visibility === WishlistVisibility.PUBLIC,
        canGift: Boolean(ctx.userId),
        canManage: false,
        relationship: Relationship.LINK_HOLDER,
        role: null,
      };
    }

    if (wishlist.visibility === WishlistVisibility.PUBLIC) {
      return {
        canView: true,
        canComment: wishlist.chatEnabled && Boolean(ctx.userId),
        canGift: Boolean(ctx.userId),
        canManage: false,
        relationship: Relationship.PUBLIC,
        role: null,
      };
    }

    return DENY_ALL;
  }

  /** Rights of someone the owner (or an event) has actually admitted. */
  private grant(
    relationship: Relationship,
    role: ParticipantRole,
    wishlist: WishlistDocument,
  ): AccessDecision {
    return {
      canView: true,
      canComment: wishlist.chatEnabled && role !== ParticipantRole.VIEWER,
      canGift: true,
      canManage: false,
      relationship,
      role,
    };
  }

  /**
   * A participant counts only while ACCEPTED and not revoked.
   *
   * Both conditions are in the query rather than checked after: a revoked row
   * must be invisible to the policy, and filtering in code is where someone
   * eventually forgets a clause.
   */
  private async findActiveParticipant(
    wishlistId: Types.ObjectId,
    userId: string,
  ): Promise<WishlistParticipantDocument | null> {
    if (!Types.ObjectId.isValid(userId)) return null;
    return this.participants
      .findOne({
        wishlistId,
        userId: new Types.ObjectId(userId),
        state: ParticipantState.ACCEPTED,
        revokedAt: null,
      })
      .exec();
  }

  /** Whether a presented share link is currently valid for this wishlist. */
  private shareLinkGrantsAccess(
    wishlist: WishlistDocument,
    presented: { slug: string; passcode?: string },
  ): boolean {
    // PRIVATE and EVENT_ONLY are never link-openable, whatever the slug.
    const linkable =
      wishlist.visibility === WishlistVisibility.PUBLIC ||
      wishlist.visibility === WishlistVisibility.INVITE_ONLY;
    if (!linkable) return false;

    if (!AccessPolicyService.safeEqual(wishlist.share.slug, presented.slug)) return false;
    if (wishlist.share.expiresAt && wishlist.share.expiresAt.getTime() < Date.now()) return false;

    if (wishlist.share.passcodeHash) {
      if (!presented.passcode) return false;
      return AccessPolicyService.safeEqual(
        wishlist.share.passcodeHash,
        AccessPolicyService.hashPasscode(presented.passcode),
      );
    }
    return true;
  }

  // ── Assertions used by controllers ────────────────────────────────────────

  /**
   * 404, never 403, when the caller cannot view.
   *
   * Telling an unauthorized caller "this exists but you may not see it"
   * confirms the wishlist's existence — enough to probe for a surprise party.
   * Not-viewable and not-there are the same answer.
   */
  async assertCanView(wishlist: WishlistDocument, ctx: AccessContext): Promise<AccessDecision> {
    const decision = await this.resolve(wishlist, ctx);
    if (!decision.canView) {
      throw new AppException(ErrorCode.WISHLIST_NOT_FOUND, 'Wishlist not found', 404);
    }
    return decision;
  }

  /**
   * 403 once the caller can already see the wishlist — hiding it now would be
   * absurd, and they need to know the action is not theirs to take.
   */
  async assertCanManage(wishlist: WishlistDocument, ctx: AccessContext): Promise<AccessDecision> {
    const decision = await this.assertCanView(wishlist, ctx);
    if (!decision.canManage) {
      throw new AppException(ErrorCode.FORBIDDEN, 'Only the wishlist owner can do this', 403);
    }
    return decision;
  }

  async assertCanGift(wishlist: WishlistDocument, ctx: AccessContext): Promise<AccessDecision> {
    const decision = await this.assertCanView(wishlist, ctx);
    if (!decision.canGift) {
      throw new AppException(ErrorCode.FORBIDDEN, 'You cannot gift from this wishlist', 403);
    }
    return decision;
  }

  async assertCanComment(wishlist: WishlistDocument, ctx: AccessContext): Promise<AccessDecision> {
    const decision = await this.assertCanView(wishlist, ctx);
    if (!decision.canComment) {
      throw new AppException(ErrorCode.FORBIDDEN, 'You cannot post in this chat', 403);
    }
    return decision;
  }

  static hashPasscode(passcode: string): string {
    return createHash('sha256').update(passcode).digest('hex');
  }

  /**
   * Whether a presented passcode matches a stored hash, in constant time.
   *
   * A null hash means the link has no passcode — no passcode can match, so this
   * is only called after establishing one is set. Shared so the group-gift share
   * link enforces passcodes identically to a wishlist's.
   */
  static passcodeMatches(presented: string, storedHash: string | null): boolean {
    if (!storedHash) return false;
    return AccessPolicyService.safeEqual(AccessPolicyService.hashPasscode(presented), storedHash);
  }

  /** Length-independent comparison so a slug cannot be guessed by timing. */
  private static safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
