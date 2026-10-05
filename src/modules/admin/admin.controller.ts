import {
  StreamableFile,
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
import { AdminWebhooksService, type WebhookEventAdminView } from './admin-webhooks.service';
import { AdminSearchService, type SearchHit } from './admin-search.service';
import { AdminDashboardService, type DashboardView } from './admin-dashboard.service';
import {
  AdminUser360Service,
  type RevealField,
  type SectionPage,
  type UserProfileAdminView,
} from './admin-user360.service';
import type { AdminPage } from './admin-query.util';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';
import { ModerationService } from './moderation.service';
import {
  AnalyticsRangeDto,
  AuditQueryDto,
  CreateAdminDto,
  ListUsersQueryDto,
  ModerationActionDto,
  AdminReasonDto,
  AdminSearchQueryDto,
  BulkModerationDto,
  ClaimReportDto,
  EditUserProfileDto,
  RevealDto,
  VerifyContactDto,
  ModerationQueueQueryDto,
  PageQueryDto,
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
    private readonly webhooks: AdminWebhooksService,
    private readonly searcher: AdminSearchService,
    private readonly dashboard: AdminDashboardService,
    private readonly user360: AdminUser360Service,
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

  @Get('users/export')
  @RequirePermission(AdminPermission.EXPORT_DATA)
  @ApiOperation({
    summary: 'The filtered user list as CSV (max 50,000 rows, contacts masked, audited)',
  })
  async exportUsers(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Query() query: ListUsersQueryDto,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    const csv = await this.users.exportCsv(query, actor, ip ?? null);
    // A file, not a payload: the response wrapper passes StreamableFile through.
    return new StreamableFile(Buffer.from(`\uFEFF${csv}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="wishtick-users.csv"',
    });
  }

  @Get('users/:id/profile')
  @RequirePermission(AdminPermission.USERS_VIEW)
  @ApiOperation({
    summary: 'Everything about a user at a glance: account, profile, counts',
    description:
      'Email, phone and UPI ID are masked; counts appear only for sections the admin may see.',
  })
  userProfile(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id') id: string,
  ): Promise<UserProfileAdminView> {
    return this.user360.profile(id, admin.permissions);
  }

  @Get('users/:id/sections/:key')
  @RequirePermission(AdminPermission.USERS_VIEW)
  @ApiOperation({
    summary: 'One section of a user, paged',
    description:
      'wishlists | gifts-given | gifts-received | group-gifts | contributions | settlements | ' +
      'orders | events | invites | memories | wishmates | sessions | devices | notifications | ' +
      'deliveries | important-dates | media | reports-made | reports-against | audit | activity. ' +
      'Each needs the permission its data belongs to.',
  })
  userSection(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id') id: string,
    @Param('key') key: string,
    @Query() query: PageQueryDto,
  ): Promise<SectionPage> {
    return this.user360.section(id, key, admin.permissions, query.page, query.limit);
  }

  @Post('users/:id/reveal')
  @RequirePermission(AdminPermission.SENSITIVE_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Unmask one private value (email, phone, UPI ID, addresses) — audited with a reason',
  })
  revealUser(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: RevealDto,
    @Ip() ip: string,
  ): Promise<{ field: RevealField; value: unknown }> {
    return this.user360.reveal(id, dto.field, dto.reason, actor, ip ?? null);
  }

  @Post('users/:id/sessions/:sessionId/revoke')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End one sign-in (its whole refresh-token family)' })
  async revokeUserSession(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.user360.revokeSession(id, sessionId, actor, ip ?? null);
    return { ok: true };
  }

  @Post('users/:id/devices/:deviceId/revoke')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop push notifications to one device' })
  async revokeUserDevice(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.user360.revokeDevice(id, deviceId, actor, ip ?? null);
    return { ok: true };
  }

  @Post('users/:id/verify')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an email or phone verified, with a reason' })
  async verifyUserContact(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: VerifyContactDto,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.user360.markVerified(id, dto.field, dto.reason, actor, ip ?? null);
    return { ok: true };
  }

  @Patch('users/:id/profile')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @ApiOperation({ summary: 'Correct or redact display name, username or bio, with a reason' })
  async editUserProfile(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: EditUserProfileDto,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    const { reason, ...changes } = dto;
    await this.user360.editProfile(id, changes, reason, actor, ip ?? null);
    return { ok: true };
  }

  @Post('users/:id/photo/remove')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take down a profile photo, with a reason' })
  async removeUserPhoto(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.user360.removePhoto(id, dto.reason, actor, ip ?? null);
    return { ok: true };
  }

  @Post('users/:id/search-budget/reset')
  @RequirePermission(AdminPermission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Give back today's product-search allowance" })
  async resetUserSearchBudget(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.user360.resetSearchBudget(id, actor, ip ?? null);
    return { ok: true };
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
  moderationQueue(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Query() query: ModerationQueueQueryDto,
  ): Promise<unknown> {
    return this.moderation.queue({
      targetType: query.type,
      status: query.status,
      source: query.source,
      assigned: query.assigned,
      adminId: actor.id,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post('moderation/reports/bulk')
  @RequirePermission(AdminPermission.MODERATION_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The same action on up to 100 reports; each audited on its own' })
  bulkAct(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: BulkModerationDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.moderation.bulkAct(dto.ids, dto.action, actor, ip ?? null, dto.reason ?? null);
  }

  @Get('moderation/reports/:id')
  @RequirePermission(AdminPermission.MODERATION_VIEW)
  @ApiOperation({ summary: 'One report' })
  moderationReport(@Param('id') id: string): Promise<unknown> {
    return this.moderation.getReport(id);
  }

  @Get('moderation/reports/:id/context')
  @RequirePermission(AdminPermission.MODERATION_VIEW)
  @ApiOperation({ summary: "The reporter's and the author's record, and who holds the report" })
  moderationContext(@Param('id') id: string): Promise<unknown> {
    return this.moderation.context(id);
  }

  @Post('moderation/reports/:id/claim')
  @RequirePermission(AdminPermission.MODERATION_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a report so nobody else works it' })
  claimReport(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: ClaimReportDto,
  ): Promise<unknown> {
    return this.moderation.claim(id, actor, dto.takeOver === true);
  }

  @Post('moderation/reports/:id/release')
  @RequirePermission(AdminPermission.MODERATION_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Let go of a report you hold' })
  releaseReport(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
  ): Promise<unknown> {
    return this.moderation.release(id, actor);
  }

  @Post('moderation/reports/:id/restore')
  @RequirePermission(AdminPermission.MODERATION_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Undo a report's removal (reason required, audited)" })
  restoreReport(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.moderation.restore(id, actor, ip ?? null, dto.reason);
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

  // ── Dashboard ────────────────────────────────────────────────────────────────

  @Get('dashboard')
  @ApiOperation({
    summary: 'The admin home page: key numbers, what needs attention, 30-day trends',
    description:
      'Counted live, cached 60s. Every admin may call it; each section is included only ' +
      'for the permission it belongs to.',
  })
  getDashboard(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<DashboardView> {
    return this.dashboard.forAdmin(admin.permissions);
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  @Get('search')
  @ApiOperation({
    summary: 'Find users, wishlists, events, group gifts and orders',
    description: 'Only the kinds the admin may see are searched; 5 of each at most.',
  })
  search(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query() query: AdminSearchQueryDto,
  ): Promise<SearchHit[]> {
    return this.searcher.search(query.q, admin.permissions);
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────

  @Get('webhooks/dead-letter')
  @RequirePermission(AdminPermission.MONEY_VIEW)
  @ApiOperation({ summary: 'Signature-valid webhooks that matched no gift, newest first' })
  deadLetter(@Query() query: PageQueryDto): Promise<AdminPage<WebhookEventAdminView>> {
    return this.webhooks.deadLetter(query.page, query.limit);
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

  @Get('analytics/shelves')
  @RequirePermission(AdminPermission.ANALYTICS_VIEW)
  @ApiOperation({
    summary: 'Gift shelf views, opens and open rate, by surface, kind and personalisation',
    description:
      "Compares shelves ranked by a WishMate's taste with plain occasion shelves. Counts " +
      'only — shelf events carry no user or recipient, so nothing here says who shopped for whom.',
  })
  shelves(@Query() query: AnalyticsRangeDto): Promise<unknown> {
    return this.analytics.shelves(query.from ?? daysAgoBucket(30), query.to ?? todayBucket());
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
