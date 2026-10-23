import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { BlogService } from './blog.service';
import { PublicBlogListQueryDto } from './dto/blog.dto';

/**
 * Generous: the website reads these server-side and caches them, so a visitor
 * never calls this directly — the limit is there for anyone who scrapes it.
 */
const PUBLIC_BLOG_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

/** The blog as the website reads it: published posts only, never drafts. */
@ApiTags('public')
@Controller('public/blog')
@Public()
export class PublicBlogController {
  constructor(private readonly blog: BlogService) {}

  @Get('posts')
  @Throttle(PUBLIC_BLOG_THROTTLE)
  @ApiOperation({ summary: 'Published posts, newest first' })
  list(@Query() q: PublicBlogListQueryDto): Promise<unknown> {
    return this.blog.publicList(q);
  }

  @Get('posts/:slug')
  @Throttle(PUBLIC_BLOG_THROTTLE)
  @ApiOperation({
    summary: 'One published post, or `redirectTo` when the address is an old one',
  })
  bySlug(@Param('slug') slug: string): Promise<unknown> {
    return this.blog.publicBySlug(slug);
  }

  @Get('categories')
  @Throttle(PUBLIC_BLOG_THROTTLE)
  @ApiOperation({ summary: 'Categories with published posts, and how many each has' })
  categories(): Promise<unknown> {
    return this.blog.publicCategories();
  }

  @Get('sitemap')
  @Throttle(PUBLIC_BLOG_THROTTLE)
  @ApiOperation({ summary: 'Every published post address, for the sitemap' })
  sitemap(): Promise<unknown> {
    return this.blog.publicSitemap();
  }
}
