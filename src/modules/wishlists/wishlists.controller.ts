import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import {
  AddParticipantDto,
  CreateItemDto,
  CreateWishlistDto,
  ListItemsQueryDto,
  ReorderItemsDto,
  ShareWishlistDto,
  UpdateItemDto,
  UpdateWishlistDto,
} from './dto/wishlist.dto';
import { ItemsService } from './items.service';
import { ParticipantsService, type ParticipantView } from './participants.service';
import { WishlistsService } from './wishlists.service';
import type { ItemView, WishlistView } from './wishlist.views';

@ApiTags('wishlists')
@Controller('wishlists')
@ApiBearerAuth()
export class WishlistsController {
  constructor(
    private readonly wishlists: WishlistsService,
    private readonly items: ItemsService,
    private readonly participants: ParticipantsService,
  ) {}

  // ── Wishlists ─────────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create a wishlist' })
  @ApiResponseDoc({ status: 409, description: 'WISHLIST_LIMIT_REACHED' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateWishlistDto): Promise<WishlistView> {
    return this.wishlists.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Wishlists you own' })
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  listMine(
    @CurrentUser('id') userId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<WishlistView[]> {
    return this.wishlists.listMine(userId, includeArchived === 'true');
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'Wishlists others have shared with you' })
  listShared(@CurrentUser('id') userId: string): Promise<WishlistView[]> {
    return this.wishlists.listSharedWithMe(userId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One wishlist',
    description: 'Returns 404 — never 403 — when you may not see it, so existence is not leaked.',
  })
  @ApiResponseDoc({ status: 404, description: 'WISHLIST_NOT_FOUND' })
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<WishlistView> {
    return this.wishlists.getOne(id, { userId });
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a wishlist',
    description:
      'Opening a private list (private/event_only → public/invite_only) rotates the share slug, ' +
      'so links handed out while it was closed stop working.',
  })
  @ApiResponseDoc({ status: 403, description: 'FORBIDDEN — owner only' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWishlistDto,
  ): Promise<WishlistView> {
    return this.wishlists.update(id, { userId }, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a wishlist',
    description: 'Archived, not deleted — gifts and chats reference it. Also kills the share link.',
  })
  archive(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<{ archivedAt: Date }> {
    return this.wishlists.archive(id, { userId });
  }

  @Post(':id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Configure the share link (rotate, passcode, expiry)' })
  configureShare(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ShareWishlistDto,
  ): Promise<NonNullable<WishlistView['share']>> {
    return this.wishlists.configureShare(id, { userId }, dto);
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  @Get(':id/items')
  @ApiOperation({ summary: 'Items in a wishlist' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false, type: Number })
  listItems(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ListItemsQueryDto,
  ): Promise<ItemView[]> {
    return this.items.list(id, { userId }, query);
  }

  @Post(':id/items')
  @ApiOperation({ summary: 'Add an item' })
  createItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: CreateItemDto,
  ): Promise<ItemView> {
    return this.items.create(id, { userId }, dto);
  }

  /**
   * Declared before ':itemId' — Nest matches routes in declaration order, so
   * 'reorder' would otherwise be swallowed as an item id.
   */
  @Patch(':id/items/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reorder items',
    description: 'Send every active item id exactly once. Applied atomically.',
  })
  @ApiResponseDoc({ status: 400, description: 'VALIDATION_FAILED — not a permutation' })
  reorder(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ReorderItemsDto,
  ): Promise<ItemView[]> {
    return this.items.reorder(id, { userId }, dto.itemIds);
  }

  @Get(':id/items/:itemId')
  @ApiOperation({ summary: 'One item' })
  getItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ): Promise<ItemView> {
    return this.items.getOne(id, itemId, { userId });
  }

  @Patch(':id/items/:itemId')
  @ApiOperation({
    summary: 'Update an item',
    description:
      'Substantive fields freeze once someone has claimed the item, so a gifter is not stranded.',
  })
  @ApiResponseDoc({ status: 409, description: 'WISHLIST_ITEM_LOCKED' })
  updateItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateItemDto,
  ): Promise<ItemView> {
    return this.items.update(id, itemId, { userId }, dto);
  }

  @Delete(':id/items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an item' })
  @ApiResponseDoc({ status: 409, description: 'WISHLIST_ITEM_LOCKED' })
  async removeItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    await this.items.remove(id, itemId, { userId });
  }

  // ── Participants ──────────────────────────────────────────────────────────

  @Get(':id/participants')
  @ApiOperation({ summary: 'Who has access (owner only)' })
  listParticipants(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<ParticipantView[]> {
    return this.participants.list(id, { userId });
  }

  @Post(':id/participants')
  @ApiOperation({ summary: 'Give someone access, by user id or email' })
  @ApiResponseDoc({ status: 409, description: 'PARTICIPANT_ALREADY_EXISTS / CANNOT_INVITE_OWNER' })
  addParticipant(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AddParticipantDto,
  ): Promise<ParticipantView> {
    return this.participants.add(id, { userId }, dto);
  }

  @Delete(':id/participants/:participantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke access',
    description: 'Takes effect on their next request — no permission caching.',
  })
  async revokeParticipant(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('participantId') participantId: string,
  ): Promise<void> {
    await this.participants.revoke(id, participantId, { userId });
  }
}
