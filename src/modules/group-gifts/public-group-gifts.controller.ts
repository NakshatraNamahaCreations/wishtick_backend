import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import type { OpenGraphPreview } from 'src/modules/wishlists/wishlist.views';
import { PublicGroupGiftQueryDto } from './dto/group-gift.dto';
import { GroupGiftService } from './group-gift.service';
import type { PublicGroupGiftView } from './group-gift.views';

/** Unauthenticated; the bucket also bounds a passcode-guessing loop on a known link. */
const PUBLIC_SHARE_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

/**
 * OptionalJwtAuthGuard rather than bare `@Public()`: the link works for
 * anybody, but who is looking decides what it shows — progress only when
 * signed out, the group when signed in, and nothing at all to the person it
 * is still a surprise for. See [GroupGiftService.getPublicBySlug].
 */
@ApiTags('public')
@Controller('public/group-gifts')
@Public()
@UseGuards(OptionalJwtAuthGuard)
export class PublicGroupGiftsController {
  constructor(private readonly groupGifts: GroupGiftService) {}

  @Get(':slug')
  @Throttle(PUBLIC_SHARE_THROTTLE)
  @ApiOperation({
    summary: 'Open a shared group gift without an account',
    description:
      'Redacted: progress, participants, and the timeline only — no owner details, and anonymous ' +
      'contributors never appear by name. Signed out: progress alone (`signInToSee: true`, no ' +
      'participants, no timeline). The person it is still a surprise for gets 404.',
  })
  @ApiResponseDoc({ status: 404, description: 'SHARE_LINK_INVALID — also to its recipient' })
  @ApiResponseDoc({ status: 401, description: 'SHARE_PASSCODE_REQUIRED' })
  @ApiResponseDoc({ status: 403, description: 'SHARE_PASSCODE_INVALID' })
  @ApiResponseDoc({ status: 410, description: 'SHARE_LINK_EXPIRED' })
  getBySlug(
    @Param('slug') slug: string,
    @Query() query: PublicGroupGiftQueryDto,
    @Req() req: Request & { user?: AuthenticatedUser },
  ): Promise<PublicGroupGiftView> {
    return this.groupGifts.getPublicBySlug(slug, query.passcode, req.user?.id);
  }

  @Get(':slug/preview')
  @Throttle(PUBLIC_SHARE_THROTTLE)
  @ApiOperation({
    summary: 'Open Graph metadata (progress-bar share card)',
    description: 'Rendered into the chat by the unfurler; the card reflects current progress.',
  })
  getPreview(
    @Param('slug') slug: string,
    @Query() query: PublicGroupGiftQueryDto,
  ): Promise<OpenGraphPreview> {
    return this.groupGifts.getPublicPreview(slug, query.passcode);
  }
}
