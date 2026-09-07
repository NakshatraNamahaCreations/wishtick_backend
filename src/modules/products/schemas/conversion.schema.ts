import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type ConversionDocument = HydratedDocument<Conversion>;
export type AffiliateSyncStateDocument = HydratedDocument<AffiliateSyncState>;

/**
 * A sale the affiliate network attributed to one of our links.
 *
 * Wishtick never sees the money — the commission is settled by the network on
 * their own schedule — so this is a *report*, not a ledger. Its value is
 * attribution: it is the only thing that connects "someone clicked this item"
 * to "and then actually bought it", which is what makes a gift's status
 * knowable without asking the gifter.
 *
 * Amounts are the network's, in the network's currency, converted to minor
 * units on write so nothing downstream has to think about floats.
 */
@Schema({ collection: 'conversions', timestamps: true })
export class Conversion {
  _id!: Types.ObjectId;

  /** Which network reported it. */
  @Prop({ type: String, required: true })
  network!: string;

  /** The network's own transaction id. Our dedupe key. */
  @Prop({ type: String, required: true })
  externalId!: string;

  @Prop({ type: Number, default: null })
  campaignId!: number | null;

  @Prop({ type: String, default: null })
  campaignName!: string | null;

  // Recovered from the sub-IDs we set when the link was converted. Nullable
  // because a link can be clicked from a context that had none of them, and
  // because the network occasionally drops a sub-ID it was given.
  @Prop({ type: SchemaTypes.ObjectId, ref: 'WishlistItem', default: null })
  itemId!: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Wishlist', default: null })
  wishlistId!: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  userId!: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'GroupGift', default: null })
  groupGiftId!: Types.ObjectId | null;

  /** What the buyer spent, minor units. */
  @Prop({ type: Number, default: null })
  saleAmountMinor!: number | null;

  /** What we earned, minor units. Often revised before it is paid. */
  @Prop({ type: Number, default: null })
  commissionMinor!: number | null;

  @Prop({ type: String, default: 'INR', uppercase: true })
  currency!: string;

  /**
   * The network's status verbatim (pending / confirmed / cancelled / …).
   *
   * Not normalized into our own enum on purpose: networks revise these, the
   * vocabulary differs per network, and mapping an unknown value onto a
   * familiar one is how a cancelled sale ends up looking confirmed.
   */
  @Prop({ type: String, default: null })
  status!: string | null;

  @Prop({ type: Date, default: null })
  transactionAt!: Date | null;

  /** The network's own last-modified, used to order revisions of one sale. */
  @Prop({ type: Date, default: null })
  networkUpdatedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ConversionSchema = SchemaFactory.createForClass(Conversion);

// One transaction per network. Re-syncing the same page must update, not insert.
ConversionSchema.index({ network: 1, externalId: 1 }, { unique: true });
// "Was this item bought?" — the question the gifting flow asks.
ConversionSchema.index({ itemId: 1, transactionAt: -1 });
ConversionSchema.index({ groupGiftId: 1, transactionAt: -1 });
// Reporting sweeps.
ConversionSchema.index({ network: 1, transactionAt: -1 });

/**
 * When each network was last reconciled.
 *
 * Originally held a sync cursor; Cuelinks turned out to paginate by page number
 * with no cursor, and since a revision to an old sale can surface on any page,
 * ConversionSyncService walks from page 1 each run and leans on the unique
 * `{network, externalId}` index for idempotence. What remains worth storing is
 * the timestamp: a reconciliation that quietly stopped running is otherwise
 * invisible until someone asks why earnings look flat.
 */
@Schema({ collection: 'affiliate_sync_state', timestamps: true })
export class AffiliateSyncState {
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  network!: string;

  @Prop({ type: Date, default: null })
  lastSyncedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AffiliateSyncStateSchema = SchemaFactory.createForClass(AffiliateSyncState);
