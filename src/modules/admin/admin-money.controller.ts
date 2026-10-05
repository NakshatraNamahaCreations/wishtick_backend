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
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  AdminMoneyService,
  MONEY_KINDS,
  type MoneyDetail,
  type MoneyKind,
  type MoneyListPage,
} from './admin-money.service';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { MoneyActionDto, MoneyListQueryDto, MonthRangeDto, PageQueryDto } from './dto/admin.dto';

function kindOf(kind: string): MoneyKind {
  if (!(MONEY_KINDS as readonly string[]).includes(kind)) {
    throw new AppException(ErrorCode.NOT_FOUND, 'No such money area', 404);
  }
  return kind as MoneyKind;
}

const csv = (body: string, name: string): StreamableFile =>
  new StreamableFile(Buffer.from(`\uFEFF${body}`, 'utf8'), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${name}.csv"`,
  });

/**
 * The money explorer: gifts, orders, group gifts, affiliate sales and clicks,
 * webhooks; the finance and affiliate overviews; the drift log.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/money')
@Public()
@UseGuards(AdminGuard)
export class AdminMoneyController {
  constructor(private readonly money: AdminMoneyService) {}

  // Fixed paths first, so none is read as a money area.

  @Get('finance')
  @RequirePermission(AdminPermission.MONEY_VIEW)
  @ApiOperation({ summary: 'GMV, group-gift collections and commission, by month' })
  finance(@Query() q: MonthRangeDto): Promise<unknown> {
    return this.money.finance(q.from, q.to);
  }

  @Get('finance/export')
  @RequirePermission(AdminPermission.EXPORT_DATA)
  @ApiOperation({ summary: 'The monthly finance table as CSV (audited)' })
  async financeCsv(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Query() q: MonthRangeDto,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    this.assertCanSee(actor);
    return csv(await this.money.financeCsv(q.from, q.to, actor, ip ?? null), 'wishtick-finance');
  }

  @Get('affiliate')
  @RequirePermission(AdminPermission.MONEY_VIEW)
  @ApiOperation({ summary: 'Commission by merchant, clicks and sales by store, sync state' })
  affiliate(@Query() q: MonthRangeDto): Promise<unknown> {
    return this.money.affiliate(q.from, q.to);
  }

  @Post('affiliate/sync')
  @RequirePermission(AdminPermission.MONEY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync affiliate sales now (audited)' })
  syncNow(@CurrentAdmin() actor: AuthenticatedAdmin, @Ip() ip: string): Promise<unknown> {
    return this.money.syncNow(actor, ip ?? null);
  }

  @Get('drift')
  @RequirePermission(AdminPermission.MONEY_VIEW)
  @ApiOperation({ summary: 'Group gifts whose collected total drifted from their contributions' })
  drift(@Query() q: PageQueryDto): Promise<unknown> {
    return this.money.driftLog(q.page, q.limit);
  }

  @Get(':kind')
  @RequirePermission(AdminPermission.MONEY_VIEW)
  @ApiOperation({ summary: 'One money area, filtered and paged' })
  list(@Param('kind') kind: string, @Query() q: MoneyListQueryDto): Promise<MoneyListPage> {
    return this.money.list(kindOf(kind), q);
  }

  @Get(':kind/export')
  @RequirePermission(AdminPermission.EXPORT_DATA)
  @ApiOperation({ summary: 'One money area as CSV (max 50,000 rows, audited)' })
  async export(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Query() q: MoneyListQueryDto,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    this.assertCanSee(actor);
    const k = kindOf(kind);
    return csv(await this.money.exportCsv(k, q, actor, ip ?? null), `wishtick-${k}`);
  }

  @Get(':kind/:id')
  @RequirePermission(AdminPermission.MONEY_VIEW)
  @ApiOperation({ summary: 'One record with what hangs off it' })
  detail(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ): Promise<MoneyDetail> {
    return this.money.detail(kindOf(kind), id, actor);
  }

  @Get(':kind/:id/sections/:key')
  @RequirePermission(AdminPermission.MONEY_VIEW)
  @ApiOperation({ summary: 'One more page of a section' })
  section(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('key') key: string,
    @Query() q: PageQueryDto,
  ): Promise<unknown> {
    return this.money.section(kindOf(kind), id, key, q.page ?? 1);
  }

  @Post(':kind/:id/actions/:action')
  @RequirePermission(AdminPermission.MONEY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Correct a money record (reason required, audited)' })
  act(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() dto: MoneyActionDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.money.act(kindOf(kind), id, action, dto, actor, ip ?? null);
  }

  /** Exports need the export permission and sight of money both. */
  private assertCanSee(actor: AuthenticatedAdmin): void {
    if (!actor.permissions.includes(AdminPermission.MONEY_VIEW)) {
      throw new AppException(ErrorCode.ADMIN_FORBIDDEN, 'Exporting money needs money:view', 403);
    }
  }
}
