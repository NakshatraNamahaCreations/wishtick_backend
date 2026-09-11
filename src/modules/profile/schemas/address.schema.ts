import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type AddressDocument = HydratedDocument<Address>;

/**
 * The quick-pick chips under "Save address as" (`324:1340`).
 *
 * Suggestions, not the permitted set: `label` is free text, so someone can save
 * "Office" or "Mum's place" without one of these being the closest wrong
 * answer. Offered by the client as one-tap fills.
 */
export const ADDRESS_LABEL_PRESETS = ['Home', 'Work', 'Other'] as const;

export const DEFAULT_ADDRESS_LABEL = 'Home';

/** Long enough for "Grandparents' house", short enough to fit the card's chip. */
export const ADDRESS_LABEL_MAX_LENGTH = 30;

/**
 * One saved delivery address (`2293:25`, `324:1295`, `324:1340`).
 *
 * Its own collection rather than an array on the profile, matching
 * [ImportantDate]: checkout reads a single address by id, and a subdocument
 * array would make that a whole-profile read.
 *
 * Supersedes `UserProfile.contact.deliveryAddress`, a single unstructured
 * string that could not carry a pincode. That field is left in place for
 * existing rows; nothing new writes to it.
 *
 * **Field names track the form in `324:1340`, not a generic postal schema.**
 * Sprint 9 renamed `recipientName`/`phone`/`line2`/`country` and added
 * `altMobile`, `email` and `landmark` because the design asks for each as its
 * own line — migration `022-addresses` moves existing rows across.
 *
 * `altMobile` and `email` are gone again: one number is enough to reach
 * somebody about a delivery, and nothing ever read either of them — they were
 * collected, stored, and echoed back. Migration `031-address-contact-trim`
 * unsets what was already written.
 */
@Schema({ collection: 'addresses', timestamps: true })
export class Address {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  /**
   * What the user calls this address — free text, shown verbatim.
   *
   * Was an enum of home/work/other, which meant a third address could only be
   * "Other" however many of them there were. Stored display-ready (migration
   * `030-address-custom-labels` title-cases the three old values) so no client
   * has to keep its own wire-value → label map, which is how "AddressLabel.home"
   * once reached a real screen.
   */
  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: ADDRESS_LABEL_MAX_LENGTH,
    default: DEFAULT_ADDRESS_LABEL,
  })
  label!: string;

  // ── Contact information ──────────────────────────────────────────────────

  /** Who receives the parcel; not necessarily the account holder. */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  fullName!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 20 })
  mobile!: string;

  // ── Address information ──────────────────────────────────────────────────

  /** "Flat No / Building Name". */
  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  line1!: string;

  /** "Locality / Area". */
  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  locality!: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 200 })
  landmark!: string | null;

  /**
   * Indian PIN — six digits, validated at the DTO. Stored as a string so a
   * leading zero survives.
   */
  @Prop({ type: String, required: true, trim: true, maxlength: 16 })
  pincode!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  city!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  state!: string;

  /** ISO 3166-1 alpha-2. */
  @Prop({ type: String, trim: true, maxlength: 2, default: 'IN' })
  countryCode!: string;

  /**
   * Exactly one address per user carries this. The service clears the previous
   * default in the same write that sets a new one, so the invariant holds
   * without a partial unique index (which would reject the intermediate state).
   */
  @Prop({ type: Boolean, default: false })
  isDefault!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AddressSchema = SchemaFactory.createForClass(Address);

AddressSchema.index({ userId: 1, isDefault: -1, createdAt: 1 });
