import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { AppPlatform } from '../app-version.types';

export type AppVersionPolicyDocument = HydratedDocument<AppVersionPolicy>;

/**
 * Which app builds are current, and which are forced to update. There is one
 * document per platform, set in the admin panel. With no document, nothing is
 * offered and nothing is forced.
 *
 * The rule runs on build numbers (Android's versionCode), never on "1.0.2",
 * so there is no version string to parse. The names are only for people.
 */
@Schema({ collection: 'app_version_policy', timestamps: true })
export class AppVersionPolicy {
  _id!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(AppPlatform), required: true, unique: true })
  platform!: AppPlatform;

  /** The newest build in the store. Anything below it is offered the update. */
  @Prop({ type: Number, default: 0 })
  latestVersionCode!: number;

  @Prop({ type: String, default: null })
  latestVersionName!: string | null;

  /** Builds below this are blocked until updated. 0 means nothing is forced. */
  @Prop({ type: Number, default: 0 })
  minVersionCode!: number;

  @Prop({ type: String, default: null })
  minVersionName!: string | null;

  /** The store listing. Null falls back to the default for the platform. */
  @Prop({ type: String, default: null })
  storeUrl!: string | null;

  /** Shown in the prompt under the title, e.g. what the update fixes. */
  @Prop({ type: String, default: null })
  message!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  updatedBy!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AppVersionPolicySchema = SchemaFactory.createForClass(AppVersionPolicy);
