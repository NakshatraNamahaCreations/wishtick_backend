import { Module } from '@nestjs/common';
import { ProfileModule } from '../profile/profile.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { TasteService } from './taste.service';

/**
 * Taste, on its own.
 *
 * Split from the suggestions that use it because two very different callers
 * need it: `WishmatesModule` wants a redacted summary for a profile screen,
 * and `SuggestionsModule` wants search terms and scoring features. If the
 * summary lived with the suggestions, WishMates would have to import a module
 * that imports WishMates — the cycle `EventParticipationModule` was carved out
 * of `EventsModule` to avoid.
 *
 * Owns no collection: it reads profiles and the taxonomy and computes.
 */
@Module({
  imports: [ProfileModule, TaxonomyModule],
  providers: [TasteService],
  exports: [TasteService],
})
export class TasteModule {}
