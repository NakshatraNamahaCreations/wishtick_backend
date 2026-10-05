import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AdminOpsService, type JobState } from './admin-ops.service';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AdminReasonDto, JobListQueryDto, PauseQueueDto } from './dto/admin.dto';

/** The operations desk: queues, health, product search, caches, migrations, settings. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/ops')
@Public()
@UseGuards(AdminGuard)
export class AdminOpsController {
  constructor(private readonly ops: AdminOpsService) {}

  @Get('queues')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: 'Every queue: job counts by state, paused or not' })
  queues(): Promise<unknown> {
    return this.ops.queues();
  }

  @Get('queues/:name')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: "One queue's jobs in a state, and its repeating schedules" })
  queue(@Param('name') name: string, @Query() q: JobListQueryDto): Promise<unknown> {
    return this.ops.queueDetail(name, (q.state ?? 'failed') as JobState, q.page ?? 1);
  }

  @Post('queues/:name/pause')
  @RequirePermission(AdminPermission.OPS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause or resume a queue (reason required, audited)' })
  pause(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('name') name: string,
    @Body() dto: PauseQueueDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.ops.setPaused(name, dto.paused, dto.reason, actor, ip ?? null);
  }

  @Post('queues/:name/retry-failed')
  @RequirePermission(AdminPermission.OPS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry every failed job in a queue (audited)' })
  retryFailed(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('name') name: string,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.ops.retryAllFailed(name, actor, ip ?? null);
  }

  @Post('queues/:name/jobs/:id/retry')
  @RequirePermission(AdminPermission.OPS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry one failed job (audited)' })
  retry(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('name') name: string,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.ops.retryJob(name, id, actor, ip ?? null);
  }

  @Post('queues/:name/jobs/:id/remove')
  @RequirePermission(AdminPermission.OPS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove one job that is not running (audited)' })
  remove(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('name') name: string,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.ops.removeJob(name, id, actor, ip ?? null);
  }

  @Get('health')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: 'Database, Redis and queues answering, and this process' })
  health(): Promise<unknown> {
    return this.ops.health();
  }

  @Get('product-search')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: 'Vendor requests, plan left, breaker, cache hit rate' })
  productSearch(): Promise<unknown> {
    return this.ops.productSearch();
  }

  @Post('product-search/reset-breaker')
  @RequirePermission(AdminPermission.OPS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close the product search breaker on this server (audited)' })
  resetBreaker(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.ops.resetBreaker(actor, ip ?? null, dto.reason);
  }

  @Get('product-search/budget/:userId')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: "One person's product searches today against their budget" })
  budget(@Param('userId') userId: string): Promise<unknown> {
    return this.ops.budgetOf(userId);
  }

  @Get('caches')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: 'Caches that can be cleared' })
  caches(): unknown {
    return this.ops.caches();
  }

  @Post('caches/:key/clear')
  @RequirePermission(AdminPermission.OPS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear one cache (reason required, audited)' })
  clear(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('key') key: string,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.ops.clearCache(key, dto.reason, actor, ip ?? null);
  }

  @Get('migrations')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: 'Every migration, and whether it has run' })
  migrations(): Promise<unknown> {
    return this.ops.migrations();
  }

  @Get('settings')
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: 'The settings the server runs with (no secrets)' })
  settings(): unknown {
    return this.ops.settings();
  }
}
