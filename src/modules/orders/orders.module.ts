import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Gift, GiftSchema } from 'src/modules/gifting/schemas/gift.schema';
import { CourierWebhookController } from './courier-webhook.controller';
import { CourierWebhookService } from './courier-webhook.service';
import { OrderListener } from './order.listener';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './schemas/order.schema';

/**
 * Order tracking, downstream of gifting.
 *
 * Depends on gifting only through its domain events and its Gift schema (to
 * read a purchased gift's mode and amount) — never on GiftingService — so the
 * dependency runs one way and there is no cycle.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Gift.name, schema: GiftSchema },
    ]),
  ],
  controllers: [OrdersController, CourierWebhookController],
  providers: [OrdersService, CourierWebhookService, OrderListener],
  exports: [OrdersService],
})
export class OrdersModule {}
