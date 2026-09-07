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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import {
  AddMemoryWishDto,
  CreateMemoryDto,
  SendMemoryReplyDto,
  UpdateMemoryDto,
} from './dto/memory.dto';
import { MemoriesService } from './memories.service';
import { MemoryRepliesService } from './memory-replies.service';
import { MemoryWishesService } from './memory-wishes.service';
import type {
  MemoryCapsuleView,
  MemoryReplyView,
  MemoryWishView,
  PublicMemoryView,
  ReplyAudienceEntry,
} from './memory.views';

@ApiTags('memories')
@Controller('memories')
@ApiBearerAuth()
export class MemoriesController {
  constructor(
    private readonly memories: MemoriesService,
    private readonly wishes: MemoryWishesService,
    private readonly replies: MemoryRepliesService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a time-locked memory capsule (`4104:1539`)' })
  @ApiResponseDoc({ status: 400, description: 'VALIDATION_FAILED — unlockAt must be ahead' })
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateMemoryDto,
  ): Promise<MemoryCapsuleView> {
    return this.memories.create(userId, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: '"Created By You" (`4104:1433`)' })
  listMine(@CurrentUser('id') userId: string): Promise<MemoryCapsuleView[]> {
    return this.memories.listMine(userId);
  }

  @Get('for-me')
  @ApiOperation({
    summary: '"For You" — unlocked capsules somebody made about the caller',
  })
  listForMe(@CurrentUser('id') userId: string): Promise<MemoryCapsuleView[]> {
    return this.memories.listForMe(userId);
  }

  /**
   * Declared before `:id` — Nest matches in declaration order, and the other
   * way round this reads as a request for the capsule called "reply-audience".
   */
  @Get('reply-audience')
  @ApiOperation({
    summary: 'Everyone who has sent you a memory, and may therefore be replied to',
    description:
      'The host and every named contributor of each of your opened capsules. This is the ' +
      'only source of a legal addressee: a reply may not be sent to anyone absent from it, ' +
      'so it cannot be turned into a way to message an arbitrary account. Sealed capsules ' +
      'are excluded — naming their contributors would give the surprise away.',
  })
  replyAudience(@CurrentUser('id') userId: string): Promise<ReplyAudienceEntry[]> {
    return this.replies.audience(userId);
  }

  @Post('replies')
  @ApiOperation({
    summary: 'Reply to the people who filled your memories — one reply, many recipients',
    description:
      'Ids absent from your reply audience are dropped rather than refused, so a slightly ' +
      'stale client is not blocked; only an empty result is an error.',
  })
  @ApiResponseDoc({ status: 403, description: 'MEMORY_REPLY_NO_AUDIENCE' })
  @ApiResponseDoc({ status: 400, description: 'MEMORY_WISH_MEDIA_REQUIRED / _TEXT_REQUIRED' })
  sendReply(
    @CurrentUser('id') userId: string,
    @Body() dto: SendMemoryReplyDto,
  ): Promise<MemoryReplyView> {
    return this.replies.send(userId, dto);
  }

  @Delete('replies/:replyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw a reply you sent. It vanishes for every recipient.' })
  @ApiResponseDoc({ status: 404, description: 'MEMORY_REPLY_NOT_FOUND' })
  removeReply(@CurrentUser('id') userId: string, @Param('replyId') replyId: string): Promise<void> {
    return this.replies.remove(replyId, userId);
  }

  @Get('contributed')
  @ApiOperation({ summary: '"Contributed By You" (`4104:1433`)' })
  listContributed(@CurrentUser('id') userId: string): Promise<MemoryCapsuleView[]> {
    return this.memories.listContributed(userId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One capsule — metadata only until it opens, then its wishes',
  })
  get(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<MemoryCapsuleView> {
    return this.memories.getOne(id, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a sealed capsule (host). Moving unlockAt reschedules the job.' })
  @ApiResponseDoc({ status: 409, description: 'INVALID_MEMORY_TRANSITION — already open' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMemoryDto,
  ): Promise<MemoryCapsuleView> {
    return this.memories.update(id, userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a capsule and every wish in it (host)' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<void> {
    return this.memories.remove(id, userId);
  }

  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open it now, ahead of its instant (host)' })
  unlock(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<MemoryCapsuleView> {
    return this.memories.unlockNow(id, userId);
  }

  // ── Wishes ────────────────────────────────────────────────────────────────

  @Post(':id/wishes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a photo, text, audio or video wish' })
  @ApiResponseDoc({ status: 400, description: 'MEMORY_WISH_MEDIA_REQUIRED / _TEXT_REQUIRED' })
  @ApiResponseDoc({ status: 409, description: 'MEMORY_NOT_ACCEPTING_WISHES' })
  addWish(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AddMemoryWishDto,
  ): Promise<MemoryWishView> {
    return this.wishes.add(id, userId, dto);
  }

  @Get(':id/wishes')
  @ApiOperation({ summary: 'The wishes inside — 409 while the capsule is still sealed' })
  @ApiResponseDoc({ status: 409, description: 'MEMORY_LOCKED' })
  listWishes(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<MemoryWishView[]> {
    return this.wishes.list(id, userId);
  }

  @Get(':id/wishes/mine')
  @ApiOperation({
    summary: 'Your own wishes on this capsule — readable even while it is sealed',
    description:
      'Showing somebody their own message reveals nothing about anyone else, so this ' +
      'is not subject to the time-lock. It is what replaced opening a capsule early.',
  })
  listMyWishes(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<MemoryWishView[]> {
    return this.wishes.listMine(id, userId);
  }

  @Get(':id/replies')
  @ApiOperation({
    summary: 'What the recipient sent back, on this memory',
    description:
      'Visible to a viewer who was addressed by the reply AND had a part in this capsule, ' +
      'or to the author of the reply. That pairing is what stops a reply addressed across ' +
      'several memories from telling one host that the others exist.',
  })
  listReplies(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<MemoryReplyView[]> {
    return this.replies.listForCapsule(id, userId);
  }

  @Delete(':id/wishes/:wishId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw your own wish, or any wish if you are the host' })
  removeWish(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('wishId') wishId: string,
  ): Promise<void> {
    return this.wishes.remove(id, wishId, userId);
  }

  @Post(':id/wishes/:wishId/react')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '"React" on the story viewer (`2078:357`)' })
  react(
    @Param('id') id: string,
    @Param('wishId') wishId: string,
  ): Promise<{ reactionCount: number }> {
    return this.wishes.react(id, wishId);
  }
}

@ApiTags('memories')
@Controller('public/memories')
export class PublicMemoriesController {
  constructor(private readonly memories: MemoriesService) {}

  @Get(':slug')
  @Public()
  @ApiOperation({
    summary: 'What a contribute link resolves to',
    description:
      'Never carries wish content, in any status — this surface exists so someone can add a ' +
      'wish, and the recipient may well be holding the phone.',
  })
  @ApiResponseDoc({ status: 404, description: 'MEMORY_NOT_FOUND' })
  get(@Param('slug') slug: string): Promise<PublicMemoryView> {
    return this.memories.getBySlug(slug);
  }
}
