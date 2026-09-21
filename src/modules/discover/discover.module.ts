import { Module } from '@nestjs/common';
import { ProductsModule } from 'src/modules/products/products.module';
import { ProfileModule } from 'src/modules/profile/profile.module';
import { SuggestionsModule } from 'src/modules/suggestions/suggestions.module';
import { TaxonomyModule } from 'src/modules/taxonomy/taxonomy.module';
import { DiscoverController } from './discover.controller';
import { DiscoverService } from './discover.service';

/**
 * Reads only — Discover owns no collection of its own. It is a projection over
 * products (the shelves), important dates (who a shelf is for), taxonomy (the
 * occasion's label) and suggestions (the one shelf ranked by what a linked
 * WishMate likes).
 *
 * One-way: SuggestionsModule knows nothing about Discover, and the pure
 * curation tables are shared as plain imports rather than through either.
 */
@Module({
  imports: [ProductsModule, ProfileModule, TaxonomyModule, SuggestionsModule],
  controllers: [DiscoverController],
  providers: [DiscoverService],
})
export class DiscoverModule {}
