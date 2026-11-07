import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MediaModule } from 'src/modules/media/media.module';
import { ProfileModule } from 'src/modules/profile/profile.module';
import { TaxonomyModule } from 'src/modules/taxonomy/taxonomy.module';
import { UsersModule } from 'src/modules/users/users.module';
import { EventParticipationModule } from 'src/modules/events/event-participation.module';
import { GroupGiftPresenceModule } from 'src/modules/group-gifts/group-gift-presence.module';
import { WishmatesModule } from 'src/modules/wishmates/wishmates.module';
import { AccessPolicyService } from './access/access-policy.service';
import { ReservationWindowService } from './reservation-window.service';
import { ItemsService } from './items.service';
import { ParticipantsService } from './participants.service';
import { PersonWishlistsController } from './person-wishlists.controller';
import { PersonWishlistsService } from './person-wishlists.service';
import { PublicWishlistsController } from './public-wishlists.controller';
import { PublicWishlistsService } from './public-wishlists.service';
import { WishlistItem, WishlistItemSchema } from './schemas/wishlist-item.schema';
import {
  WishlistParticipant,
  WishlistParticipantSchema,
} from './schemas/wishlist-participant.schema';
import { Wishlist, WishlistSchema } from './schemas/wishlist.schema';
import { WishlistsController } from './wishlists.controller';
import { WishlistsService } from './wishlists.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wishlist.name, schema: WishlistSchema },
      { name: WishlistItem.name, schema: WishlistItemSchema },
      { name: WishlistParticipant.name, schema: WishlistParticipantSchema },
    ]),
    UsersModule,
    TaxonomyModule,
    MediaModule,
    // For the UserProfile model, used to resolve the owner's first name for the
    // public view.
    ProfileModule,
    // Supplies EVENT_PARTICIPATION for the EVENT_ONLY rule. A tiny module rather
    // than the whole EventsModule, so wishlists and events do not import each
    // other — see EventParticipationModule.
    EventParticipationModule,
    // Supplies GROUP_GIFT_PRESENCE for the archive guard. The same shape as
    // above: one boolean off the GroupGift model, not the whole GroupGiftModule
    // (which imports this one) — see GroupGiftPresenceModule.
    GroupGiftPresenceModule,
    // One question only: is the person a list is *for* a WishMate of its
    // owner? WishmatesModule reaches events through the participation port and
    // never wishlists, so this stays one-way.
    WishmatesModule,
  ],
  controllers: [WishlistsController, PublicWishlistsController, PersonWishlistsController],
  providers: [
    WishlistsService,
    PersonWishlistsService,
    ItemsService,
    ParticipantsService,
    PublicWishlistsService,
    AccessPolicyService,
    // Needs the Event model, which EventParticipationModule already brings.
    ReservationWindowService,
  ],
  // AccessPolicyService is exported because Sprints 6 and 8 must authorize
  // against the same decision — nothing re-implements it.
  exports: [
    AccessPolicyService,
    WishlistsService,
    ItemsService,
    ParticipantsService,
    // Gifting asks it how long a hold may run; it depends on wishlists
    // already, so the arrow keeps pointing one way.
    ReservationWindowService,
    MongooseModule,
  ],
})
export class WishlistsModule {}
