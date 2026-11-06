import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { MongooseModule } from '@nestjs/mongoose';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';
import { PlayStoreClient } from './play-store.client';
import { PlaySyncRegistrar } from './play-sync.registrar';
import { AppVersionPolicy, AppVersionPolicySchema } from './schemas/app-version-policy.schema';

/**
 * The app's update prompt and force update, and the daily read of Google
 * Play that keeps the latest version current. The admin panel's side
 * (AdminAppVersionController) lives in the admin module, as every admin route
 * does, and calls this service.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: AppVersionPolicy.name, schema: AppVersionPolicySchema }]),
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
  ],
  controllers: [AppVersionController],
  providers: [AppVersionService, PlayStoreClient, PlaySyncRegistrar],
  exports: [AppVersionService],
})
export class AppVersionModule {}
