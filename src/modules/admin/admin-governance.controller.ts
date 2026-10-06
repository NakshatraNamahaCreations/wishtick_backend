import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { Public } from 'src/common/decorators/public.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { csvCell } from './admin-explorer.util';
import { AdminSessionsService, type AdminSessionView } from './admin-sessions.service';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminService, type AdminView } from './admin.service';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService, READ_ACTION } from './audit.service';
import { AdminActivityQueryDto, AuditQueryDto } from './dto/admin.dto';

/**
 * Governance: one admin's page — their sessions, ending one or all of them,
 * and what they have done — and the audit trail as a CSV.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@Public()
@UseGuards(AdminGuard)
export class AdminGovernanceController {
  constructor(
    private readonly admins: AdminService,
    private readonly sessions: AdminSessionsService,
    private readonly audit: AuditService,
  ) {}

  @Get('admins/:id')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @ApiOperation({ summary: 'One admin' })
  async admin(@Param('id') id: string): Promise<AdminView> {
    const all = await this.admins.list();
    const found = all.find((a) => a._id.toString() === id);
    if (!found) throw new AppException(ErrorCode.ADMIN_NOT_FOUND, 'Admin not found', 404);
    return AdminService.toView(found);
  }

  @Get('admins/:id/sessions')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @ApiOperation({ summary: 'Sessions an admin holds now, and the last ones that ended' })
  list(
    @Param('id') id: string,
  ): Promise<{ active: AdminSessionView[]; recent: AdminSessionView[] }> {
    return this.sessions.list(id);
  }

  @Post('admins/:id/sessions/:sessionId/end')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End one session now (audited)' })
  end(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Ip() ip: string,
  ): Promise<AdminSessionView> {
    return this.sessions.end(id, sessionId, actor, ip ?? null);
  }

  @Post('admins/:id/logout-all')
  @RequirePermission(AdminPermission.ADMINS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End every session an admin holds (audited)' })
  logoutAll(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<{ ended: number }> {
    return this.sessions.logoutAll(id, actor, ip ?? null);
  }

  @Get('admins/:id/activity')
  @RequirePermission(AdminPermission.AUDIT_VIEW)
  @ApiOperation({ summary: 'What one admin has done over the last N days' })
  activity(@Param('id') id: string, @Query() q: AdminActivityQueryDto): Promise<unknown> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(ErrorCode.ADMIN_NOT_FOUND, 'Admin not found', 404);
    }
    return this.audit.activity(id, q.days ?? 30);
  }

  @Get('audit/export')
  @RequirePermission(AdminPermission.EXPORT_DATA)
  @ApiOperation({ summary: 'The audit trail as CSV, up to 50,000 rows (itself audited)' })
  async export(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Query() q: AuditQueryDto,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    if (!actor.permissions.includes(AdminPermission.AUDIT_VIEW)) {
      throw new AppException(
        ErrorCode.ADMIN_FORBIDDEN,
        'Exporting the audit needs audit:view',
        403,
      );
    }
    const filters = {
      targetType: q.targetType,
      targetId: q.targetId,
      actorAdminId: q.actorAdminId,
      action: q.action,
      kind: q.kind,
      from: q.from,
      to: q.to,
    };
    const rows = await this.audit.all(filters);
    await this.audit.record({
      actor,
      action: 'audit.export',
      targetType: 'audit',
      targetId: null,
      meta: { rows: rows.length, filters },
      ip: ip ?? null,
    });
    const header = [
      'when',
      'admin',
      'action',
      'kind',
      'target type',
      'target id',
      'changes',
      'reason',
      'details',
      'ip',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      const { reason, ...rest } = r.meta ?? {};
      lines.push(
        [
          r.createdAt,
          r.actorEmail,
          r.action,
          READ_ACTION.test(r.action) ? 'read' : 'change',
          r.targetType,
          r.targetId,
          r.diff
            .map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`)
            .join('; '),
          typeof reason === 'string' ? reason : '',
          Object.keys(rest).length ? rest : '',
          r.ip,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return new StreamableFile(Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="wishtick-audit.csv"',
    });
  }
}
