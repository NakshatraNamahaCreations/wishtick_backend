import { Body, Controller, Get, Ip, Param, ParseEnumPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AppVersionService } from 'src/modules/app-version/app-version.service';
import { AppPlatform, type AdminAppVersionView } from 'src/modules/app-version/app-version.types';
import { UpdateAppVersionPolicyDto } from 'src/modules/app-version/dto/app-version.dto';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

/** What the audit log keeps of a policy. */
const snapshot = (v: AdminAppVersionView): Record<string, unknown> => ({
  latestVersionCode: v.latestVersionCode,
  latestVersionName: v.latestVersionName,
  minVersionCode: v.minVersionCode,
  minVersionName: v.minVersionName,
  storeUrl: v.storeUrl,
  message: v.message,
});

/**
 * App updates: the newest build in each store, offered to everyone below it,
 * and the force update, which blocks builds below a minimum until they
 * update. Reading needs `ops:view`, saving `ops:manage`. Every save is
 * audited, and the app sees it at its next launch or return.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/app-version')
@Public()
@UseGuards(AdminGuard)
export class AdminAppVersionController {
  constructor(
    private readonly versions: AppVersionService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission(AdminPermission.OPS_VIEW)
  @ApiOperation({ summary: "Each platform's latest version and force update" })
  list(): Promise<AdminAppVersionView[]> {
    return this.versions.adminList();
  }

  @Put(':platform')
  @RequirePermission(AdminPermission.OPS_MANAGE)
  @ApiOperation({ summary: 'Set the latest version and force update for a platform (audited)' })
  async update(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('platform', new ParseEnumPipe(AppPlatform)) platform: AppPlatform,
    @Body() dto: UpdateAppVersionPolicyDto,
    @Ip() ip: string,
  ): Promise<AdminAppVersionView> {
    const before = await this.versions.adminGet(platform);
    const after = await this.versions.update(platform, dto, actor.id);
    // Named apart from an ordinary save, so a force update stands out in the log.
    const action =
      after.minVersionCode !== before.minVersionCode
        ? after.forced
          ? 'app_version.force_on'
          : 'app_version.force_off'
        : 'app_version.edit';
    await this.audit.record({
      actor,
      action,
      targetType: 'app_version',
      targetId: platform,
      before: snapshot(before),
      after: snapshot(after),
      meta: { platform, reason: dto.reason ?? null },
      ip: ip ?? null,
    });
    return after;
  }
}
