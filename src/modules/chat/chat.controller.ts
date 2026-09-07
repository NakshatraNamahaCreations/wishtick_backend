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
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { ChatService } from './chat.service';
import type { ChatView, MessageView } from './chat.views';
import {
  EditMessageDto,
  ListChatsQueryDto,
  ListMessagesQueryDto,
  PostMessageDto,
  ReactionDto,
  ReadDto,
} from './dto/chat.dto';

/** Posting is per-user rate-limited in the service too; this bounds scripted floods. */
const POST_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

@ApiTags('chat')
@Controller()
@ApiBearerAuth()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('chats')
  @ApiOperation({ summary: 'Your chats (the two dashboard sections), with unread counts' })
  listChats(
    @CurrentUser('id') userId: string,
    @Query() query: ListChatsQueryDto,
  ): Promise<ChatView[]> {
    return this.chat.listChats(userId, query.type);
  }

  @Get('wishlists/:wishlistId/chat')
  @ApiOperation({ summary: "A wishlist's chat, created on first access" })
  @ApiResponseDoc({ status: 403, description: 'CHAT_DISABLED' })
  wishlistChat(
    @CurrentUser('id') userId: string,
    @Param('wishlistId') wishlistId: string,
  ): Promise<ChatView> {
    return this.chat.resolveWishlistChat(wishlistId, userId);
  }

  @Post('chats/direct/:userId')
  @ApiOperation({
    summary: 'Open (or create) the direct thread with a WishMate',
    description: 'Idempotent — the same pair always resolves to the same thread.',
  })
  @ApiResponseDoc({ status: 403, description: 'NOT_WISHMATES' })
  async openDirect(
    @CurrentUser('id') userId: string,
    @Param('userId') otherId: string,
  ): Promise<{ chatId: string }> {
    const chat = await this.chat.openDirect(userId, otherId);
    return { chatId: chat._id.toString() };
  }

  @Get('chats/:id')
  @ApiOperation({ summary: 'One chat, with your unread count' })
  getChat(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<ChatView> {
    return this.chat.getChat(id, userId);
  }

  @Get('chats/:id/messages')
  @ApiOperation({
    summary: 'Message history (newest first), cursor-paginated',
    description: 'Pass `before` (a message id) to page back. Surprise messages are filtered here.',
  })
  listMessages(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<{ items: MessageView[]; nextCursor: string | null }> {
    return this.chat.listMessages(id, userId, query);
  }

  @Post('chats/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(POST_THROTTLE)
  @ApiOperation({ summary: 'Post a message (delivered to connected clients via message:new)' })
  @ApiResponseDoc({ status: 403, description: 'CANNOT_POST_IN_CHAT' })
  @ApiResponseDoc({ status: 429, description: 'CHAT_RATE_LIMITED' })
  postMessage(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: PostMessageDto,
  ): Promise<MessageView> {
    return this.chat.postMessage(id, userId, dto);
  }

  @Patch('messages/:messageId')
  @ApiOperation({ summary: 'Edit your message' })
  @ApiResponseDoc({ status: 403, description: 'NOT_THE_SENDER' })
  editMessage(
    @CurrentUser('id') userId: string,
    @Param('messageId') messageId: string,
    @Body() dto: EditMessageDto,
  ): Promise<MessageView> {
    return this.chat.editMessage(messageId, userId, dto);
  }

  @Delete('messages/:messageId')
  @ApiOperation({ summary: 'Delete your message (soft delete)' })
  deleteMessage(
    @CurrentUser('id') userId: string,
    @Param('messageId') messageId: string,
  ): Promise<MessageView> {
    return this.chat.deleteMessage(messageId, userId);
  }

  @Post('messages/:messageId/reactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle an emoji reaction on a message' })
  react(
    @CurrentUser('id') userId: string,
    @Param('messageId') messageId: string,
    @Body() dto: ReactionDto,
  ): Promise<MessageView> {
    return this.chat.react(messageId, userId, dto.emoji);
  }

  @Post('chats/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the chat read up to a message (default: latest)' })
  markRead(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ReadDto,
  ): Promise<{ unreadCount: number }> {
    return this.chat.markRead(id, userId, dto.messageId);
  }
}
