import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MediaModule } from 'src/modules/media/media.module';
import { ProfileModule } from 'src/modules/profile/profile.module';
import { TaxonomyModule } from 'src/modules/taxonomy/taxonomy.module';
import { UsersModule } from 'src/modules/users/users.module';
import { EventParticipationModule } from 'src/modules/events/event-participation.module';
import { WishmatesModule } from 'src/modules/wishmates/wishmates.module';
import { AccessPolicyService } from './access/access-policy.service';
import { ItemsService } from './items.service';
import { ParticipantsService } from './participants.service';
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
    // One question only: is the person a list is *for* a WishMate of its
    // owner? WishmatesModule reaches events through the participation port and
    // never wishlists, so this stays one-way.
    WishmatesModule,
  ],
  controllers: [WishlistsController, PublicWishlistsController],
  providers: [
    WishlistsService,
    ItemsService,
    ParticipantsService,
    PublicWishlistsService,
    AccessPolicyService,
  ],
  // AccessPolicyService is exported because Sprints 6 and 8 must authorize
  // against the same decision — nothing re-implements it.
  exports: [
    AccessPolicyService,
    WishlistsService,
    ItemsService,
    ParticipantsService,
    MongooseModule,
  ],
})
export class WishlistsModule {}
