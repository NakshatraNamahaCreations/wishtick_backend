import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import { Order, type OrderDocument } from 'src/modules/orders/schemas/order.schema';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import { escapeRegex } from './admin-query.util';
import { AdminPermission } from './admin.types';

/** One thing the search found: what it is, what to call it, and a hint. */
export interface SearchHit {
  kind: 'user' | 'wishlist' | 'event' | 'groupGift' | 'order';
  id: string;
  label: string;
  sub: string | null;
}

/** How many of each kind come back — enough to pick from, not a list page. */
const PER_KIND = 5;

/**
 * The panel's search box: one query across the records an admin looks things
 * up by — a user by email, phone, name or username; a wishlist, event or group
 * gift by title or share slug; an order by its reference; anything by its id.
 *
 * Only the kinds the admin may see come back. Email and phone are matched but
 * never returned in full: the hint shows the shape, as the rest of the panel
 * does until someone chooses to reveal them.
 */
@Injectable()
export class AdminSearchService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
    @InjectModel(Wishlist.name) private readonly wishlists: Model<WishlistDocument>,
    @InjectModel(Event.name) private readonly events: Model<EventDocument>,
    @InjectModel(GroupGift.name) private readonly groupGifts: Model<GroupGiftDocument>,
    @InjectModel(Order.name) private readonly orders: Model<OrderDocument>,
  ) {}

  async search(q: string, permissions: AdminPermission[]): Promise<SearchHit[]> {
    const text = q.trim();
    if (text.length < 2) return [];
    const can = (p: AdminPermission) => permissions.includes(p);
    const contains = new RegExp(escapeRegex(text), 'i');
    const byId =
      Types.ObjectId.isValid(text) && /^[a-f0-9]{24}$/i.test(text)
        ? new Types.ObjectId(text)
        : null;

    const work: Promise<SearchHit[]>[] = [];
    if (can(AdminPermission.USERS_VIEW)) work.push(this.findUsers(contains, byId));
    if (can(AdminPermission.CONTENT_VIEW)) {
      work.push(this.findWishlists(contains, byId), this.findEvents(contains, byId));
    }
    if (can(AdminPermission.MONEY_VIEW)) {
      work.push(this.findGroupGifts(contains, byId), this.findOrders(contains, byId));
    }
    return (await Promise.all(work)).flat();
  }

  private async findUsers(contains: RegExp, byId: Types.ObjectId | null): Promise<SearchHit[]> {
    // A username or display name lives on the profile, not the account.
    const viaProfile = await this.profiles
      .find({ $or: [{ username: contains }, { displayName: contains }] })
      .select('userId')
      .limit(PER_KIND)
      .exec();
    const found = await this.users
      .find({
        $or: [
          { email: contains },
          { phone: contains },
          { name: contains },
          { _id: { $in: viaProfile.map((p) => p.userId) } },
          ...(byId ? [{ _id: byId }] : []),
        ],
      })
      .sort({ createdAt: -1 })
      .limit(PER_KIND)
      .exec();
    const profiles = await this.profiles
      .find({ userId: { $in: found.map((u) => u._id) } })
      .select('userId displayName username')
      .exec();
    const profileOf = new Map(profiles.map((p) => [p.userId.toString(), p]));
    return found.map((u) => {
      const profile = profileOf.get(u._id.toString());
      return {
        kind: 'user' as const,
        id: u._id.toString(),
        label: profile?.displayName || u.name || 'Unnamed account',
        sub: [profile?.username ? `@${profile.username}` : null, u.status]
          .filter(Boolean)
          .join(' · '),
      };
    });
  }

  private async findWishlists(contains: RegExp, byId: Types.ObjectId | null): Promise<SearchHit[]> {
    const found = await this.wishlists
      .find({
        $or: [{ title: contains }, { 'share.slug': contains }, ...(byId ? [{ _id: byId }] : [])],
      })
      .sort({ createdAt: -1 })
      .limit(PER_KIND)
      .exec();
    return found.map((w) => ({
      kind: 'wishlist' as const,
      id: w._id.toString(),
      label: w.title,
      sub: w.archivedAt ? 'Archived' : w.visibility,
    }));
  }

  private async findEvents(contains: RegExp, byId: Types.ObjectId | null): Promise<SearchHit[]> {
    const found = await this.events
      .find({
        $or: [{ title: contains }, { shareSlug: contains }, ...(byId ? [{ _id: byId }] : [])],
      })
      .sort({ startsAt: -1 })
      .limit(PER_KIND)
      .exec();
    return found.map((e) => ({
      kind: 'event' as const,
      id: e._id.toString(),
      label: e.title,
      sub: `${e.status} · ${e.startsAt.toISOString().slice(0, 10)}`,
    }));
  }

  private async findGroupGifts(
    contains: RegExp,
    byId: Types.ObjectId | null,
  ): Promise<SearchHit[]> {
    const found = await this.groupGifts
      .find({
        $or: [{ title: contains }, { 'share.slug': contains }, ...(byId ? [{ _id: byId }] : [])],
      })
      .sort({ createdAt: -1 })
      .limit(PER_KIND)
      .exec();
    return found.map((g) => ({
      kind: 'groupGift' as const,
      id: g._id.toString(),
      label: g.title,
      sub: g.status,
    }));
  }

  private async findOrders(contains: RegExp, byId: Types.ObjectId | null): Promise<SearchHit[]> {
    const found = await this.orders
      .find({ $or: [{ reference: contains }, ...(byId ? [{ _id: byId }] : [])] })
      .sort({ createdAt: -1 })
      .limit(PER_KIND)
      .exec();
    return found.map((o) => ({
      kind: 'order' as const,
      id: o._id.toString(),
      label: o.reference,
      sub: o.stage,
    }));
  }
}
