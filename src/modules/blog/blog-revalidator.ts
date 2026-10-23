import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';

/** The website's cache tag for the blog's lists, and for one post. */
export const BLOG_TAG = 'blog';
export const blogPostTag = (slug: string): string => `blog-post:${slug}`;

/**
 * Tells the website a blog page changed, so it drops its cached copy now
 * instead of within five minutes. `POST {WEB_APP_URL}/api/revalidate` with the
 * shared secret — the same door the client's WordPress will knock on later.
 *
 * Never throws and never holds a request up for long: a missed call only
 * means the page refreshes on its own a few minutes later.
 */
@Injectable()
export class BlogRevalidator {
  private readonly logger = new Logger(BlogRevalidator.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async notify(slugs: string[]): Promise<void> {
    const secret = this.config.get('app.webRevalidateSecret', { infer: true });
    if (!secret) return;
    const base = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
    const tags = [BLOG_TAG, ...new Set(slugs.filter(Boolean).map(blogPostTag))];
    try {
      const res = await fetch(`${base}/api/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok)
        this.logger.warn(`Website revalidate answered ${res.status} for ${tags.join(', ')}`);
    } catch (e) {
      this.logger.warn(
        `Website revalidate failed for ${tags.join(', ')}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
