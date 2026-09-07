import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { MediaModule } from 'src/modules/media/media.module';
import { UsersModule } from 'src/modules/users/users.module';
import { FfmpegService } from './ffmpeg.service';
import { PublicReelsController } from './public-reels.controller';
import { ReelCardRenderer } from './reel-card.renderer';
import { ReelCompileService } from './reel-compile.service';
import { ReelController } from './reel.controller';
import { ReelProcessor } from './reel.processor';
import { ReelReleaseRegistrar } from './reel-release.registrar';
import { ReelService } from './reel.service';
import { ReelCollection, ReelCollectionSchema } from './schemas/reel-collection.schema';
import { Wish, WishSchema } from './schemas/wish.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReelCollection.name, schema: ReelCollectionSchema },
      { name: Wish.name, schema: WishSchema },
    ]),
    // The delayed release job rides the shared scheduler; the heavy compile job
    // gets its own queue + bounded-concurrency worker.
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
    BullModule.registerQueue({ name: QUEUE.REELS }),
    // MediaService (confirmed wish uploads) and UsersService (recipient/author).
    MediaModule,
    UsersModule,
  ],
  controllers: [ReelController, PublicReelsController],
  providers: [
    ReelService,
    ReelCompileService,
    FfmpegService,
    ReelCardRenderer,
    ReelReleaseRegistrar,
    ReelProcessor,
  ],
  exports: [ReelService],
})
export class ReelsModule {}
