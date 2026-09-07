import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { MediaModule } from 'src/modules/media/media.module';
import { UsersModule } from 'src/modules/users/users.module';
import { WishmatesModule } from 'src/modules/wishmates/wishmates.module';
import { MemoriesController, PublicMemoriesController } from './memories.controller';
import { MemoriesService } from './memories.service';
import { MemoryRepliesService } from './memory-replies.service';
import { MemoryUnlockRegistrar } from './memory-unlock.registrar';
import { MemoryWishesService } from './memory-wishes.service';
import { MemoryCapsule, MemoryCapsuleSchema } from './schemas/memory-capsule.schema';
import { MemoryReply, MemoryReplySchema } from './schemas/memory-reply.schema';
import { MemoryWish, MemoryWishSchema } from './schemas/memory-wish.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MemoryCapsule.name, schema: MemoryCapsuleSchema },
      { name: MemoryWish.name, schema: MemoryWishSchema },
      { name: MemoryReply.name, schema: MemoryReplySchema },
    ]),
    // The delayed unlock job rides the shared scheduler. Nothing here is
    // compiled, so unlike reels there is no second, heavier queue.
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
    // MediaService (confirmed cover and wish uploads) and UsersService (the
    // contributor's display name).
    MediaModule,
    UsersModule,
    // For the WishMate check on create and the recipient's identity on read.
    WishmatesModule,
  ],
  controllers: [MemoriesController, PublicMemoriesController],
  providers: [MemoriesService, MemoryWishesService, MemoryRepliesService, MemoryUnlockRegistrar],
  exports: [MemoriesService],
})
export class MemoriesModule {}
