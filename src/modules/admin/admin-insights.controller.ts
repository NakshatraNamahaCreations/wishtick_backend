import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AdminInsightsService } from './admin-insights.service';
import { RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission } from './admin.types';
import { AnalyticsRangeDto, RawEventsQueryDto, RetentionQueryDto } from './dto/admin.dto';

const day = (offset = 0): string =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** The range a read covers: the last 30 days unless told otherwise. */
const rangeOf = (q: AnalyticsRangeDto): [string, string] => [q.from ?? day(30), q.to ?? day()];

/**
 * The analytics desk's deeper reads, beside the overview, acquisition and
 * engagement routes on AdminController: funnel, retention, gifting, group
 * gifts, events, notifications, search, and the raw event stream.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/analytics')
@Public()
@UseGuards(AdminGuard)
@RequirePermission(AdminPermission.ANALYTICS_VIEW)
export class AdminInsightsController {
  constructor(private readonly insights: AdminInsightsService) {}

  @Get('funnel')
  @ApiOperation({ summary: 'Signup → onboarding → wishlist → item → shared, for a signup range' })
  funnel(@Query() q: AnalyticsRangeDto): Promise<unknown> {
    return this.insights.funnel(...rangeOf(q));
  }

  @Get('retention')
  @ApiOperation({ summary: 'Weekly signup cohorts and who came back (D1/D7/D30, by week)' })
  retention(@Query() q: RetentionQueryDto): Promise<unknown> {
    return this.insights.retention(q.weeks ?? 8);
  }

  @Get('gifting')
  @ApiOperation({ summary: 'Reservations in a range: bought, expired, time to buy' })
  gifting(@Query() q: AnalyticsRangeDto): Promise<unknown> {
    return this.insights.gifting(...rangeOf(q));
  }

  @Get('group-gifts')
  @ApiOperation({ summary: 'Group gifts started in a range: funded rate, contributors' })
  groupGifts(@Query() q: AnalyticsRangeDto): Promise<unknown> {
    return this.insights.groupGifts(...rangeOf(q));
  }

  @Get('events')
  @ApiOperation({ summary: 'Events created in a range: invites and replies' })
  events(@Query() q: AnalyticsRangeDto): Promise<unknown> {
    return this.insights.events(...rangeOf(q));
  }

  @Get('notifications')
  @ApiOperation({ summary: 'Delivery outcomes by channel over a range' })
  notifications(@Query() q: AnalyticsRangeDto): Promise<unknown> {
    return this.insights.notifications(...rangeOf(q));
  }

  @Get('search')
  @ApiOperation({ summary: 'Product searches per day: from cache, empty, store tabs, paid calls' })
  search(@Query() q: AnalyticsRangeDto): Promise<unknown> {
    return this.insights.search(...rangeOf(q));
  }

  @Get('raw/names')
  @ApiOperation({ summary: 'The event names in the raw stream' })
  names(): Promise<string[]> {
    return this.insights.eventNames();
  }

  @Get('raw')
  @ApiOperation({ summary: 'The raw analytics event stream, newest first' })
  raw(@Query() q: RawEventsQueryDto): Promise<unknown> {
    return this.insights.rawEvents(q);
  }
}
