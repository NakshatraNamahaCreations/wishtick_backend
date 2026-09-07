import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { Event, EventSchema } from 'src/modules/events/schemas/event.schema';
import { Gift, GiftSchema } from 'src/modules/gifting/schemas/gift.schema';
import { GroupGift, GroupGiftSchema } from 'src/modules/group-gifts/schemas/group-gift.schema';
import { MediaModule } from 'src/modules/media/media.module';
import { UsersModule } from 'src/modules/users/users.module';
import {
  WishlistItem,
  WishlistItemSchema,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { Wishlist, WishlistSchema } from 'src/modules/wishlists/schemas/wishlist.schema';
import { DeviceTokenService } from './device-token.service';
import { NotificationController } from './notification.controller';
import { NotificationListener } from './notification.listener';
import { NotificationProcessor } from './notification.processor';
import { NotificationRenderer } from './notification.renderer';
import { NotificationService } from './notification.service';
import { DeliveryLog, DeliveryLogSchema } from './schemas/delivery-log.schema';
import {
  NotificationPreference,
  NotificationPreferenceSchema,
} from './schemas/notification-preference.schema';
import { DeviceToken, DeviceTokenSchema } from './schemas/device-token.schema';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import { ThankYouNote, ThankYouNoteSchema } from './schemas/thank-you-note.schema';
import { ThankYouController } from './thank-you.controller';
import { ThankYouService } from './thank-you.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: NotificationPreference.name, schema: NotificationPreferenceSchema },
      { name: DeliveryLog.name, schema: DeliveryLogSchema },
      { name: DeviceToken.name, schema: DeviceTokenSchema },
      { name: ThankYouNote.name, schema: ThankYouNoteSchema },
      // Read-only, for resolving display context and thank-you context. Schemas,
      // not modules — the notification module subscribes to events, it does not
      // depend on those features.
      { name: WishlistItem.name, schema: WishlistItemSchema },
      { name: Wishlist.name, schema: WishlistSchema },
      { name: GroupGift.name, schema: GroupGiftSchema },
      { name: Gift.name, schema: GiftSchema },
      { name: Event.name, schema: EventSchema },
    ]),
    BullModule.registerQueue({ name: QUEUE.NOTIFICATIONS }),
    UsersModule,
    // A module, not a schema: attaching a recording to a thank-you must go
    // through MediaService's ownership and readiness checks.
    MediaModule,
  ],
  controllers: [NotificationController, ThankYouController],
  providers: [
    NotificationService,
    DeviceTokenService,
    ThankYouService,
    NotificationRenderer,
    NotificationListener,
    NotificationProcessor,
  ],
  exports: [NotificationService, DeviceTokenService],
})
export class NotificationsModule {}
