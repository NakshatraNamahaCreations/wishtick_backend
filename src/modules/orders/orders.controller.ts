import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { OrderView } from './order.views';
import { OrdersService } from './orders.service';

/**
 * Order Confirmed / Track Order / Delivered (Figma `299:1486`, `299:1513`,
 * `299:1620`).
 *
 * Read-only. An order is created and advanced by the gift lifecycle and, in
 * future, a courier feed — never by the client, so there is nothing to POST.
 */
@ApiTags('orders')
@Controller()
@ApiBearerAuth()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('orders/mine')
  @ApiOperation({
    summary: 'Orders for gifts you are giving, newest first',
    description:
      'Only online gifts have an order; an offline gift was bought elsewhere and has ' +
      'nothing to track.',
  })
  listMine(@CurrentUser('id') userId: string): Promise<OrderView[]> {
    return this.orders.listMine(userId);
  }

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'One order and its timeline' })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  getOne(@CurrentUser('id') userId: string, @Param('orderId') orderId: string): Promise<OrderView> {
    return this.orders.getOwned(userId, orderId);
  }

  @Get('gifts/:giftId/order')
  @ApiOperation({
    summary: 'The order behind one of your gifts',
    description:
      'Lets the confirmation screen follow straight on from a purchase without ' +
      'having to search your order list for the one just made.',
  })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — no order, or not your gift' })
  getByGift(
    @CurrentUser('id') userId: string,
    @Param('giftId') giftId: string,
  ): Promise<OrderView> {
    return this.orders.getByGift(userId, giftId);
  }
}
