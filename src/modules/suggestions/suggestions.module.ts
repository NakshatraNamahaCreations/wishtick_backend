import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { EventParticipationModule } from '../events/event-participation.module';
import { ProductsModule } from '../products/products.module';
import { ProfileModule } from '../profile/profile.module';
import { TasteModule } from '../taste/taste.module';
import { WishmatesModule } from '../wishmates/wishmates.module';
import { PublicInviteSuggestionsController } from './public-invite-suggestions.controller';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';
import { TastePrewarmRegistrar } from './taste-prewarm.registrar';
import { TastePrewarmService } from './taste-prewarm.service';
import { VendorBudgetService } from './vendor-budget.service';

/**
 * Gift ideas tuned to a person.
 *
 * Sits above everything it uses — taste, the graph, product search — and is
 * imported by none of them, which is what keeps the dependency one-way.
 */
@Module({
  imports: [
    TasteModule,
    WishmatesModule,
    ProductsModule,
    ProfileModule,
    // One question: what is the party behind this invite token for? The tiny
    // module rather than EventsModule, which reaches wishlists and back.
    EventParticipationModule,
    // The taste prewarm rides the shared scheduler queue.
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
  ],
  controllers: [SuggestionsController, PublicInviteSuggestionsController],
  providers: [SuggestionsService, VendorBudgetService, TastePrewarmService, TastePrewarmRegistrar],
  // The prewarm is exported for the same reason the reminder scan is: the e2e
  // suite drives one tick by hand, because there is no worker in tests.
  exports: [SuggestionsService, TastePrewarmService],
})
export class SuggestionsModule {}
