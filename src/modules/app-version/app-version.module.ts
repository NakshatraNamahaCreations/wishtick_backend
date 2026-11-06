import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';
import { AppVersionPolicy, AppVersionPolicySchema } from './schemas/app-version-policy.schema';

/**
 * The app's update prompt and force update. The admin panel's side
 * (AdminAppVersionController) lives in the admin module, as every admin route
 * does, and calls this service.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: AppVersionPolicy.name, schema: AppVersionPolicySchema }]),
  ],
  controllers: [AppVersionController],
  providers: [AppVersionService],
  exports: [AppVersionService],
})
export class AppVersionModule {}
