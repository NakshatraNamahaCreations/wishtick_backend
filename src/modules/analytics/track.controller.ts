import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { TrackDto } from 'src/modules/admin/dto/admin.dto';
import { AnalyticsService } from './analytics.service';

/** Analytics is high-volume; bound one client's batch rate. */
const TRACK_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

/**
 * Batched analytics ingestion. Authenticated so events carry a userId (the basis
 * of DAU/WAU/MAU); an anonymous client's `anonymousId` rides in the body for the
 * pre-signup case.
 */
@ApiTags('analytics')
@Controller('events')
@ApiBearerAuth()
export class TrackController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('track')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(TRACK_THROTTLE)
  @ApiOperation({ summary: 'Record a batch of analytics events' })
  track(@CurrentUser('id') userId: string, @Body() dto: TrackDto): Promise<{ accepted: number }> {
    return this.analytics.track(userId, dto.events);
  }
}
