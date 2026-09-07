import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary } from './dashboard.types';

@ApiTags('dashboard')
@Controller('dashboard')
@ApiBearerAuth()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Counts and badges for every dashboard section',
    description:
      'One aggregation, cached 60s per user. Sections whose sprint has not shipped report ' +
      '`available: false` — render those as coming-soon, not as an empty state.',
  })
  getSummary(@CurrentUser('id') userId: string): Promise<DashboardSummary> {
    return this.dashboard.getSummary(userId);
  }
}
