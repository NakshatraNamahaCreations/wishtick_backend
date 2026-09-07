import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IEventParticipation } from 'src/modules/wishlists/access/event-participation.port';
import { ATTENDING_RSVPS } from './event.types';
import { EventInvite, type EventInviteDocument } from './schemas/event-invite.schema';

/**
 * The real implementation of the port Sprint 3 stubbed out.
 *
 * Answers, for AccessPolicyService: may this user see an EVENT_ONLY wishlist?
 *
 * "Accepted" means the invite is live (not revoked) AND the invitee has replied
 * yes or maybe. Two exclusions worth being explicit about:
 *
 *  - **Declined (`no`) loses access.** Someone who said they are not coming has
 *    no reason to keep reading the gift list for a party they are skipping.
 *  - **Pending does NOT count.** An unanswered invite means someone was asked,
 *    not that they are attending. The tighter reading is deliberate: the plan's
 *    exit criterion says the wishlist opens "exactly to accepted invitees", and
 *    an EVENT_ONLY list can hold surprise-gift details. It also means the flow
 *    is invite → RSVP → see the wishlist, which is a mild gate that happens to
 *    produce the RSVP data the product wants. Loosening this later is easy;
 *    tightening it after launch would take access away from people who had it.
 */
@Injectable()
export class MongoEventParticipation implements IEventParticipation {
  constructor(
    @InjectModel(EventInvite.name) private readonly invites: Model<EventInviteDocument>,
  ) {}

  async isAcceptedInvitee(eventId: Types.ObjectId, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;

    const invite = await this.invites
      .exists({
        eventId,
        invitedUserId: new Types.ObjectId(userId),
        rsvp: { $in: ATTENDING_RSVPS },
        revokedAt: null,
      })
      .exec();

    return invite !== null;
  }
}
