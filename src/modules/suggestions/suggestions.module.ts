import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { ProfileModule } from '../profile/profile.module';
import { TasteModule } from '../taste/taste.module';
import { WishmatesModule } from '../wishmates/wishmates.module';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';

/**
 * Gift ideas tuned to a person.
 *
 * Sits above everything it uses — taste, the graph, product search — and is
 * imported by none of them, which is what keeps the dependency one-way.
 */
@Module({
  imports: [TasteModule, WishmatesModule, ProductsModule, ProfileModule],
  controllers: [SuggestionsController],
  providers: [SuggestionsService],
  exports: [SuggestionsService],
})
export class SuggestionsModule {}
