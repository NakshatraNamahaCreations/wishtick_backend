import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type AddressDocument = HydratedDocument<Address>;

/** The three chips under "Save address as" (`324:1340`). */
export enum AddressLabel {
  HOME = 'home',
  WORK = 'work',
  OTHER = 'other',
}

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
 */
@Schema({ collection: 'addresses', timestamps: true })
export class Address {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(AddressLabel), default: AddressLabel.HOME })
  label!: AddressLabel;

  // ── Contact information ──────────────────────────────────────────────────

  /** Who receives the parcel; not necessarily the account holder. */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  fullName!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 20 })
  mobile!: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 20 })
  altMobile!: string | null;

  @Prop({ type: String, default: null, trim: true, lowercase: true, maxlength: 254 })
  email!: string | null;

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
