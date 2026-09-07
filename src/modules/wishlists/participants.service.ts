import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  WISHLIST_PARTICIPANT_REVOKED,
  type WishlistParticipantRevokedEvent,
} from 'src/common/events/domain-events';
import type { UserDocument } from 'src/modules/users/schemas/user.schema';
import { UsersService } from 'src/modules/users/users.service';
import { AccessPolicyService } from './access/access-policy.service';
import type { AccessContext } from './access/access.types';
import type { AddParticipantDto } from './dto/wishlist.dto';
import {
  WishlistParticipant,
  type WishlistParticipantDocument,
} from './schemas/wishlist-participant.schema';
import { WishlistsService } from './wishlists.service';
import { ParticipantRole, ParticipantState } from './wishlist.types';

export interface ParticipantView {
  id: string;
  userId: string | null;
  /**
   * The participant's display name.
   *
   * Hydrated here rather than left to the caller: without it the guest list is
   * a column of ObjectIds, and every client would have to fan out to /users to
   * render one row. Null only for an account with no name set.
   */
  name: string | null;
  role: ParticipantRole;
  state: ParticipantState;
  createdAt: Date;
}

@Injectable()
export class ParticipantsService {
  private readonly logger = new Logger(ParticipantsService.name);

  constructor(
    @InjectModel(WishlistParticipant.name)
    private readonly model: Model<WishlistParticipantDocument>,
    private readonly wishlists: WishlistsService,
    private readonly access: AccessPolicyService,
    private readonly users: UsersService,
    private readonly emitter: EventEmitter2,
  ) {}

  async list(wishlistId: string, ctx: AccessContext): Promise<ParticipantView[]> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    // The guest list is the owner's business: it reveals who was invited to a
    // party, which is exactly the sort of thing a surprise depends on.
    await this.access.assertCanManage(wishlist, ctx);

    const rows = await this.model
      .find({ wishlistId: wishlist._id, revokedAt: null })
      .sort({ createdAt: 1 })
      .exec();

    // One batched lookup for the whole list rather than one per row.
    const users = await this.users.findManyByIds(
      rows.map((row) => row.userId).filter((id): id is Types.ObjectId => id != null),
    );
    const byId = new Map(users.map((user) => [user._id.toString(), user]));

    return rows.map((row) =>
      ParticipantsService.toView(row, row.userId ? byId.get(row.userId.toString()) : undefined),
    );
  }

  /**
   * Adds somebody on the strength of an invitation they accepted elsewhere.
   *
   * Unlike [add], the *caller* is the person being added, so there is no
   * `assertCanManage` — the authority is the invitation, which the caller of
   * this method has already verified. It exists because a group-gift invitee
   * has to be able to gift from the underlying wishlist before they can join,
   * and a private list grants that to nobody by default.
   *
   * Idempotent, and never a downgrade: somebody already on the list keeps
   * whatever role the owner gave them rather than being quietly reduced to the
   * one an invitation implies.
   */
  async addForInvite(wishlistId: string, userId: string, role: ParticipantRole): Promise<void> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    // The owner needs nothing; adding them would also make them a participant
    // on their own list, which the policy treats as a different relationship.
    if (wishlist.ownerId.toString() === userId) return;

    const existing = await this.model
      .findOne({ wishlistId: wishlist._id, userId: new Types.ObjectId(userId) })
      .exec();

    if (existing) {
      // A revoked row is revived: the invitation is a fresh decision by the
      // person who was removed, and refusing it silently would be a dead end
      // they cannot see the cause of.
      if (existing.revokedAt) {
        existing.revokedAt = null;
        existing.state = ParticipantState.ACCEPTED;
        existing.acceptedAt = new Date();
        await existing.save();
      }
      return;
    }

    await this.model.create({
      wishlistId: wishlist._id,
      userId: new Types.ObjectId(userId),
      role,
      state: ParticipantState.ACCEPTED,
      acceptedAt: new Date(),
      invitedBy: new Types.ObjectId(userId),
    });
  }

  async add(
    wishlistId: string,
    ctx: AccessContext,
    dto: AddParticipantDto,
  ): Promise<ParticipantView> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);

    const userId = new Types.ObjectId(dto.userId);

    if (userId.equals(wishlist.ownerId)) {
      throw new AppException(
        ErrorCode.CANNOT_INVITE_OWNER,
        'The owner already has full access to this wishlist',
        409,
      );
    }

    // Verify the account exists; otherwise a stale id silently creates a
    // participant row that can never match anyone.
    const user = await this.users.findByIdOrFail(dto.userId);

    const existing = await this.model.findOne({ wishlistId: wishlist._id, userId }).exec();

    if (existing && !existing.revokedAt) {
      throw new AppException(
        ErrorCode.PARTICIPANT_ALREADY_EXISTS,
        'This person already has access to the wishlist',
        409,
      );
    }

    // Re-inviting a revoked person reuses their row, so the history of the
    // removal survives rather than being papered over by a fresh insert.
    if (existing?.revokedAt) {
      existing.revokedAt = null;
      existing.role = dto.role ?? ParticipantRole.VIEWER;
      existing.state = ParticipantState.ACCEPTED;
      existing.acceptedAt = new Date();
      await existing.save();
      return ParticipantsService.toView(existing, user);
    }

    const participant = await this.model.create({
      wishlistId: wishlist._id,
      userId,
      role: dto.role ?? ParticipantRole.VIEWER,
      // Auto-accepted: the owner picked this person deliberately out of their
      // WishMates, and an accept step with nothing to trigger it would leave
      // every share stuck at "invited".
      state: ParticipantState.ACCEPTED,
      acceptedAt: new Date(),
      invitedBy: new Types.ObjectId(ctx.userId!),
    });

    return ParticipantsService.toView(participant, user);
  }

  /**
   * Revokes access. Takes effect on the revoked person's very next request —
   * AccessPolicyService reads participants live and caches no decision.
   */
  async revoke(wishlistId: string, participantId: string, ctx: AccessContext): Promise<void> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);

    if (!Types.ObjectId.isValid(participantId)) {
      throw new AppException(ErrorCode.PARTICIPANT_NOT_FOUND, 'Participant not found', 404);
    }

    const participant = await this.model
      .findOne({
        _id: new Types.ObjectId(participantId),
        wishlistId: wishlist._id,
        revokedAt: null,
      })
      .exec();
    if (!participant) {
      throw new AppException(ErrorCode.PARTICIPANT_NOT_FOUND, 'Participant not found', 404);
    }

    participant.revokedAt = new Date();
    participant.state = ParticipantState.REVOKED;
    await participant.save();

    // Evict them from the wishlist's chat (force-disconnect + history lockout).
    // Only a linked user has sockets to disconnect; a pending email invite has none.
    if (participant.userId) {
      this.emitter.emit(WISHLIST_PARTICIPANT_REVOKED, {
        wishlistId: wishlist._id.toString(),
        userId: participant.userId.toString(),
      } satisfies WishlistParticipantRevokedEvent);
    }

    this.logger.log(
      `Participant ${participantId} revoked from wishlist ${wishlist._id.toString()}`,
    );
  }

  private static toView(p: WishlistParticipantDocument, user?: UserDocument): ParticipantView {
    return {
      id: p._id.toString(),
      userId: p.userId?.toString() ?? null,
      name: user?.name?.trim() || null,
      role: p.role,
      state: p.state,
      createdAt: p.createdAt,
    };
  }
}
