import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { SearchPeopleQueryDto, SetUsernameDto } from './dto/wishmates.dto';
import { WishmatesService } from './wishmates.service';
import type {
  WishLinkView,
  WishmateProfileView,
  WishmateRelationship,
  WishmateView,
} from './wishmates.views';

/**
 * WishMates — the connection graph (`4177:138`, `4177:77`, `4177:111`,
 * `4177:42`, `4177:217`, `4177:267`).
 *
 * A "WishLink" is one request; a "WishMate" is an accepted one. The split
 * between the two tabs is direction, not state: both are pending rows, seen
 * from opposite ends.
 */
@ApiTags('wishmates')
@Controller()
@ApiBearerAuth()
export class WishmatesController {
  constructor(private readonly wishmates: WishmatesService) {}

  // ── Handles ───────────────────────────────────────────────────────────────

  @Post('me/username')
  @ApiOperation({ summary: 'Claim or change your @handle' })
  @ApiResponseDoc({ status: 409, description: 'USERNAME_TAKEN' })
  @ApiResponseDoc({ status: 400, description: 'USERNAME_INVALID' })
  setUsername(
    @CurrentUser('id') userId: string,
    @Body() dto: SetUsernameDto,
  ): Promise<WishmateView> {
    return this.wishmates.setUsername(userId, dto.username);
  }

  @Get('usernames/:username/available')
  @ApiOperation({ summary: 'Whether a handle can be claimed' })
  async available(@Param('username') username: string): Promise<{ available: boolean }> {
    return { available: await this.wishmates.isUsernameAvailable(username) };
  }

  // ── Finding people ────────────────────────────────────────────────────────

  @Get('people/search')
  @ApiOperation({
    summary: 'Find people by handle or name',
    description: 'Only accounts that have claimed a handle are discoverable.',
  })
  search(
    @CurrentUser('id') userId: string,
    @Query() query: SearchPeopleQueryDto,
  ): Promise<WishmateView[]> {
    return this.wishmates.search(userId, query.q, query.limit ?? 20);
  }

  @Get('people/suggestions')
  @ApiOperation({ summary: 'People You May Know — ranked by shared WishMates' })
  suggestions(@CurrentUser('id') userId: string): Promise<WishmateView[]> {
    return this.wishmates.suggestions(userId);
  }

  @Get('people/:userId')
  @ApiOperation({ summary: 'Someone’s public profile, with your relationship to them' })
  profile(
    @CurrentUser('id') viewerId: string,
    @Param('userId') targetId: string,
  ): Promise<WishmateProfileView> {
    return this.wishmates.profileOf(viewerId, targetId);
  }

  // ── The graph ─────────────────────────────────────────────────────────────

  @Get('wishmates')
  @ApiOperation({ summary: 'My WishMates' })
  list(@CurrentUser('id') userId: string): Promise<WishmateView[]> {
    return this.wishmates.listMates(userId);
  }

  @Get('wishmates/pending-count')
  @ApiOperation({ summary: 'How many requests are waiting — the list screen’s banner' })
  async pendingCount(@CurrentUser('id') userId: string): Promise<{ count: number }> {
    return { count: await this.wishmates.pendingCount(userId) };
  }

  @Get('wishlinks/received')
  @ApiOperation({ summary: 'Requests sent to me' })
  received(@CurrentUser('id') userId: string): Promise<WishLinkView[]> {
    return this.wishmates.listReceived(userId);
  }

  @Get('wishlinks/sent')
  @ApiOperation({ summary: 'Requests I sent, still waiting' })
  sent(@CurrentUser('id') userId: string): Promise<WishLinkView[]> {
    return this.wishmates.listSent(userId);
  }

  @Post('people/:userId/request')
  @ApiOperation({
    summary: 'Send a WishLink request',
    description: 'Accepts instead when that person has already asked you — asking back is consent.',
  })
  @ApiResponseDoc({ status: 400, description: 'WISHMATE_SELF' })
  async request(
    @CurrentUser('id') viewerId: string,
    @Param('userId') targetId: string,
  ): Promise<{ relationship: WishmateRelationship }> {
    return { relationship: await this.wishmates.request(viewerId, targetId) };
  }

  @Post('wishlinks/:linkId/accept')
  @ApiOperation({ summary: 'Accept a request addressed to me' })
  @ApiResponseDoc({ status: 404, description: 'WISHLINK_NOT_FOUND' })
  async accept(
    @CurrentUser('id') userId: string,
    @Param('linkId') linkId: string,
  ): Promise<{ relationship: WishmateRelationship }> {
    return { relationship: await this.wishmates.accept(userId, linkId) };
  }

  @Post('wishlinks/:linkId/decline')
  @ApiOperation({ summary: 'Decline a request addressed to me' })
  async decline(
    @CurrentUser('id') userId: string,
    @Param('linkId') linkId: string,
  ): Promise<{ relationship: WishmateRelationship }> {
    return { relationship: await this.wishmates.decline(userId, linkId) };
  }

  @Delete('wishlinks/:linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw a request I sent — the Sent tab’s Delete' })
  withdraw(@CurrentUser('id') userId: string, @Param('linkId') linkId: string): Promise<void> {
    return this.wishmates.withdraw(userId, linkId);
  }

  @Delete('wishmates/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a WishMate' })
  @ApiResponseDoc({ status: 404, description: 'NOT_WISHMATES' })
  remove(@CurrentUser('id') viewerId: string, @Param('userId') targetId: string): Promise<void> {
    return this.wishmates.remove(viewerId, targetId);
  }
}
