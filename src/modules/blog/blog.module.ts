import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { BlogPublishRegistrar } from './blog-publish.registrar';
import { BlogRevalidator } from './blog-revalidator';
import { BlogService } from './blog.service';
import { PublicBlogController } from './public-blog.controller';
import { BlogPost, BlogPostSchema } from './schemas/blog-post.schema';

/**
 * The website's blog: posts, the public reads the website caches, scheduled
 * publishing, and the call that refreshes the website when a post changes.
 * Writing posts is the admin panel's job (AdminBlogController), through
 * [BlogService].
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: BlogPost.name, schema: BlogPostSchema }]),
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
  ],
  controllers: [PublicBlogController],
  providers: [BlogService, BlogRevalidator, BlogPublishRegistrar],
  exports: [BlogService],
})
export class BlogModule {}
