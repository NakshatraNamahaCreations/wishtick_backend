import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { deleteStoredUrl } from 'src/infra/storage/storage-url';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import { cleanBlogHtml, readingMinutes, slugOf, textOf } from './blog-html';
import { BlogRevalidator } from './blog-revalidator';
import {
  BLOG_IMAGE_MAX_BYTES,
  BLOG_SLUG_PATTERN,
  BlogStatus,
  type BlogPostDetail,
  type BlogPostSummary,
  type PublicBlogPost,
  type PublicBlogPostFull,
} from './blog.types';
import type {
  AdminBlogListQueryDto,
  CreateBlogPostDto,
  PublicBlogListQueryDto,
  UpdateBlogPostDto,
} from './dto/blog.dto';
import { BlogPost, type BlogPostDocument } from './schemas/blog-post.schema';

const CACHE_PREFIX = 'blog:v1:';
/** The website re-asks within this anyway; a write clears it at once. */
const CACHE_TTL = 300;
const ADMIN_PAGE = 25;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The blog: posts written and published from the admin panel, and the
 * published ones as the website reads them.
 *
 * Every change that touches what the website shows clears the read cache and
 * tells the website (see [BlogRevalidator]), so a published edit is live in
 * seconds. Bodies are sanitized on the way in; nothing unsanitized is stored.
 */
@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);

  constructor(
    @InjectModel(BlogPost.name) private readonly posts: Model<BlogPostDocument>,
    private readonly cache: CacheService,
    private readonly revalidator: BlogRevalidator,
    @Inject(STORAGE) private readonly storage: IStorageProvider,
  ) {}

  /** Where our blog pictures live; only these may appear in a post. */
  private get imageBase(): string {
    return this.storage.getPublicUrl('blog/');
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  async adminList(q: AdminBlogListQueryDto): Promise<{
    items: BlogPostSummary[];
    total: number;
    page: number;
    limit: number;
    categories: string[];
  }> {
    const filter: FilterQuery<BlogPost> = {};
    if (q.status) filter.status = q.status;
    if (q.category) filter.category = q.category;
    if (q.search?.trim()) {
      const re = new RegExp(escapeRegex(q.search.trim()), 'i');
      filter.$or = [{ title: re }, { slug: re }];
    }
    const page = q.page ?? 1;
    const [docs, total, categories] = await Promise.all([
      this.posts
        .find(filter, { contentJson: 0, contentHtml: 0 })
        .sort({ updatedAt: -1 })
        .skip((page - 1) * ADMIN_PAGE)
        .limit(ADMIN_PAGE)
        .lean()
        .exec(),
      this.posts.countDocuments(filter).exec(),
      this.posts.distinct('category', { category: { $ne: null } }).exec(),
    ]);
    return {
      items: docs.map((d) => this.summary(d)),
      total,
      page,
      limit: ADMIN_PAGE,
      categories: categories.filter(Boolean).sort(),
    };
  }

  async adminGet(id: string): Promise<BlogPostDetail> {
    return this.detail(await this.find(id));
  }

  async create(
    input: CreateBlogPostDto,
    author: { id: string; name: string },
  ): Promise<BlogPostDetail> {
    const slug = input.slug
      ? await this.freeSlug(input.slug, null, true)
      : await this.freeSlug(slugOf(input.title) || 'post', null, false);
    const html = cleanBlogHtml(input.contentHtml ?? '', this.imageBase);
    const doc = await this.posts.create({
      title: input.title,
      slug,
      excerpt: input.excerpt ?? '',
      contentJson: input.contentJson ?? null,
      contentHtml: html,
      readingMinutes: readingMinutes(html),
      coverUrl: this.checkCover(input.coverUrl),
      coverAlt: input.coverAlt ?? '',
      category: input.category?.trim() || null,
      tags: BlogService.tags(input.tags),
      seoTitle: input.seoTitle ?? '',
      seoDescription: input.seoDescription ?? '',
      authorAdminId: Types.ObjectId.isValid(author.id) ? new Types.ObjectId(author.id) : null,
      authorName: input.authorName?.trim() || author.name || 'Wishtick',
      status: BlogStatus.DRAFT,
    });
    return this.detail(doc.toObject());
  }

  async update(id: string, input: UpdateBlogPostDto): Promise<BlogPostDetail> {
    const post = await this.find(id);
    const oldSlug = post.slug;
    const picturesBefore = this.picturesOf(post);
    if (input.title !== undefined) post.title = input.title;
    if (input.slug !== undefined && input.slug !== post.slug) {
      post.slug = await this.freeSlug(input.slug, post._id, true);
      // Once a post has been live its old address may be linked anywhere, so it
      // keeps working: the website sends it on to the new one.
      if (post.publishedAt) {
        post.previousSlugs = [...new Set([...post.previousSlugs, oldSlug])].filter(
          (s) => s !== post.slug,
        );
      }
    }
    if (input.excerpt !== undefined) post.excerpt = input.excerpt;
    if (input.contentJson !== undefined) {
      post.contentJson = input.contentJson;
      post.markModified('contentJson');
    }
    if (input.contentHtml !== undefined) {
      post.contentHtml = cleanBlogHtml(input.contentHtml, this.imageBase);
      post.readingMinutes = readingMinutes(post.contentHtml);
    }
    if (input.coverUrl !== undefined) post.coverUrl = this.checkCover(input.coverUrl);
    if (input.coverAlt !== undefined) post.coverAlt = input.coverAlt;
    if (input.category !== undefined) post.category = input.category?.trim() || null;
    if (input.tags !== undefined) post.tags = BlogService.tags(input.tags);
    if (input.seoTitle !== undefined) post.seoTitle = input.seoTitle;
    if (input.seoDescription !== undefined) post.seoDescription = input.seoDescription;
    if (input.authorName !== undefined) post.authorName = input.authorName.trim() || 'Wishtick';
    await post.save();
    if (post.status === BlogStatus.PUBLISHED) await this.changed([post.slug, oldSlug]);
    // A cover replaced, or a picture taken out of the body.
    const kept = this.picturesOf(post);
    await this.releasePictures([...picturesBefore].filter((url) => !kept.has(url)));
    return this.detail(post.toObject());
  }

  /** Live now, or at [publishAt] when that is in the future. */
  async publish(id: string, publishAt?: string): Promise<BlogPostDetail> {
    const post = await this.find(id);
    if (!post.title.trim() || !textOf(post.contentHtml)) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'A post needs a title and some words before it can be published',
        400,
      );
    }
    // Lists show the summary; a post published without one is introduced by
    // its first words.
    if (!post.excerpt.trim()) post.excerpt = BlogService.firstWords(post.contentHtml);
    const now = new Date();
    const at = publishAt ? new Date(publishAt) : now;
    if (Number.isNaN(at.getTime())) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'That publish time is not a date', 400);
    }
    if (at.getTime() > now.getTime() + 30_000) {
      post.status = BlogStatus.SCHEDULED;
      post.publishAt = at;
    } else {
      post.status = BlogStatus.PUBLISHED;
      post.publishAt = now;
      post.publishedAt = post.publishedAt ?? now;
    }
    await post.save();
    await this.changed([post.slug]);
    return this.detail(post.toObject());
  }

  /** Off the website; back to a draft that can be published again. */
  async unpublish(id: string): Promise<BlogPostDetail> {
    const post = await this.find(id);
    const wasLive = post.status === BlogStatus.PUBLISHED;
    post.status = BlogStatus.DRAFT;
    post.publishAt = null;
    await post.save();
    if (wasLive) await this.changed([post.slug]);
    return this.detail(post.toObject());
  }

  async remove(id: string): Promise<BlogPostDetail> {
    const post = await this.find(id);
    const snapshot = this.detail(post.toObject());
    await post.deleteOne();
    if (snapshot.status === BlogStatus.PUBLISHED) await this.changed([snapshot.slug]);
    await this.releasePictures([...this.picturesOf(post)]);
    return snapshot;
  }

  /**
   * Stores a picture for a post — its cover, or one inside it. WebP only: the
   * panel converts and shrinks it first, so every stored picture is small.
   */
  async uploadImage(body: Buffer): Promise<{ url: string }> {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'No picture was sent', 400);
    }
    if (body.length > BLOG_IMAGE_MAX_BYTES) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'The picture must be 2 MB or smaller',
        413,
      );
    }
    const isWebp =
      body.subarray(0, 4).toString('latin1') === 'RIFF' &&
      body.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!isWebp) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Pictures are uploaded as WebP', 415);
    }
    const key = `blog/${randomUUID()}.webp`;
    await this.storage.putObject(key, body, 'image/webp');
    return { url: this.storage.getPublicUrl(key) };
  }

  /** Publishes every scheduled post whose time has come. Run by the scheduler. */
  async publishDue(): Promise<number> {
    const due = await this.posts
      .find({ status: BlogStatus.SCHEDULED, publishAt: { $lte: new Date() } })
      .exec();
    for (const post of due) {
      post.status = BlogStatus.PUBLISHED;
      post.publishedAt = post.publishedAt ?? post.publishAt;
      await post.save();
    }
    if (due.length) {
      await this.changed(due.map((p) => p.slug));
      this.logger.log(`Published ${due.length} scheduled blog post(s)`);
    }
    return due.length;
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async publicList(q: PublicBlogListQueryDto): Promise<{
    items: PublicBlogPost[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = q.page ?? 1;
    const limit = q.limit ?? 12;
    const key = `${CACHE_PREFIX}list:${page}:${limit}:${q.category ?? ''}:${q.tag ?? ''}`;
    return this.cache.wrap(key, CACHE_TTL, async () => {
      const filter: FilterQuery<BlogPost> = { status: BlogStatus.PUBLISHED };
      if (q.category) filter.category = q.category;
      if (q.tag) filter.tags = q.tag;
      const [docs, total] = await Promise.all([
        this.posts
          .find(filter, { contentJson: 0, contentHtml: 0 })
          .sort({ publishedAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean()
          .exec(),
        this.posts.countDocuments(filter).exec(),
      ]);
      return { items: docs.map((d) => this.publicView(d)), total, page, limit };
    });
  }

  /** A published post, or where its old address now lives. */
  async publicBySlug(
    slug: string,
  ): Promise<{ post: PublicBlogPostFull | null; redirectTo: string | null }> {
    if (!BLOG_SLUG_PATTERN.test(slug)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such post', 404);
    }
    const found = await this.cache.wrap(`${CACHE_PREFIX}post:${slug}`, CACHE_TTL, async () => {
      const post = await this.posts
        .findOne({ slug, status: BlogStatus.PUBLISHED }, { contentJson: 0 })
        .lean()
        .exec();
      if (post) return { post: this.publicFull(post), redirectTo: null };
      const moved = await this.posts
        .findOne({ previousSlugs: slug, status: BlogStatus.PUBLISHED }, { slug: 1 })
        .lean()
        .exec();
      return { post: null, redirectTo: moved?.slug ?? null };
    });
    if (!found.post && !found.redirectTo) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such post', 404);
    }
    return found;
  }

  async publicCategories(): Promise<{ name: string; posts: number }[]> {
    return this.cache.wrap(`${CACHE_PREFIX}categories`, CACHE_TTL, async () => {
      const rows = await this.posts
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: BlogStatus.PUBLISHED, category: { $ne: null } } },
          { $group: { _id: '$category', n: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .exec();
      return rows.map((r) => ({ name: r._id, posts: r.n }));
    });
  }

  async publicSitemap(): Promise<{ slug: string; updatedAt: Date | null }[]> {
    return this.cache.wrap(`${CACHE_PREFIX}sitemap`, CACHE_TTL, async () => {
      const rows = await this.posts
        .find({ status: BlogStatus.PUBLISHED }, { slug: 1, updatedAt: 1 })
        .sort({ publishedAt: -1 })
        .limit(5_000)
        .lean()
        .exec();
      return rows.map((r) => ({ slug: r.slug, updatedAt: r.updatedAt ?? null }));
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Clears the read cache and tells the website these posts changed. */
  private async changed(slugs: string[]): Promise<void> {
    await this.cache.delByPattern(`${CACHE_PREFIX}*`);
    await this.revalidator.notify(slugs);
  }

  /** Every picture of ours a post shows: its cover, and each one in its body. */
  private picturesOf(post: { coverUrl?: string | null; contentHtml?: string }): Set<string> {
    const found = new Set<string>();
    if (post.coverUrl) found.add(post.coverUrl);
    const inBody = new RegExp(`${escapeRegex(this.imageBase)}[^"'\\s<>)]+`, 'g');
    for (const match of (post.contentHtml ?? '').matchAll(inBody)) found.add(match[0]);
    return found;
  }

  /**
   * Deletes pictures no post shows any more, from storage and the CDN.
   *
   * Each is checked against every post first: a picture can be pasted from
   * one post into another, and deleting it under the second would leave a
   * broken image on the website.
   */
  private async releasePictures(urls: string[]): Promise<void> {
    for (const url of urls) {
      const inUse = await this.posts.exists({
        $or: [{ coverUrl: url }, { contentHtml: { $regex: escapeRegex(url) } }],
      });
      if (!inUse) await deleteStoredUrl(this.storage, url, this.logger);
    }
  }

  private async find(id: string): Promise<BlogPostDocument> {
    const post = Types.ObjectId.isValid(id) ? await this.posts.findById(id).exec() : null;
    if (!post) throw new AppException(ErrorCode.NOT_FOUND, 'No such post', 404);
    return post;
  }

  /**
   * An address no other post uses or used. A chosen one must be free; one
   * made from the title gets "-2", "-3"… until it is.
   */
  private async freeSlug(
    wanted: string,
    self: Types.ObjectId | null,
    exact: boolean,
  ): Promise<string> {
    const taken = async (slug: string) =>
      this.posts
        .exists({
          $or: [{ slug }, { previousSlugs: slug }],
          ...(self ? { _id: { $ne: self } } : {}),
        })
        .exec();
    if (!(await taken(wanted))) return wanted;
    if (exact) {
      throw new AppException(ErrorCode.CONFLICT, `Another post already uses “${wanted}”`, 409);
    }
    for (let n = 2; n < 100; n++) {
      const next = `${wanted.slice(0, 76)}-${n}`;
      if (!(await taken(next))) return next;
    }
    return `${wanted.slice(0, 70)}-${randomUUID().slice(0, 8)}`;
  }

  private checkCover(url: string | null | undefined): string | null {
    if (!url) return null;
    if (!url.startsWith(this.imageBase)) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'The cover must be a picture uploaded here',
        400,
      );
    }
    return url;
  }

  /** About two lines of the body, cut at a word. */
  private static firstWords(html: string): string {
    const text = textOf(html);
    if (text.length <= 200) return text;
    return `${text.slice(0, 200).replace(/\s+\S*$/, '')}…`;
  }

  private static tags(tags: string[] | undefined): string[] {
    const seen = new Map<string, string>();
    for (const t of tags ?? []) {
      const tag = t.trim();
      if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
    return [...seen.values()];
  }

  private summary(d: BlogPost): BlogPostSummary {
    return {
      id: String(d._id),
      slug: d.slug,
      title: d.title,
      excerpt: d.excerpt ?? '',
      coverUrl: d.coverUrl ?? null,
      coverAlt: d.coverAlt ?? '',
      category: d.category ?? null,
      tags: d.tags ?? [],
      authorName: d.authorName ?? 'Wishtick',
      status: d.status,
      publishAt: d.publishAt ?? null,
      publishedAt: d.publishedAt ?? null,
      readingMinutes: d.readingMinutes ?? 1,
      updatedAt: d.updatedAt ?? null,
    };
  }

  private detail(d: BlogPost): BlogPostDetail {
    return {
      ...this.summary(d),
      previousSlugs: d.previousSlugs ?? [],
      contentJson: d.contentJson ?? null,
      contentHtml: d.contentHtml ?? '',
      seoTitle: d.seoTitle ?? '',
      seoDescription: d.seoDescription ?? '',
    };
  }

  private publicView(d: BlogPost): PublicBlogPost {
    return {
      slug: d.slug,
      title: d.title,
      excerpt: d.excerpt ?? '',
      coverUrl: d.coverUrl ?? null,
      coverAlt: d.coverAlt ?? '',
      category: d.category ?? null,
      tags: d.tags ?? [],
      authorName: d.authorName ?? 'Wishtick',
      publishedAt: d.publishedAt ?? null,
      updatedAt: d.updatedAt ?? null,
      readingMinutes: d.readingMinutes ?? 1,
    };
  }

  private publicFull(d: BlogPost): PublicBlogPostFull {
    return {
      ...this.publicView(d),
      excerpt: d.excerpt || BlogService.firstWords(d.contentHtml ?? ''),
      contentHtml: d.contentHtml ?? '',
      seoTitle: d.seoTitle ?? '',
      seoDescription: d.seoDescription ?? '',
    };
  }
}
