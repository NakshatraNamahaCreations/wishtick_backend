import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { BlogStatus } from '../blog.types';

/**
 * A post on the website's blog, written in the admin panel.
 *
 * The editor's own document (`contentJson`) is kept so a post reopens exactly
 * as it was written; `contentHtml` is that document turned into HTML and
 * sanitized on the way in — the only body the website is ever sent.
 */
@Schema({ collection: 'blog_posts', timestamps: true })
export class BlogPost {
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  title!: string;

  /** The address on the website: `/blog/<slug>`. */
  @Prop({ type: String, required: true })
  slug!: string;

  /** Addresses the post had before; the website sends them on to the current one. */
  @Prop({ type: [String], default: [] })
  previousSlugs!: string[];

  @Prop({ type: String, default: '' })
  excerpt!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  contentJson!: Record<string, unknown> | null;

  @Prop({ type: String, default: '' })
  contentHtml!: string;

  @Prop({ type: String, default: null })
  coverUrl!: string | null;

  @Prop({ type: String, default: '' })
  coverAlt!: string;

  @Prop({ type: String, default: null })
  category!: string | null;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ type: String, default: '' })
  seoTitle!: string;

  @Prop({ type: String, default: '' })
  seoDescription!: string;

  @Prop({ type: String, enum: Object.values(BlogStatus), default: BlogStatus.DRAFT })
  status!: BlogStatus;

  /** When it goes (or went) live. Set on publish; in the future while scheduled. */
  @Prop({ type: Date, default: null })
  publishAt!: Date | null;

  /** The first time it went live — the date the website shows. */
  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Number, default: 1 })
  readingMinutes!: number;

  @Prop({ type: Types.ObjectId, default: null })
  authorAdminId!: Types.ObjectId | null;

  /** The byline. Free text, so a post can be credited to the team or a guest. */
  @Prop({ type: String, default: 'Wishtick' })
  authorName!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type BlogPostDocument = HydratedDocument<BlogPost>;
export const BlogPostSchema = SchemaFactory.createForClass(BlogPost);

BlogPostSchema.index({ slug: 1 }, { unique: true, name: 'slug_1' });
BlogPostSchema.index({ previousSlugs: 1 }, { name: 'previousSlugs_1' });
BlogPostSchema.index({ status: 1, publishAt: -1 }, { name: 'status_1_publishAt_-1' });
BlogPostSchema.index({ category: 1, publishedAt: -1 }, { name: 'category_1_publishedAt_-1' });
