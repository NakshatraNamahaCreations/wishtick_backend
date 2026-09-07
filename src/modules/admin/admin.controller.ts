import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AnalyticsService } from 'src/modules/analytics/analytics.service';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminService, type AdminView } from './admin.service';
import { AdminUsersService, type UserAdminView } from './admin-users.service';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';
import { ModerationService } from './moderation.service';
import {
  AnalyticsRangeDto,
  AuditQueryDto,
  CreateAdminDto,
  ListUsersQueryDto,
  ModerationActionDto,
  ModerationQueueQueryDto,
  ResetAdminPasswordDto,
  SuspendUserDto,
  UpdateAdminDto,
} from './dto/admin.dto';

const todayBucket = (): string => new Date().toISOString().slice(0, 10);
const daysAgoBucket = (n: number): string =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@Public() // Global user guard skips; AdminGuard is the sole gate on every route.
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admins: AdminService,
    private readonly users: AdminUsersService,
    private readonly moderation: ModerationService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  // ── Admin management (super admin) ──────────────────────────────────────────

  @Post('admins')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @ApiOperation({ summary: 'Create an admin' })
  async createAdmin(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: CreateAdminDto,
    @Ip() ip: string,
  ): Promise<AdminView> {
    const created = await this.admins.create(dto);
    await this.audit.record({
      actor,
      action: 'admin.create',
      targetType: 'admin',
      targetId: created._id.toString(),
      after: { email: created.email, roles: created.roles },
      ip: ip ?? null,
    });
    return AdminService.toView(created);
  }

  @Get('admins')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @ApiOperation({ summary: 'List admins' })
  async listAdmins(): Promise<AdminView[]> {
    return (await this.admins.list()).map((a) => AdminService.toView(a));
  }

  @Patch('admins/:id')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @ApiOperation({ summary: 'Update name, roles, status, or IP allowlist' })
  async updateAdmin(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: UpdateAdminDto,
    @Ip() ip: string,
  ): Promise<AdminView> {
    const before = await this.admins.snapshot(id);
    const updated = await this.admins.update(id, dto, actor);
    await this.audit.record({
      actor,
      action: 'admin.update',
      targetType: 'admin',
      targetId: id,
      before,
      after: AdminService.snapshotOf(updated),
      ip: ip ?? null,
    });
    return AdminService.toView(updated);
  }

  @Post('admins/:id/password')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password, ending every session that admin holds' })
  async resetAdminPassword(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: ResetAdminPasswordDto,
    @Ip() ip: string,
  ): Promise<AdminView> {
    const updated = await this.admins.resetPassword(id, dto.password);
    await this.audit.record({
      actor,
      action: 'admin.password_reset',
      targetType: 'admin',
      targetId: id,
      // The password itself is never recorded — only that it changed and that
      // every session was invalidated as a result.
      after: { sessionsInvalidated: true },
      ip: ip ?? null,
    });
    return AdminService.toView(updated);
  }

  // ── Users ────────────────────────────────────────────────────────────────────

  @Get('users')
  @RequirePermission(AdminPermission.USERS_VIEW)
  @ApiOperation({ summary: 'Search + list users' })
  listUsers(
    @Query() query: ListUsersQueryDto,
  ): Promise<{ items: UserAdminView[]; total: number; page: number; limit: number }> {
    return this.users.list(query);
  }

  @Get('users/:id')
  @RequirePermission(AdminPermission.USERS_VIEW)
  @ApiOperation({ summary: 'Full profile + counts + recent activity' })
  getUser(@Param('id') id: string): Promise<unknown> {
    return this.users.getDetail(id);
  }

  @Post('users/:id/suspend')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a user (kills sessions + live sockets)' })
  suspend(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
    @Ip() ip: string,
  ): Promise<UserAdminView> {
    return this.users.suspend(id, dto.reason, actor, ip ?? null);
  }

  @Post('users/:id/reactivate')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended user' })
  reactivate(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<UserAdminView> {
    return this.users.reactivate(id, actor, ip ?? null);
  }

  @Post('users/:id/force-logout')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invalidate every session + disconnect live sockets' })
  forceLogout(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<UserAdminView> {
    return this.users.forceLogout(id, actor, ip ?? null);
  }

  // ── Moderation ───────────────────────────────────────────────────────────────

  @Get('moderation/queue')
  @RequirePermission(AdminPermission.MODERATION_VIEW)
  @ApiOperation({ summary: 'The report queue, prioritized by severity then age' })
  moderationQueue(@Query() query: ModerationQueueQueryDto): Promise<unknown> {
    return this.moderation.queue({
      targetType: query.type,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('moderation/reports/:id/target')
  @RequirePermission(AdminPermission.MODERATION_VIEW)
  @ApiOperation({ summary: 'The reported content itself, normalized across types' })
  moderationTarget(@Param('id') id: string): Promise<unknown> {
    return this.moderation.resolveTarget(id);
  }

  @Post('moderation/reports/:id/act')
  @RequirePermission(AdminPermission.MODERATION_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'approve | remove | flag | escalate a report' })
  act(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: ModerationActionDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.moderation.act(id, dto.action, actor, ip ?? null, dto.reason ?? null);
  }

  // ── Analytics ────────────────────────────────────────────────────────────────

  @Get('analytics/overview')
  @RequirePermission(AdminPermission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Total users, DAU/WAU/MAU (from the rollup)' })
  overview(@Query() query: AnalyticsRangeDto): Promise<unknown> {
    return this.analytics.overview(query.to ?? query.from);
  }

  @Get('analytics/acquisition')
  @RequirePermission(AdminPermission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Signups by source over a range' })
  acquisition(@Query() query: AnalyticsRangeDto): Promise<unknown> {
    return this.analytics.acquisition(query.from ?? daysAgoBucket(30), query.to ?? todayBucket());
  }

  @Get('analytics/engagement')
  @RequirePermission(AdminPermission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Creation/fulfilment counts over a range' })
  engagement(@Query() query: AnalyticsRangeDto): Promise<unknown> {
    return this.analytics.engagement(query.from ?? daysAgoBucket(30), query.to ?? todayBucket());
  }

  // ── Audit ─────────────────────────────────────────────────────────────────────

  @Get('audit')
  @RequirePermission(AdminPermission.AUDIT_VIEW)
  @ApiOperation({ summary: 'The append-only audit trail' })
  auditLog(@Query() query: AuditQueryDto): Promise<unknown> {
    return this.audit.list(query);
  }

  @Get('audit/actions')
  @RequirePermission(AdminPermission.AUDIT_VIEW)
  @ApiOperation({ summary: 'Distinct action names, for populating a filter' })
  auditActions(): Promise<string[]> {
    return this.audit.actions();
  }
}
