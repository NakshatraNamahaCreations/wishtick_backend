import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { GroupGift, GroupGiftSchema } from 'src/modules/group-gifts/schemas/group-gift.schema';
import {
  ThankYouNote,
  ThankYouNoteSchema,
} from 'src/modules/notifications/schemas/thank-you-note.schema';
import { Order, OrderSchema } from 'src/modules/orders/schemas/order.schema';
import { UsersModule } from 'src/modules/users/users.module';
import { WishlistsModule } from 'src/modules/wishlists/wishlists.module';
import {
  WishlistItem,
  WishlistItemSchema,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { GiftStatusService } from './gift-status.service';
import { GiftingController } from './gifting.controller';
import { GiftListService } from './gift-list.service';
import { GiftingService } from './gifting.service';
import { ReservationExpiryRegistrar } from './reservation-expiry.processor';
import { ReservationExpiryService } from './reservation-expiry.service';
import { Gift, GiftSchema } from './schemas/gift.schema';
import { WebhookEvent, WebhookEventSchema } from './schemas/webhook-event.schema';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Gift.name, schema: GiftSchema },
      { name: WebhookEvent.name, schema: WebhookEventSchema },
      // Registered here too so GiftStatusService can write item status/visibility.
      { name: WishlistItem.name, schema: WishlistItemSchema },
      // Read-only, for the three Profile list screens. Schemas, not modules —
      // the lists project across these, they do not depend on those features.
      { name: Order.name, schema: OrderSchema },
      { name: GroupGift.name, schema: GroupGiftSchema },
      { name: ThankYouNote.name, schema: ThankYouNoteSchema },
    ]),
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
    // For AccessPolicyService, WishlistsService, and the item model. One-way:
    // gifting depends on wishlists, never the reverse.
    WishlistsModule,
    // For the counterparty's first name on a list row.
    UsersModule,
  ],
  controllers: [GiftingController, WebhookController],
  providers: [
    GiftingService,
    GiftListService,
    GiftStatusService,
    ReservationExpiryService,
    ReservationExpiryRegistrar,
    WebhookService,
  ],
  exports: [
    GiftingService,
    GiftListService,
    GiftStatusService,
    WebhookService,
    ReservationExpiryService,
  ],
})
export class GiftingModule {}
