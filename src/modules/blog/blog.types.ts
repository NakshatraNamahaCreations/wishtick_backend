/** Where a post is in its life. Only `published` is ever shown on the website. */
export enum BlogStatus {
  DRAFT = 'draft',
  /** Will publish itself at `publishAt` (the sweep flips it). */
  SCHEDULED = 'scheduled',
  PUBLISHED = 'published',
}

/** A post's cover or a picture inside it: WebP the panel has already converted. */
export const BLOG_IMAGE_MAX_BYTES = 2_000_000;

/** URL words: lower-case letters and digits joined by single hyphens. */
export const BLOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One post as a list shows it — no body. */
export interface BlogPostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverUrl: string | null;
  coverAlt: string;
  category: string | null;
  tags: string[];
  authorName: string;
  status: BlogStatus;
  publishAt: Date | null;
  publishedAt: Date | null;
  readingMinutes: number;
  updatedAt: Date | null;
}

/** Everything the editor needs to reopen a post. */
export interface BlogPostDetail extends BlogPostSummary {
  previousSlugs: string[];
  contentJson: Record<string, unknown> | null;
  contentHtml: string;
  seoTitle: string;
  seoDescription: string;
}

/** A published post as the website reads it. */
export interface PublicBlogPost {
  slug: string;
  title: string;
  excerpt: string;
  coverUrl: string | null;
  coverAlt: string;
  category: string | null;
  tags: string[];
  authorName: string;
  publishedAt: Date | null;
  updatedAt: Date | null;
  readingMinutes: number;
}

export interface PublicBlogPostFull extends PublicBlogPost {
  contentHtml: string;
  seoTitle: string;
  seoDescription: string;
}
