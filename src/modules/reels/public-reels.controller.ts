import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { PublicReelQueryDto } from './dto/reel.dto';
import { ReelService } from './reel.service';
import type { PublicReelView } from './reel.views';

/** Bounds passcode-guessing against a known reel link. */
const PUBLIC_SHARE_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('public')
@Controller('public/reels')
@Public()
export class PublicReelsController {
  constructor(private readonly reels: ReelService) {}

  @Get(':slug')
  @Throttle(PUBLIC_SHARE_THROTTLE)
  @ApiOperation({ summary: 'A shared reel — the video only once released, else its progress' })
  getBySlug(
    @Param('slug') slug: string,
    @Query() query: PublicReelQueryDto,
  ): Promise<PublicReelView> {
    return this.reels.getPublicBySlug(slug, query.passcode);
  }

  @Get(':slug/preview')
  @Throttle(PUBLIC_SHARE_THROTTLE)
  @ApiOperation({ summary: 'OpenGraph metadata for the share card' })
  getPreview(@Param('slug') slug: string): Promise<{
    title: string;
    description: string;
    image: string | null;
    url: string;
  }> {
    return this.reels.getPublicPreview(slug);
  }
}
