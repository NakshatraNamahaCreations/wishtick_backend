import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * The indexes behind `blog_posts`, the website's blog written in the admin
 * panel: one address per post, old addresses for redirects, and the two
 * orders the website lists in (newest published, newest in a category).
 */
export const migration043: Migration = {
  id: '043-blog-posts',
  description: 'Indexes for blog posts written in the admin panel',

  up: async (db: Db): Promise<void> => {
    const posts = db.collection('blog_posts');
    await posts.createIndex({ slug: 1 }, { unique: true, name: 'slug_1' });
    await posts.createIndex({ previousSlugs: 1 }, { name: 'previousSlugs_1' });
    await posts.createIndex({ status: 1, publishAt: -1 }, { name: 'status_1_publishAt_-1' });
    await posts.createIndex(
      { category: 1, publishedAt: -1 },
      { name: 'category_1_publishedAt_-1' },
    );
  },

  down: async (db: Db): Promise<void> => {
    const posts = db.collection('blog_posts');
    for (const name of [
      'slug_1',
      'previousSlugs_1',
      'status_1_publishAt_-1',
      'category_1_publishedAt_-1',
    ]) {
      await posts.dropIndex(name).catch(() => undefined);
    }
  },
};
