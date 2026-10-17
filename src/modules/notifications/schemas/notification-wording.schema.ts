import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type NotificationWordingDocument = HydratedDocument<NotificationWording>;

/**
 * The wording an admin wrote for one notification, in place of the built-in
 * copy: the headline and the line under it, as the app and a push show them.
 * Fill-ins such as `{itemTitle}` take each notification's own details.
 *
 * One per type; no row means the built-in wording.
 */
@Schema({ collection: 'notification_wordings', timestamps: true })
export class NotificationWording {
  @Prop({ required: true, unique: true })
  type!: string;

  @Prop({ required: true })
  title!: string;

  @Prop({ required: true })
  body!: string;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  updatedById!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  updatedByEmail!: string | null;

  updatedAt!: Date;
}

export const NotificationWordingSchema = SchemaFactory.createForClass(NotificationWording);
