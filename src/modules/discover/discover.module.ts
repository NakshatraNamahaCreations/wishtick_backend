import { Module } from '@nestjs/common';
import { ProductsModule } from 'src/modules/products/products.module';
import { ProfileModule } from 'src/modules/profile/profile.module';
import { TaxonomyModule } from 'src/modules/taxonomy/taxonomy.module';
import { DiscoverController } from './discover.controller';
import { DiscoverService } from './discover.service';

/**
 * Reads only — Discover owns no collection of its own. It is a projection over
 * products (the shelves), important dates (who a shelf is for) and taxonomy
 * (the occasion's label).
 */
@Module({
  imports: [ProductsModule, ProfileModule, TaxonomyModule],
  controllers: [DiscoverController],
  providers: [DiscoverService],
})
export class DiscoverModule {}
