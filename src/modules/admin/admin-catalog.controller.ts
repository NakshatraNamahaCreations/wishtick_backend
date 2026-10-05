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
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import {
  AdminCatalogService,
  CATALOG_KINDS,
  type CatalogDetail,
  type CatalogKind,
  type TermRow,
} from './admin-catalog.service';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import {
  AdminReasonDto,
  CatalogListQueryDto,
  PageQueryDto,
  TaxonomyActiveDto,
  TaxonomyReorderDto,
  TaxonomyTermDto,
} from './dto/admin.dto';

function kindOf(kind: string): CatalogKind {
  if (!(CATALOG_KINDS as readonly string[]).includes(kind)) {
    throw new AppException(ErrorCode.NOT_FOUND, 'No such catalogue area', 404);
  }
  return kind as CatalogKind;
}

function taxonomyKindOf(kind: string): TaxonomyKind {
  if (!(Object.values(TaxonomyKind) as string[]).includes(kind)) {
    throw new AppException(ErrorCode.NOT_FOUND, 'No such option list', 404);
  }
  return kind as TaxonomyKind;
}

/**
 * The catalogue desk: the taxonomy behind every picker in the app, the stores
 * search trusts, and the product snapshots search has collected. Looking
 * needs `content:view`; changing anything needs `catalog:manage`.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/catalog')
@Public()
@UseGuards(AdminGuard)
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogService) {}

  // Fixed paths first, so none is read as a catalogue area.

  @Get('taxonomy')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'Every option list, with how many options each has' })
  kinds(): Promise<unknown> {
    return this.catalog.kinds();
  }

  @Get('taxonomy/:kind')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'One option list, retired options included, with usage counts' })
  kind(@Param('kind') kind: string): Promise<unknown> {
    return this.catalog.kindDetail(taxonomyKindOf(kind));
  }

  @Post('taxonomy/:kind')
  @RequirePermission(AdminPermission.CATALOG_MANAGE)
  @ApiOperation({ summary: 'Add an option (audited; the apps see it at once)' })
  create(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Body() dto: TaxonomyTermDto,
    @Ip() ip: string,
  ): Promise<TermRow> {
    return this.catalog.createTerm(taxonomyKindOf(kind), dto, actor, ip ?? null);
  }

  @Post('taxonomy/:kind/reorder')
  @RequirePermission(AdminPermission.CATALOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Put the options in a new order (audited)' })
  reorder(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Body() dto: TaxonomyReorderDto,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    return this.catalog.reorder(taxonomyKindOf(kind), dto.ids, dto, actor, ip ?? null);
  }

  @Patch('taxonomy/:kind/:id')
  @RequirePermission(AdminPermission.CATALOG_MANAGE)
  @ApiOperation({ summary: 'Change an option’s label or extras; its key never changes (audited)' })
  update(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() dto: TaxonomyTermDto,
    @Ip() ip: string,
  ): Promise<TermRow> {
    return this.catalog.updateTerm(taxonomyKindOf(kind), id, dto, actor, ip ?? null);
  }

  @Post('taxonomy/:kind/:id/active')
  @RequirePermission(AdminPermission.CATALOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retire an option or bring it back (audited)' })
  setActive(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() dto: TaxonomyActiveDto,
    @Ip() ip: string,
  ): Promise<TermRow> {
    return this.catalog.setActive(taxonomyKindOf(kind), id, dto.active, dto, actor, ip ?? null);
  }

  @Get('stores')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'Trusted stores, resellers, and the stores the catalogue holds' })
  stores(): Promise<unknown> {
    return this.catalog.stores();
  }

  @Get(':kind')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'Products, filtered and paged' })
  list(@Param('kind') kind: string, @Query() q: CatalogListQueryDto): Promise<unknown> {
    return this.catalog.list(kindOf(kind), q);
  }

  @Get(':kind/export')
  @RequirePermission(AdminPermission.EXPORT_DATA)
  @ApiOperation({ summary: 'Products as CSV (max 50,000 rows, audited)' })
  async export(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Query() q: CatalogListQueryDto,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    if (!actor.permissions.includes(AdminPermission.CONTENT_VIEW)) {
      throw new AppException(ErrorCode.ADMIN_FORBIDDEN, 'Exporting needs content:view', 403);
    }
    const k = kindOf(kind);
    const body = await this.catalog.exportCsv(k, q, actor, ip ?? null);
    return new StreamableFile(Buffer.from(`\uFEFF${body}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="wishtick-${k}.csv"`,
    });
  }

  @Get(':kind/facets/:field')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'The values a filter can take' })
  facets(@Param('kind') kind: string, @Param('field') field: string): Promise<string[]> {
    return this.catalog.facets(kindOf(kind), field);
  }

  @Get(':kind/:id')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'One product with its sellers, wishlists and clicks' })
  detail(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ): Promise<CatalogDetail> {
    return this.catalog.detail(kindOf(kind), id, actor);
  }

  @Get(':kind/:id/sections/:key')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'One more page of a section' })
  section(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('key') key: string,
    @Query() q: PageQueryDto,
  ): Promise<unknown> {
    return this.catalog.section(kindOf(kind), id, key, q.page ?? 1);
  }

  @Post(':kind/:id/actions/:action')
  @RequirePermission(AdminPermission.CATALOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh a product from its provider now (audited)' })
  act(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.catalog.act(kindOf(kind), id, action, dto.reason, actor, ip ?? null);
  }
}
