import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateReportDto } from './dto/admin.dto';
import { ModerationService } from './moderation.service';

/** Reporting is abuse-prone; bound how fast one account can file. */
const REPORT_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * The user-facing intake for the moderation queue. Authenticated (the normal
 * user guard), so a report always has a reporter, and deduped downstream so a
 * user cannot spam the queue for the same target.
 */
@ApiTags('moderation')
@Controller('reports')
@ApiBearerAuth()
export class ReportsController {
  constructor(private readonly moderation: ModerationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle(REPORT_THROTTLE)
  @ApiOperation({ summary: 'Report content or a user for review' })
  async report(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReportDto,
  ): Promise<{ id: string; status: string }> {
    const report = await this.moderation.report(userId, {
      targetType: dto.targetType,
      targetId: dto.targetId,
      reason: dto.reason,
      detail: dto.detail,
    });
    return { id: report._id.toString(), status: report.status };
  }
}
