import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Idempotent } from 'src/common/idempotency/idempotent.decorator';
import { GiftActionDto, GiftOfflineDto, ReserveItemDto } from './dto/gift.dto';
import { GiftListService } from './gift-list.service';
import { GiftingService } from './gifting.service';
import type { GiftListItemView, GiftView } from './gift.views';

/** Reserving is a real commitment; a tight bucket blunts scripted claiming. */
const GIFT_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@ApiTags('gifting')
@Controller()
@ApiBearerAuth()
export class GiftingController {
  constructor(
    private readonly gifting: GiftingService,
    private readonly giftLists: GiftListService,
  ) {}

  // ── Reserve / release (item-scoped) ────────────────────────────────────────

  @Post('items/:itemId/reserve')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(GIFT_THROTTLE)
  @Idempotent()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8–200 chars; a retry replays the first response',
  })
  @ApiOperation({
    summary: 'Reserve an item',
    description:
      'The critical section: Redlock + a Mongo transaction + a unique index. 50 simultaneous ' +
      'reservers yield exactly one success and 49 ITEM_NOT_AVAILABLE / ITEM_ALREADY_CLAIMED.',
  })
  @ApiResponseDoc({ status: 409, description: 'ITEM_NOT_AVAILABLE / ITEM_ALREADY_CLAIMED' })
  @ApiResponseDoc({ status: 403, description: 'CANNOT_GIFT_OWN_ITEM' })
  @ApiResponseDoc({ status: 400, description: 'IDEMPOTENCY_KEY_REQUIRED' })
  reserve(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: ReserveItemDto,
  ): Promise<GiftView> {
    return this.gifting.reserve(itemId, userId, dto);
  }

  @Delete('items/:itemId/reserve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Release your reservation',
    description: 'Returns the item to available.',
  })
  @ApiResponseDoc({ status: 404, description: 'GIFT_NOT_FOUND — no active reservation' })
  async release(@CurrentUser('id') userId: string, @Param('itemId') itemId: string): Promise<void> {
    await this.gifting.release(itemId, userId);
  }

  @Post('items/:itemId/gift-offline')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(GIFT_THROTTLE)
  @Idempotent()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Record a gift bought elsewhere',
    description: 'Lands directly at purchased (mode: offline). No online order to track.',
  })
  @ApiResponseDoc({ status: 409, description: 'ITEM_NOT_AVAILABLE' })
  giftOffline(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: GiftOfflineDto,
  ): Promise<GiftView> {
    return this.gifting.giftOffline(itemId, userId, dto);
  }

  // ── Gift-scoped transitions ────────────────────────────────────────────────

  @Post('gifts/:giftId/purchase')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a reserved gift purchased' })
  @ApiResponseDoc({ status: 409, description: 'INVALID_GIFT_TRANSITION' })
  purchase(
    @CurrentUser('id') userId: string,
    @Param('giftId') giftId: string,
    @Body() dto: GiftActionDto,
  ): Promise<GiftView> {
    return this.gifting.purchase(giftId, userId, dto);
  }

  @Post('gifts/:giftId/fulfill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a purchased gift fulfilled (shipped/delivered)' })
  fulfill(
    @CurrentUser('id') userId: string,
    @Param('giftId') giftId: string,
    @Body() dto: GiftActionDto,
  ): Promise<GiftView> {
    return this.gifting.fulfill(giftId, userId, dto);
  }

  @Post('gifts/:giftId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a gift completed (received)' })
  complete(
    @CurrentUser('id') userId: string,
    @Param('giftId') giftId: string,
    @Body() dto: GiftActionDto,
  ): Promise<GiftView> {
    return this.gifting.complete(giftId, userId, dto);
  }

  @Post('gifts/:giftId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a gift', description: 'Returns the item to available.' })
  cancel(
    @CurrentUser('id') userId: string,
    @Param('giftId') giftId: string,
    @Body() dto: GiftActionDto,
  ): Promise<GiftView> {
    return this.gifting.cancel(giftId, userId, dto);
  }

  // ── Dashboard sections ─────────────────────────────────────────────────────

  @Get('gifts/given')
  @ApiOperation({
    summary: 'Gifts you are giving (`324:1253`)',
    description:
      'Rows carry the item, the recipient’s first name and the delivery state — what the ' +
      'list screen draws. Group gifts are included; the frame has a Group tab.',
  })
  given(@CurrentUser('id') userId: string): Promise<GiftListItemView[]> {
    return this.giftLists.listGiven(userId);
  }

  @Get('gifts/received')
  @ApiOperation({
    summary: 'Gifts you have received (`324:1108`)',
    description:
      'Surprises still in progress (hidden + reserved/purchased) are omitted — which is also ' +
      'why naming the gifter here gives nothing away.',
  })
  received(@CurrentUser('id') userId: string): Promise<GiftListItemView[]> {
    return this.giftLists.listReceived(userId);
  }

  @Get('gifts/on-hold')
  @ApiOperation({ summary: 'Gifts on hold by you (`324:1210`)' })
  onHold(@CurrentUser('id') userId: string): Promise<GiftListItemView[]> {
    return this.giftLists.listOnHold(userId);
  }
}
