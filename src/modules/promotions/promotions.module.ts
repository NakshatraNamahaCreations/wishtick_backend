import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { HomeBanner, HomeBannerSchema } from './schemas/home-banner.schema';

/**
 * Home's ad banners. The admin panel's side (AdminBannersController) lives in
 * the admin module, as every admin route does, and calls this service.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: HomeBanner.name, schema: HomeBannerSchema }])],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
