import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { ProductFeature, ProductOffer } from '../product.types';

export type ProductDocument = HydratedDocument<Product>;

/**
 * Our local snapshot of a provider's product.
 *
 * This is a cache of the catalogue, NOT the source of truth for what a user
 * asked for. When an item is imported into a wishlist, the wishlist item gets
 * its own copy of the title and price (see ItemsService.createFromProduct) —
 * this row may drift with the upstream catalogue, and the item must not.
 */
@Schema({ collection: 'products', timestamps: true })
export class Product {
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true })
  provider!: string;

  @Prop({ type: String, required: true })
  externalId!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, default: null })
  description!: string | null;

  @Prop({ type: [String], default: [] })
  imageUrls!: string[];

  @Prop({ type: String, required: true })
  productUrl!: string;

  @Prop({ type: String, default: null })
  affiliateUrl!: string | null;

  /** Minor units. Integer, always. */
  @Prop({ type: Number, default: null })
  amountMinor!: number | null;

  /** Pre-discount / MRP, minor units. Null when the provider gives none. */
  @Prop({ type: Number, default: null })
  listPriceMinor!: number | null;

  @Prop({ type: String, default: 'INR', uppercase: true })
  currency!: string;

  @Prop({ type: String, default: null })
  merchant!: string | null;

  @Prop({ type: String, default: null })
  category!: string | null;

  @Prop({ type: Boolean, default: true })
  inStock!: boolean;

  // Product facts a buyer reads, kept out of affiliateMeta on purpose — see
  // NormalizedProduct. Sparse: most Google Shopping rows carry none of them.
  @Prop({ type: Number, default: null })
  rating!: number | null;

  @Prop({ type: Number, default: null })
  reviewCount!: number | null;

  @Prop({ type: String, default: null })
  deliveryNote!: string | null;

  @Prop({ type: String, default: null })
  brand!: string | null;

  // Detail-lookup only, so a plain search never overwrites them — see
  // ProductsService.upsertMany.
  @Prop({ type: [{ label: String, value: String }], default: [] })
  features!: ProductFeature[];

  @Prop({
    type: [
      {
        merchant: String,
        amountMinor: Number,
        url: String,
        // Cached per offer, not per product: the three sellers behind one
        // product are three different merchant URLs, and the product-level
        // `affiliateUrl` can only ever hold one of them. Without this, every
        // seller row but the first would either send an unmonetized link or
        // silently redirect to whichever seller happened to be converted.
        affiliateUrl: { type: String, default: null },
        affiliated: { type: Boolean, default: null },
      },
    ],
    default: [],
  })
  offers!: ProductOffer[];

  @Prop({ type: Object, default: {} })
  affiliateMeta!: Record<string, unknown>;

  @Prop({ type: Date, default: Date.now })
  lastSyncedAt!: Date;

  /** Last successful sync where something actually changed. Debugging aid. */
  @Prop({ type: Date, default: null })
  lastChangedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

// A provider's id is unique only within that provider, so identity is the pair.
ProductSchema.index({ provider: 1, externalId: 1 }, { unique: true });
// Drives the nightly sync sweep: oldest snapshots first.
ProductSchema.index({ lastSyncedAt: 1 });
