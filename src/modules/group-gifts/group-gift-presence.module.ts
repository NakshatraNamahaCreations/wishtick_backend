import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GROUP_GIFT_PRESENCE } from 'src/modules/wishlists/access/group-gift-presence.port';
import { MongoGroupGiftPresence } from './group-gift-presence.service';
import { GroupGift, GroupGiftSchema } from './schemas/group-gift.schema';

/**
 * The one narrow fact wishlists need out of group gifting: is a group still
 * running on this list? Asked before a list is archived, so a host is never
 * left holding other people's money for an item that has quietly disappeared.
 *
 * A tiny module of its own for the same reason [EventGroupGiftsModule] and
 * [EventParticipationModule] are. GroupGiftModule imports WishlistsModule;
 * having WishlistsModule import it back would make the two circular, and all
 * the archive guard wants is one boolean off the GroupGift collection.
 *
 *   GroupGiftPresenceModule ← WishlistsModule ← GroupGiftModule
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: GroupGift.name, schema: GroupGiftSchema }])],
  providers: [{ provide: GROUP_GIFT_PRESENCE, useClass: MongoGroupGiftPresence }],
  exports: [GROUP_GIFT_PRESENCE],
})
export class GroupGiftPresenceModule {}
