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
import { BlogService } from 'src/modules/blog/blog.service';
import { BlogStatus, type BlogPostDetail } from 'src/modules/blog/blog.types';
import {
  AdminBlogListQueryDto,
  CreateBlogPostDto,
  PublishBlogPostDto,
  UpdateBlogPostDto,
} from 'src/modules/blog/dto/blog.dto';
import { CurrentAdmin, RequirePermission } from './admin.decorators';
import { AdminGuard } from './admin.guard';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

/** What the audit log keeps of a post: enough to tell versions apart. */
const snapshot = (p: BlogPostDetail): Record<string, unknown> => ({
  title: p.title,
  slug: p.slug,
  status: p.status,
  publishAt: p.publishAt,
  category: p.category,
});

/**
 * The blog desk: write, publish, schedule and take down the website's blog
 * posts. Reading needs `blog:view`, changing anything `blog:manage` — the
 * Content editor role has both and nothing else. Every change is audited.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/blog')
@Public()
@UseGuards(AdminGuard)
export class AdminBlogController {
  constructor(
    private readonly blog: BlogService,
    private readonly audit: AuditService,
  ) {}

  @Get('posts')
  @RequirePermission(AdminPermission.BLOG_VIEW)
  @ApiOperation({ summary: 'Posts, drafts included, most recently changed first' })
  list(@Query() q: AdminBlogListQueryDto): Promise<unknown> {
    return this.blog.adminList(q);
  }

  @Get('posts/:id')
  @RequirePermission(AdminPermission.BLOG_VIEW)
  @ApiOperation({ summary: 'One post, with the editor document' })
  get(@Param('id') id: string): Promise<BlogPostDetail> {
    return this.blog.adminGet(id);
  }

  @Post('posts')
  @RequirePermission(AdminPermission.BLOG_MANAGE)
  @ApiOperation({ summary: 'Start a post (a draft; audited)' })
  async create(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() dto: CreateBlogPostDto,
    @Ip() ip: string,
  ): Promise<BlogPostDetail> {
    const post = await this.blog.create(dto, { id: actor.id, name: actor.name });
    await this.record(actor, 'blog.create', post, {}, snapshot(post), ip);
    return post;
  }

  @Patch('posts/:id')
  @RequirePermission(AdminPermission.BLOG_MANAGE)
  @ApiOperation({ summary: 'Edit a post; a live one changes on the website at once (audited)' })
  async update(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: UpdateBlogPostDto,
    @Ip() ip: string,
  ): Promise<BlogPostDetail> {
    const before = await this.blog.adminGet(id);
    const post = await this.blog.update(id, dto);
    await this.record(actor, 'blog.edit', post, snapshot(before), snapshot(post), ip);
    return post;
  }

  @Post('posts/:id/publish')
  @RequirePermission(AdminPermission.BLOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish now, or schedule for `publishAt` (audited)' })
  async publish(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() dto: PublishBlogPostDto,
    @Ip() ip: string,
  ): Promise<BlogPostDetail> {
    const before = await this.blog.adminGet(id);
    const post = await this.blog.publish(id, dto.publishAt);
    await this.record(
      actor,
      post.status === BlogStatus.SCHEDULED ? 'blog.schedule' : 'blog.publish',
      post,
      snapshot(before),
      snapshot(post),
      ip,
    );
    return post;
  }

  @Post('posts/:id/unpublish')
  @RequirePermission(AdminPermission.BLOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a post off the website, back to a draft (audited)' })
  async unpublish(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<BlogPostDetail> {
    const before = await this.blog.adminGet(id);
    const post = await this.blog.unpublish(id);
    await this.record(actor, 'blog.unpublish', post, snapshot(before), snapshot(post), ip);
    return post;
  }

  @Post('posts/:id/remove')
  @RequirePermission(AdminPermission.BLOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a post for good (audited)' })
  async remove(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    const post = await this.blog.remove(id);
    await this.record(actor, 'blog.remove', post, snapshot(post), {}, ip);
    return { ok: true };
  }

  @Post('images')
  @RequirePermission(AdminPermission.BLOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Store a picture for a post — the raw WebP bytes, up to 2 MB' })
  uploadImage(@Req() req: Request): Promise<{ url: string }> {
    return this.blog.uploadImage(req.body as Buffer);
  }

  private record(
    actor: AuthenticatedAdmin,
    action: string,
    post: BlogPostDetail,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    ip: string | undefined,
  ): Promise<void> {
    return this.audit.record({
      actor,
      action,
      targetType: 'blog_post',
      targetId: post.id,
      before,
      after,
      meta: { title: post.title },
      ip: ip ?? null,
    });
  }
}
