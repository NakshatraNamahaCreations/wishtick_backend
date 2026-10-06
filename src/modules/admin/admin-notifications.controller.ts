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
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { NotificationChannel } from 'src/modules/notifications/notification.types';
import {
  AdminNotificationsService,
  NOTIFICATION_KINDS,
  type NotificationKind,
} from './admin-notifications.service';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import {
  AdminReasonDto,
  BroadcastDryRunDto,
  BroadcastDto,
  NotificationListQueryDto,
  OverviewQueryDto,
  PageQueryDto,
  PreviewNotificationDto,
  TestSendDto,
  UnsuppressDto,
} from './dto/admin.dto';

function kindOf(kind: string): NotificationKind {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) {
    throw new AppException(ErrorCode.NOT_FOUND, 'No such notification area', 404);
  }
  return kind as NotificationKind;
}

/**
 * The notifications centre: deliveries and devices, how sending is going,
 * suppressed addresses, every notification's wording, test sends and
 * announcements.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/notifications')
@Public()
@UseGuards(AdminGuard)
export class AdminNotificationsController {
  constructor(private readonly centre: AdminNotificationsService) {}

  // Fixed paths first, so none is read as a list.

  @Get('overview')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @ApiOperation({ summary: 'Outcomes by channel, failures by type and day' })
  overview(@Query() q: OverviewQueryDto): Promise<unknown> {
    return this.centre.overview(q.days ?? 30);
  }

  @Get('suppressions')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @ApiOperation({ summary: 'Addresses that bounced or complained (masked without sensitive:view)' })
  suppressions(@CurrentAdmin() actor: AuthenticatedAdmin): Promise<unknown> {
    return this.centre.suppressions(actor);
  }

  @Post('suppressions/remove')
  @RequirePermission(AdminPermission.NOTIFICATIONS_SEND)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Let an address receive again (reason required, audited)' })
  unsuppress(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: UnsuppressDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.centre.unsuppress(
      dto.channel as NotificationChannel,
      dto.address,
      dto.reason,
      actor,
      ip ?? null,
    );
  }

  @Get('templates')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @ApiOperation({ summary: 'Every notification: channels, priority, category' })
  templates(): unknown {
    return this.centre.templates();
  }

  @Post('templates/:type/preview')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One notification rendered: subject, text, SMS and email HTML' })
  preview(@Param('type') type: string, @Body() dto: PreviewNotificationDto): Promise<unknown> {
    return this.centre.preview(type, dto.payload ?? {});
  }

  @Post('test')
  @RequirePermission(AdminPermission.NOTIFICATIONS_SEND)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send one notification to one person now (audited)' })
  test(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: TestSendDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.centre.testSend(dto.type, dto.userId, dto.payload ?? {}, actor, ip ?? null);
  }

  @Get('broadcasts')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @ApiOperation({ summary: 'Announcements sent, newest first' })
  broadcasts(@Query() q: PageQueryDto): Promise<unknown> {
    return this.centre.broadcasts(q.page, q.limit);
  }

  @Post('broadcasts/dry-run')
  @RequirePermission(AdminPermission.NOTIFICATIONS_SEND)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'How many people an audience reaches — nothing is sent' })
  dryRun(@Body() dto: BroadcastDryRunDto): Promise<unknown> {
    return this.centre.dryRun(dto.audience);
  }

  @Post('broadcasts/image')
  @RequirePermission(AdminPermission.NOTIFICATIONS_SEND)
  @ApiOperation({
    summary: 'Upload a picture for an announcement — the raw JPG, PNG or WebP bytes, up to 1 MB',
  })
  image(@CurrentAdmin() actor: AuthenticatedAdmin, @Req() req: Request): Promise<unknown> {
    return this.centre.uploadBroadcastImage(req.body as Buffer, actor);
  }

  @Post('broadcasts')
  @RequirePermission(AdminPermission.NOTIFICATIONS_SEND)
  @ApiOperation({ summary: 'Send an announcement to an audience (queued in batches, audited)' })
  broadcast(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: BroadcastDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.centre.broadcast(dto, actor, ip ?? null);
  }

  @Get(':kind')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @ApiOperation({ summary: 'Deliveries or devices, filtered and paged' })
  list(@Param('kind') kind: string, @Query() q: NotificationListQueryDto): Promise<unknown> {
    return this.centre.list(kindOf(kind), q);
  }

  @Get(':kind/export')
  @RequirePermission(AdminPermission.EXPORT_DATA)
  @ApiOperation({ summary: 'Deliveries or devices as CSV (audited)' })
  async export(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Query() q: NotificationListQueryDto,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    if (!actor.permissions.includes(AdminPermission.NOTIFICATIONS_VIEW)) {
      throw new AppException(ErrorCode.ADMIN_FORBIDDEN, 'Exporting needs notifications:view', 403);
    }
    const k = kindOf(kind);
    const csv = await this.centre.exportCsv(k, q, actor, ip ?? null);
    return new StreamableFile(Buffer.from(`\uFEFF${csv}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="wishtick-${k}.csv"`,
    });
  }

  @Get(':kind/:id')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @ApiOperation({ summary: 'One delivery or device' })
  detail(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ): Promise<unknown> {
    return this.centre.detail(kindOf(kind), id, actor);
  }

  @Get(':kind/:id/sections/:key')
  @RequirePermission(AdminPermission.NOTIFICATIONS_VIEW)
  @ApiOperation({ summary: 'One more page of a section' })
  section(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('key') key: string,
    @Query() q: PageQueryDto,
  ): Promise<unknown> {
    return this.centre.section(kindOf(kind), id, key, q.page ?? 1);
  }

  @Post(':kind/:id/actions/:action')
  @RequirePermission(AdminPermission.NOTIFICATIONS_SEND)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop pushing to a device (reason required, audited)' })
  act(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.centre.act(kindOf(kind), id, action, dto.reason, actor, ip ?? null);
  }
}
