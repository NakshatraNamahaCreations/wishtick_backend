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
  AdminContentService,
  CONTENT_KINDS,
  type ContentDetail,
  type ContentKind,
  type ContentListPage,
} from './admin-content.service';
import { AdminTakedownService, type RemovalView } from './admin-takedown.service';
import type { AdminPage } from './admin-query.util';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import {
  AdminReasonDto,
  ContentActionDto,
  ContentListQueryDto,
  PageQueryDto,
  RemovalsQueryDto,
  SectionRevealDto,
} from './dto/admin.dto';

/** An unknown area is a 404, like any other path that is not there. */
function kindOf(kind: string): ContentKind {
  if (!(CONTENT_KINDS as readonly string[]).includes(kind)) {
    throw new AppException(ErrorCode.NOT_FOUND, 'No such content area', 404);
  }
  return kind as ContentKind;
}

/**
 * The content explorer: lists, detail pages, reveals, actions and takedowns
 * across wishlists, items, events, memories, reels, chats, thank-you notes and
 * uploaded files.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/content')
@Public()
@UseGuards(AdminGuard)
export class AdminContentController {
  constructor(
    private readonly content: AdminContentService,
    private readonly takedown: AdminTakedownService,
  ) {}

  // Fixed paths first, so `removals` is never read as a content kind.

  @Get('removals')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'Admin takedowns, newest first' })
  removals(@Query() q: RemovalsQueryDto): Promise<AdminPage<RemovalView>> {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    return this.takedown.list(
      { kind: q.kind, targetId: q.targetId, ownerId: q.owner },
      page,
      limit,
    );
  }

  @Post('removals/:id/restore')
  @RequirePermission(AdminPermission.CONTENT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Put a takedown back exactly as it was (reason required, audited)' })
  restore(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<RemovalView> {
    return this.takedown.restore(id, actor, ip ?? null, dto.reason);
  }

  @Get(':kind')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'One content area, filtered and paged' })
  list(@Param('kind') kind: string, @Query() q: ContentListQueryDto): Promise<ContentListPage> {
    return this.content.list(kindOf(kind), q);
  }

  @Get(':kind/facets/:field')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: "A filter's choices, from the data (e.g. item categories)" })
  facets(@Param('kind') kind: string, @Param('field') field: string): Promise<string[]> {
    return this.content.facets(kindOf(kind), field);
  }

  @Get(':kind/export')
  @RequirePermission(AdminPermission.EXPORT_DATA)
  @ApiOperation({ summary: 'One content area as CSV (max 50,000 rows, private parts left out)' })
  async export(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Query() q: ContentListQueryDto,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    if (!actor.permissions.includes(AdminPermission.CONTENT_VIEW)) {
      throw new AppException(
        ErrorCode.ADMIN_FORBIDDEN,
        'Exporting content needs content:view',
        403,
      );
    }
    const k = kindOf(kind);
    const csv = await this.content.exportRows(k, q, actor, ip ?? null);
    return new StreamableFile(Buffer.from(`\uFEFF${csv}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="wishtick-${k}.csv"`,
    });
  }

  @Get(':kind/:id')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'One thing, with what hangs off it; private parts held back' })
  detail(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ): Promise<ContentDetail> {
    return this.content.detail(kindOf(kind), id, actor);
  }

  @Post(':kind/:id/reveal')
  @RequirePermission(AdminPermission.SENSITIVE_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The same, private parts included — reason required, audited' })
  reveal(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() dto: AdminReasonDto,
    @Ip() ip: string,
  ): Promise<ContentDetail> {
    return this.content.detail(kindOf(kind), id, actor, { reason: dto.reason, ip: ip ?? null });
  }

  @Get(':kind/:id/sections/:key')
  @RequirePermission(AdminPermission.CONTENT_VIEW)
  @ApiOperation({ summary: 'One more page of a section; private parts held back' })
  section(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('key') key: string,
    @Query() q: PageQueryDto,
  ): Promise<unknown> {
    return this.content.section(kindOf(kind), id, key, q.page ?? 1, actor);
  }

  @Post(':kind/:id/sections/:key/reveal')
  @RequirePermission(AdminPermission.SENSITIVE_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One more page of a section, private parts included (audited)' })
  sectionRevealed(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SectionRevealDto,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.content.section(kindOf(kind), id, key, dto.page ?? 1, actor, {
      reason: dto.reason,
      ip: ip ?? null,
    });
  }

  @Post(':kind/:id/actions/:action')
  @RequirePermission(AdminPermission.CONTENT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Act on one thing — archive, hide, cancel, unlock… (reason required, audited)',
  })
  act(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() dto: ContentActionDto,
    @Ip() ip: string,
  ): Promise<{ ok: true; removal?: RemovalView | null }> {
    return this.content.act(kindOf(kind), id, action, dto, actor, ip ?? null);
  }
}
