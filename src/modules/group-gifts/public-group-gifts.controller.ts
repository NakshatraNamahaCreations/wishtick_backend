import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import type { OpenGraphPreview } from 'src/modules/wishlists/wishlist.views';
import { PublicGroupGiftQueryDto } from './dto/group-gift.dto';
import { GroupGiftService } from './group-gift.service';
import type { PublicGroupGiftView } from './group-gift.views';

/** Unauthenticated; the bucket also bounds a passcode-guessing loop on a known link. */
const PUBLIC_SHARE_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('public')
@Controller('public/group-gifts')
@Public()
export class PublicGroupGiftsController {
  constructor(private readonly groupGifts: GroupGiftService) {}

  @Get(':slug')
  @Throttle(PUBLIC_SHARE_THROTTLE)
  @ApiOperation({
    summary: 'Open a shared group gift without an account',
    description:
      'Redacted: progress, participants, and the timeline only — no owner details, and anonymous ' +
      'contributors never appear by name.',
  })
  @ApiResponseDoc({ status: 404, description: 'SHARE_LINK_INVALID' })
  @ApiResponseDoc({ status: 401, description: 'SHARE_PASSCODE_REQUIRED' })
  @ApiResponseDoc({ status: 403, description: 'SHARE_PASSCODE_INVALID' })
  @ApiResponseDoc({ status: 410, description: 'SHARE_LINK_EXPIRED' })
  getBySlug(
    @Param('slug') slug: string,
    @Query() query: PublicGroupGiftQueryDto,
  ): Promise<PublicGroupGiftView> {
    return this.groupGifts.getPublicBySlug(slug, query.passcode);
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
