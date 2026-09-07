import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { EventGroupGiftsService } from 'src/modules/group-gifts/event-group-gifts.service';
import { UsersService } from 'src/modules/users/users.service';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { AccessPolicyService } from 'src/modules/wishlists/access/access-policy.service';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import type { RsvpDto } from './dto/event.dto';
import { EventStatus } from './event.types';
import type { PublicInviteView } from './event.views';
import type { OpenGraphPreview } from 'src/modules/wishlists/wishlist.views';
import { EventsService } from './events.service';
import { InvitesService } from './invites.service';
import { Event, type EventDocument } from './schemas/event.schema';
import type { EventInviteDocument } from './schemas/event-invite.schema';

@Injectable()
export class PublicInvitesService {
  constructor(
    @InjectModel(Event.name) private readonly events: Model<EventDocument>,
    @InjectModel(Wishlist.name) private readonly wishlists: Model<WishlistDocument>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
    private readonly eventsService: EventsService,
    private readonly invites: InvitesService,
    private readonly access: AccessPolicyService,
    private readonly users: UsersService,
    private readonly groupGifts: EventGroupGiftsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Resolves an invite token to its event.
   *
   * The token is the credential — there is no account behind it — so it is
   * compared by exact match on a unique index and anything unknown is a flat
   * 404. A cancelled event still resolves: people were told to turn up, and
   * "cancelled" is information they need more than a 404.
   */
  private async resolve(
    token: string,
  ): Promise<{ invite: EventInviteDocument; event: EventDocument }> {
    const invite = await this.invites.findByToken(token);
    if (!invite) {
      throw new AppException(ErrorCode.INVITE_TOKEN_INVALID, 'This invite link is not valid', 404);
    }

    const event = await this.events.findById(invite.eventId).exec();
    if (!event) {
      throw new AppException(ErrorCode.INVITE_TOKEN_INVALID, 'This invite link is not valid', 404);
    }
    return { invite, event };
  }

  /** The invitee's view. No account required — the token is the authorization. */
  async getByToken(token: string, viewerUserId?: string): Promise<PublicInviteView> {
    const { invite, event } = await this.resolve(token);

    const [hostFirstName, inviteeName, wishlists, groupGifts] = await Promise.all([
      this.hostFirstName(event),
      this.inviteeName(invite),
      this.visibleWishlists(event, viewerUserId),
      this.groupGifts.forEvent(event._id),
    ]);

    return {
      eventId: event._id.toString(),
      event: {
        title: event.title,
        type: event.type,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: event.timezone,
        description: event.description,
        venue: event.venue,
        coverUrl: event.coverUrl,
        inviteMediaUrl: event.inviteMediaUrl,
        ogImageUrl: event.ogImageUrl,
        status: event.status,
      },
      host: { firstName: hostFirstName },
      invitee: { name: inviteeName, rsvp: invite.rsvp, plusOnes: invite.plusOnes },
      wishlists,
      groupGifts,
    };
  }

  /**
   * RSVP without an account.
   *
   * The scope calls for this explicitly: a guest should not have to sign up to
   * say whether they are coming. Requiring registration to answer a party
   * invitation is the fastest way to get no RSVPs at all.
   */
  async rsvp(token: string, dto: RsvpDto, viewerUserId?: string): Promise<PublicInviteView> {
    const { invite, event } = await this.resolve(token);

    if (event.status === EventStatus.CANCELLED) {
      throw new AppException(ErrorCode.EVENT_CANCELLED, 'This event has been cancelled', 409);
    }
    if (event.status !== EventStatus.PUBLISHED) {
      throw new AppException(ErrorCode.EVENT_NOT_PUBLISHED, 'This invite is not active yet', 409);
    }

    // A signed-in guest opening their emailed link gets their account attached,
    // which is what later makes an EVENT_ONLY wishlist resolve for them.
    if (viewerUserId && !invite.invitedUserId && Types.ObjectId.isValid(viewerUserId)) {
      invite.invitedUserId = new Types.ObjectId(viewerUserId);
    }

    await this.invites.respond(invite, dto.response, {
      plusOnes: dto.plusOnes,
      message: dto.message,
    });

    return this.getByToken(token, viewerUserId);
  }

  /**
   * Which of the event's wishlists this invitee may open.
   *
   * Every list is resolved through AccessPolicyService rather than assumed
   * visible because it is attached to the event. An EVENT_ONLY list appears
   * only once they have RSVP'd yes/maybe *and* are signed in as the invited
   * user; a PRIVATE list the host attached never appears at all. Attaching a
   * wishlist to an event is not a decision to publish it.
   *
   * Two ways in, unioned: the host's own row (`Event.wishlistIds`), and lists a
   * guest offered and the host approved, which are linked the other way round —
   * by `eventId` on the list itself. Keeping them separate leaves the host's
   * curated row host-only, so approving a guest's list cannot reorder or
   * displace it.
   */
  private async visibleWishlists(
    event: EventDocument,
    viewerUserId?: string,
  ): Promise<{ slug: string | null; title: string; locked: boolean }[]> {
    const lists = await this.wishlists
      .find({
        $or: [{ _id: { $in: event.wishlistIds } }, { eventId: event._id }],
        archivedAt: null,
      })
      .exec();
    if (lists.length === 0) return [];

    const hostOwned = new Set(event.wishlistIds.map((id) => id.toString()));
    const visible: { slug: string | null; title: string; locked: boolean }[] = [];
    for (const wishlist of lists) {
      // The invite token is not a wishlist share slug, so it is deliberately
      // NOT passed as `share`: an event invite must not open a list the policy
      // would otherwise refuse. The only thing it establishes is who the caller
      // is, and event membership does the rest.
      const decision = await this.access.resolve(wishlist, { userId: viewerUserId });
      if (decision.canView) {
        visible.push({ slug: wishlist.share.slug, title: wishlist.title, locked: false });
        continue;
      }
      // The host's own private list stays off the invitation entirely —
      // attaching it was not a decision to publish it. A guest's approved list
      // is different: the host said yes to it being *on the event*, so guests
      // are told it exists, and only that. No slug: there is nothing a locked
      // row should let anyone try.
      if (!hostOwned.has(wishlist._id.toString())) {
        visible.push({ slug: null, title: wishlist.title, locked: true });
      }
    }

    return visible;
  }

  /** OG metadata for the event's own share link. */
  async getEventPreview(slug: string): Promise<OpenGraphPreview> {
    const event = await this.eventsService.findBySlug(slug);
    if (!event || event.status === EventStatus.DRAFT) {
      // A draft is not shareable: unfurling one would leak a party the host has
      // not sent yet.
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }

    const hostFirstName = await this.hostFirstName(event);
    const webUrl = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');

    return {
      title: event.status === EventStatus.CANCELLED ? `${event.title} (cancelled)` : event.title,
      description:
        event.description ??
        (hostFirstName ? `${hostFirstName} invited you on Wishtick` : 'An invitation on Wishtick'),
      // The rendered card first: it is what makes a WhatsApp share look like an
      // invitation rather than a link.
      image: event.ogImageUrl ?? event.coverUrl,
      url: `${webUrl}/e/${event.shareSlug}`,
      type: 'website',
      siteName: 'Wishtick',
    };
  }

  /**
   * The greeting on the invitation — "Hi Priya".
   *
   * The name used to be typed by the host when they addressed the invite. It
   * comes from the invitee's own account now, which is both more likely to be
   * how they spell it and one less thing for the host to fill in. Null for an
   * invite written before invitations were WishMate-only; the page greets them
   * without a name rather than with a wrong one.
   */
  private async inviteeName(invite: EventInviteDocument): Promise<string | null> {
    if (!invite.invitedUserId) return null;

    const profile = await this.profiles
      .findOne({ userId: invite.invitedUserId })
      .select('displayName')
      .exec();
    if (profile?.displayName) return profile.displayName.trim() || null;

    const user = await this.users.findById(invite.invitedUserId);
    return user?.name?.trim() || null;
  }

  /** First name only — the same redaction rule as the public wishlist view. */
  private async hostFirstName(event: EventDocument): Promise<string | null> {
    const profile = await this.profiles
      .findOne({ userId: event.hostId })
      .select('displayName')
      .exec();
    if (profile?.displayName) return profile.displayName.trim().split(/\s+/)[0] ?? null;

    const user = await this.users.findById(event.hostId);
    return user?.name ? (user.name.trim().split(/\s+/)[0] ?? null) : null;
  }
}
