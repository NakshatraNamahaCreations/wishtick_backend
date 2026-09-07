import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventGroupGiftsService } from './event-group-gifts.service';
import { GroupGift, GroupGiftSchema } from './schemas/group-gift.schema';

/**
 * The one narrow fact events need out of group gifting: which groups are
 * running for a party.
 *
 * A tiny module of its own for the same reason [EventParticipationModule] is
 * one. GroupGiftModule pulls in wishlists, gifting, chat, media, settlements
 * and a queue; importing all of that into EventsModule to answer "how many
 * group gifts?" would be a dependency out of all proportion to the question,
 * and would put EventsModule downstream of a module that already reaches back
 * to it through wishlists.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: GroupGift.name, schema: GroupGiftSchema }])],
  providers: [EventGroupGiftsService],
  exports: [EventGroupGiftsService],
})
export class EventGroupGiftsModule {}
