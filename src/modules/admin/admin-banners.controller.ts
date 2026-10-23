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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import {
  AdminBannerListQueryDto,
  CreateHomeBannerDto,
  UpdateHomeBannerDto,
} from 'src/modules/promotions/dto/home-banner.dto';
import type { AdminBannerView } from 'src/modules/promotions/home-banner.types';
import { PromotionsService } from 'src/modules/promotions/promotions.service';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

/** What the audit log keeps of a banner: enough to tell versions apart. */
const snapshot = (b: AdminBannerView): Record<string, unknown> => ({
  placement: b.placement,
  title: b.title,
  subtitle: b.subtitle,
  imageUrl: b.imageUrl,
  linkUrl: b.linkUrl,
  position: b.position,
  active: b.active,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
});

/**
 * Home's ad banners — "Exclusive Offers" and "Special Offers for You". Reading
 * needs `banners:view`, changing anything `banners:manage`; the Content editor
 * role has both. Every change is audited, and shows in the app at once.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/banners')
@Public()
@UseGuards(AdminGuard)
export class AdminBannersController {
  constructor(
    private readonly promotions: PromotionsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission(AdminPermission.BANNERS_VIEW)
  @ApiOperation({ summary: 'Every banner, live or not, by placement and order' })
  list(@Query() q: AdminBannerListQueryDto): Promise<AdminBannerView[]> {
    return this.promotions.adminList(q.placement);
  }

  @Get(':id')
  @RequirePermission(AdminPermission.BANNERS_VIEW)
  @ApiOperation({ summary: 'One banner' })
  get(@Param('id') id: string): Promise<AdminBannerView> {
    return this.promotions.adminGet(id);
  }

  @Post()
  @RequirePermission(AdminPermission.BANNERS_MANAGE)
  @ApiOperation({ summary: 'Add a banner (audited)' })
  async create(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: CreateHomeBannerDto,
    @Ip() ip: string,
  ): Promise<AdminBannerView> {
    const banner = await this.promotions.create(dto, actor.id);
    await this.record(actor, 'banner.create', banner, {}, snapshot(banner), ip);
    return banner;
  }

  @Patch(':id')
  @RequirePermission(AdminPermission.BANNERS_MANAGE)
  @ApiOperation({ summary: 'Edit a banner; a live one changes in the app at once (audited)' })
  async update(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: UpdateHomeBannerDto,
    @Ip() ip: string,
  ): Promise<AdminBannerView> {
    const before = await this.promotions.adminGet(id);
    const banner = await this.promotions.update(id, dto);
    await this.record(actor, 'banner.edit', banner, snapshot(before), snapshot(banner), ip);
    return banner;
  }

  @Post(':id/remove')
  @RequirePermission(AdminPermission.BANNERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a banner for good (audited)' })
  async remove(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    const banner = await this.promotions.remove(id);
    await this.record(actor, 'banner.remove', banner, snapshot(banner), {}, ip);
    return { ok: true };
  }

  @Post('images')
  @RequirePermission(AdminPermission.BANNERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Store a banner picture — the raw WebP bytes, up to 2 MB' })
  uploadImage(@Req() req: Request): Promise<{ url: string }> {
    return this.promotions.uploadImage(req.body as Buffer);
  }

  private record(
    actor: AuthenticatedAdmin,
    action: string,
    banner: AdminBannerView,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    ip: string | undefined,
  ): Promise<void> {
    return this.audit.record({
      actor,
      action,
      targetType: 'home_banner',
      targetId: banner.id,
      before,
      after,
      meta: { title: banner.title, placement: banner.placement },
      ip: ip ?? null,
    });
  }
}
