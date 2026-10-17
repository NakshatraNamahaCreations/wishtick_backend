import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AdminInsightsService } from './admin-insights.service';
import { RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission } from './admin.types';
import {
  AnalyticsPeopleQueryDto,
  AnalyticsRangeDto,
  RetentionQueryDto,
  SearchLogQueryDto,
} from './dto/admin.dto';

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

  // Not `analytics/searches`, nor `analytics/events` below: ad blockers' privacy
  // lists (EasyPrivacy) block both as trackers, and the panel's box just fails.
  @Get('search-activity')
  @ApiOperation({ summary: 'What people searched for: totals, top searches, top searchers' })
  searches(@Query() q: AnalyticsRangeDto): Promise<unknown> {
    return this.insights.searchActivity(...rangeOf(q));
  }

  @Get('search-activity/log')
  @ApiOperation({ summary: 'Every search typed, newest first, by words, person or source' })
  searchLog(@Query() q: SearchLogQueryDto): Promise<unknown> {
    return this.insights.searchLog(q);
  }

  @Get('people')
  @ApiOperation({
    summary: 'The people a number counts — a funnel step, a retention figure, an outcome',
  })
  people(@Query() q: AnalyticsPeopleQueryDto): Promise<unknown> {
    return this.insights.people(q);
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

  // `occasions`, not `events`: EasyPrivacy blocks `/analytics/event…` — see above.
  @Get('occasions')
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
}
