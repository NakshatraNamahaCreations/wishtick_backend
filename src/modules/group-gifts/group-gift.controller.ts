import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Idempotent } from 'src/common/idempotency/idempotent.decorator';
import {
  AddChargeDto,
  AddGiftLineDto,
  ContributeDto,
  CreateGroupGiftDto,
  GroupGiftActionDto,
  ListMyGroupGiftsQueryDto,
  ShareGroupGiftDto,
  ThankYouDto,
  InviteToGroupGiftDto,
} from './dto/group-gift.dto';
import { ImportProductDto } from 'src/modules/products/dto/product.dto';
import {
  GroupGiftInvitesService,
  type GroupGiftInviteDetailView,
  type GroupGiftInviteView,
} from './group-gift-invites.service';
import { GroupGiftService } from './group-gift.service';
import type { GroupGiftShareView, GroupGiftView, ItemGroupGiftView } from './group-gift.views';

/** Money-adjacent, and creating claims an item; a tight per-IP bucket blunts scripting. */
const GROUP_GIFT_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

/** Home shows one card; a small default keeps the assembled views cheap. */
const DEFAULT_MINE_LIMIT = 10;

@ApiTags('group-gifting')
@Controller()
@ApiBearerAuth()
export class GroupGiftController {
  constructor(
    private readonly groupGifts: GroupGiftService,
    private readonly invites: GroupGiftInvitesService,
  ) {}

  @Get('items/:itemId/group-gift')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The group gift already collecting for this item, if any',
    description:
      'Null when there is none. Lets the item screen offer a way into the existing group ' +
      'instead of Reserve / Gift Now / Start a Group Gift, all three of which the server ' +
      'refuses once an item is claimed.',
  })
  @ApiResponseDoc({ status: 403, description: 'CANNOT_GIFT_OWN_ITEM' })
  groupGiftForItem(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
  ): Promise<ItemGroupGiftView | null> {
    return this.groupGifts.findForItem(itemId, userId);
  }

  @Post('items/:itemId/group-gift')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(GROUP_GIFT_THROTTLE)
  @Idempotent()
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8–200 chars' })
  @ApiOperation({
    summary: 'Start a group gift on an item',
    description: 'Claims the item via a holder gift, exactly as a single reservation would.',
  })
  @ApiResponseDoc({ status: 409, description: 'ITEM_NOT_AVAILABLE / ITEM_ALREADY_CLAIMED' })
  @ApiResponseDoc({ status: 403, description: 'CANNOT_GIFT_OWN_ITEM' })
  create(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: CreateGroupGiftDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.create(itemId, userId, dto);
  }

  @Post('group-gifts/:id/join')
  @HttpCode(HttpStatus.OK)
  @Throttle(GROUP_GIFT_THROTTLE)
  @ApiOperation({ summary: 'Join a group gift as a named member (no money)' })
  join(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<GroupGiftView> {
    return this.groupGifts.join(id, userId);
  }

  @Post('group-gifts/:id/contribute')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(GROUP_GIFT_THROTTLE)
  @Idempotent()
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8–200 chars' })
  @ApiOperation({
    summary: 'Contribute to a group gift',
    description:
      'The money-critical path: best-effort lock + a transaction + $inc, with a durable ' +
      'idempotency key. 100 concurrent contributions sum to an exact total.',
  })
  @ApiResponseDoc({ status: 409, description: 'GROUP_GIFT_NOT_OPEN / CONTRIBUTION_EXCEEDS_TARGET' })
  contribute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: ContributeDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.contribute(id, userId, idempotencyKey, dto);
  }

  @Delete('group-gifts/:id/contributions/:contributionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw your contribution',
    description: 'Only while the gift is still open. Refunds it and updates the total.',
  })
  @ApiResponseDoc({ status: 403, description: 'NOT_THE_CONTRIBUTOR' })
  removeContribution(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('contributionId') contributionId: string,
  ): Promise<GroupGiftView> {
    return this.groupGifts.removeContribution(id, contributionId, userId);
  }

  @Post('group-gifts/:id/purchase')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Purchase a funded group gift (initiator only)' })
  @ApiResponseDoc({ status: 403, description: 'NOT_THE_INITIATOR' })
  purchase(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: GroupGiftActionDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.purchase(id, userId, dto);
  }

  @Post('group-gifts/:id/fulfill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a purchased group gift fulfilled (initiator only)' })
  fulfill(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: GroupGiftActionDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.fulfill(id, userId, dto);
  }

  @Post('group-gifts/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a group gift (initiator only)',
    description: 'Frees the item and records refunds for any contributions.',
  })
  cancel(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: GroupGiftActionDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.cancel(id, userId, dto);
  }

  /**
   * Declared before ':id' — Nest matches in declaration order, so 'mine' would
   * otherwise be swallowed as a group-gift id.
   */
  @Get('group-gifts/mine')
  @ApiOperation({
    summary: 'Group gifts you take part in, newest first',
    description:
      'Initiated, joined, or contributed to. Excludes gifts where you are the recipient ' +
      'and the group chose to hide it from you.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listMine(
    @CurrentUser('id') userId: string,
    @Query() query: ListMyGroupGiftsQueryDto,
  ): Promise<GroupGiftView[]> {
    return this.groupGifts.listMine(userId, query.limit ?? DEFAULT_MINE_LIMIT);
  }

  @Get('group-gifts/:id')
  @ApiOperation({ summary: 'Group gift progress, participants, and timeline' })
  get(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<GroupGiftView> {
    return this.groupGifts.get(id, userId);
  }

  // ── Charges and extra gifts (Sprint 6b) ──────────────────────────────────

  @Post('group-gifts/:id/charges')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a non-item cost — delivery, wrapping (initiator only)',
    description:
      'Raises the Grand Total. Only legal before anyone has contributed: the bill is ' +
      'agreed on the way to "Proceed to Contribution", so changing it afterwards would ' +
      'move the goalposts under people who already committed against the old number.',
  })
  @ApiResponseDoc({ status: 403, description: 'Only the initiator can add a charge' })
  @ApiResponseDoc({ status: 409, description: 'GROUP_GIFT_BILL_LOCKED — someone has contributed' })
  addCharge(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AddChargeDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.addCharge(id, userId, dto);
  }

  @Patch('group-gifts/:id/charges/:chargeId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit a charge in place (initiator only)',
    description:
      'Atomic on purpose — remove-then-add would leave the charge deleted if the second ' +
      'call failed, silently lowering the Grand Total.',
  })
  updateCharge(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('chargeId') chargeId: string,
    @Body() dto: AddChargeDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.updateCharge(id, chargeId, userId, dto);
  }

  @Delete('group-gifts/:id/charges/:chargeId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a charge (initiator only)' })
  removeCharge(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('chargeId') chargeId: string,
  ): Promise<GroupGiftView> {
    return this.groupGifts.removeCharge(id, chargeId, userId);
  }

  @Post('group-gifts/:id/gifts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Fold a second item into this group gift (initiator only)',
    description:
      'Claims it with its own holder gift through the same lock and unique index as a ' +
      'single reservation, so a multi-gift group can never take an item someone else holds.',
  })
  @ApiResponseDoc({ status: 409, description: 'ITEM_NOT_AVAILABLE / already in this group' })
  addGiftLine(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AddGiftLineDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.addGiftLine(id, dto.itemId, userId);
  }

  @Post('group-gifts/:id/gifts/from-product')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Fold a catalogue product into this group gift (initiator only)',
    description:
      'The picker on `4007:720` searches the catalogue, so the recipient never listed this ' +
      'item and it has to be created before it can be claimed. The only path on which a ' +
      'non-owner writes to another person’s wishlist — the authority is having initiated ' +
      'this group gift. The item is hidden from the recipient whenever the group gift is.',
  })
  @ApiResponseDoc({ status: 403, description: 'Only the initiator can add a gift' })
  @ApiResponseDoc({ status: 409, description: 'GROUP_GIFT_BILL_LOCKED / ITEM_NOT_AVAILABLE' })
  addGiftLineFromProduct(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ImportProductDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.addGiftLineFromProduct(id, userId, dto);
  }

  @Delete('group-gifts/:id/gifts/:lineId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Drop an extra gift back out of the group (initiator only)',
    description:
      'Releases its holder gift so the item returns to available. The primary item is not ' +
      'removable — cancel the group gift instead.',
  })
  removeGiftLine(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<GroupGiftView> {
    return this.groupGifts.removeGiftLine(id, lineId, userId);
  }

  @Post('group-gifts/:id/thank-you')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Write the thank-you note (recipient only)',
    description:
      "Gated on the item's owner, not the initiator — the note comes from the person the " +
      'gift was for. Only legal once the gift has been bought.',
  })
  @ApiResponseDoc({ status: 403, description: 'Only the recipient can write it' })
  @ApiResponseDoc({ status: 409, description: 'The gift has not been bought yet' })
  thankYou(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ThankYouDto,
  ): Promise<GroupGiftView> {
    return this.groupGifts.setThankYou(id, userId, dto.note);
  }

  @Post('group-gifts/:id/invites')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Ask WishMates to chip in',
    description:
      'Any member may invite, not just the initiator. Ids that cannot be ' +
      'invited — already asked, already in, not a WishMate, or the recipient ' +
      '— are skipped rather than failing the batch.',
  })
  invite(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: InviteToGroupGiftDto,
  ): Promise<{ invited: number; skipped: number }> {
    return this.invites.invite(id, userId, dto.userIds);
  }

  @Get('group-gift-invites/mine')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Group gifts you have been asked to chip in on' })
  myInvites(@CurrentUser('id') userId: string): Promise<GroupGiftInviteView[]> {
    return this.invites.listMine(userId);
  }

  @Get('group-gift-invites/:inviteId')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'One invitation, with the gift behind it',
    description:
      'Authorised by the invitation rather than by wishlist access: the invitee is not a ' +
      'participant yet and may not be able to see the list the group hangs off, but must ' +
      'still see what they are being asked to fund.',
  })
  inviteDetail(
    @CurrentUser('id') userId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<GroupGiftInviteDetailView> {
    return this.invites.detail(inviteId, userId);
  }

  @Post('group-gift-invites/:inviteId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Joins the group and grants the gifting access joining needs, which a ' +
      'share link alone could not do on a private wishlist.',
  })
  acceptInvite(
    @CurrentUser('id') userId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<GroupGiftInviteView> {
    return this.invites.respond(inviteId, userId, true);
  }

  @Post('group-gift-invites/:inviteId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Decline an invitation' })
  declineInvite(
    @CurrentUser('id') userId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<GroupGiftInviteView> {
    return this.invites.respond(inviteId, userId, false);
  }

  @Post('group-gifts/:id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Configure the public share link (initiator only)' })
  share(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ShareGroupGiftDto,
  ): Promise<GroupGiftShareView> {
    return this.groupGifts.configureShare(id, userId, dto);
  }
}
