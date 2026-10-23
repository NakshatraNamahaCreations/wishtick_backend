import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HomeBannersView } from './home-banner.types';
import { PromotionsService } from './promotions.service';

/** Home's ad carousels, as the app reads them. */
@ApiTags('home')
@ApiBearerAuth()
@Controller('home')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get('banners')
  @ApiOperation({
    summary: '"Exclusive Offers" and "Special Offers for You" — live banners, in order',
  })
  banners(): Promise<HomeBannersView> {
    return this.promotions.live();
  }
}
