import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WISHMATE_LINK } from 'src/modules/wishlists/access/wishmate-link.port';
import { MongoWishmateLink } from './wishmate-link.service';
import { WishLink, WishLinkSchema } from './schemas/wish-link.schema';

/**
 * "Are these two WishMates?", and nothing else.
 *
 * Carved out of [WishmatesModule] for the reason [EventParticipationModule]
 * was carved out of events: ProfileModule has to ask the question — a saved
 * date may name an account, and that only counts while the two are still
 * connected — but WishmatesModule reads profiles and taste, which reads
 * profiles again. Importing the whole graph from underneath it would make the
 * two import each other over one boolean.
 *
 *   WishmateLinkModule ← ProfileModule ← TasteModule ← WishmatesModule
 *
 * Holds the link model and the port implementation only. WishmatesModule
 * imports it too, so there is exactly one [MongoWishmateLink] behaviour and
 * one collection owner.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: WishLink.name, schema: WishLinkSchema }])],
  providers: [{ provide: WISHMATE_LINK, useClass: MongoWishmateLink }],
  exports: [WISHMATE_LINK],
})
export class WishmateLinkModule {}
