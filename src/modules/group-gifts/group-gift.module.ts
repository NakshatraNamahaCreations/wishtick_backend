import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { ChatModule } from 'src/modules/chat/chat.module';
import { GiftingModule } from 'src/modules/gifting/gifting.module';
import { ProductsModule } from 'src/modules/products/products.module';
import { UserProfile, UserProfileSchema } from 'src/modules/profile/schemas/user-profile.schema';
import { UsersModule } from 'src/modules/users/users.module';
import {
  WishlistItem,
  WishlistItemSchema,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { WishlistsModule } from 'src/modules/wishlists/wishlists.module';
import { WishmatesModule } from 'src/modules/wishmates/wishmates.module';
import { GroupGiftCardRenderer } from './group-gift-card.renderer';
import { GroupGiftController } from './group-gift.controller';
import { GroupGiftPreviewService } from './group-gift-preview.service';
import { GroupGiftReconcileRegistrar } from './group-gift-reconcile.processor';
import { GroupGiftReconcileService } from './group-gift-reconcile.service';
import { GroupGiftInvitesService } from './group-gift-invites.service';
import { GroupGiftService } from './group-gift.service';
import { PublicGroupGiftsController } from './public-group-gifts.controller';
import { Contribution, ContributionSchema } from './schemas/contribution.schema';
import { GroupGiftInvite, GroupGiftInviteSchema } from './schemas/group-gift-invite.schema';
import { GroupGift, GroupGiftSchema } from './schemas/group-gift.schema';
import { Settlement, SettlementSchema } from './schemas/settlement.schema';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GroupGift.name, schema: GroupGiftSchema },
      { name: GroupGiftInvite.name, schema: GroupGiftInviteSchema },
      { name: Contribution.name, schema: ContributionSchema },
      { name: Settlement.name, schema: SettlementSchema },
      // Registered here too so the service can re-read item status inside the
      // claim transaction and the preview can read the item title.
      { name: WishlistItem.name, schema: WishlistItemSchema },
      // The saved UPI ID lives on the profile; settle-up reads and optionally
      // writes it. Read-only coupling — this module never owns a profile.
      { name: UserProfile.name, schema: UserProfileSchema },
    ]),
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
    // GiftStatusService (the holder gift) and GiftingService (loadGiftableItem).
    // One-way: group gifts depend on gifting, never the reverse.
    GiftingModule,
    // AccessPolicyService + WishlistsService for authorization and recounts.
    WishlistsModule,
    // For ProductImportService — "Add Another Gift" turns a catalogue product
    // into a wishlist item before claiming it. One-way, as ever: products know
    // about wishlists, group gifts know about products, and neither knows
    // about group gifts in return.
    ProductsModule,
    // UsersService for resolving participant display names.
    UsersModule,
    // ChatService, to provision the group-gift chat on create. One-way: group
    // gifts depend on chat; chat only reads the group-gift document.
    ChatModule,
    // One question only, and the same one chat asks: are these two connected?
    // Only WishMates can be invited to chip in, and that is checked here
    // rather than trusted from the picker.
    WishmatesModule,
  ],
  controllers: [GroupGiftController, SettlementController, PublicGroupGiftsController],
  providers: [
    GroupGiftService,
    GroupGiftInvitesService,
    GroupGiftPreviewService,
    GroupGiftCardRenderer,
    GroupGiftReconcileService,
    GroupGiftReconcileRegistrar,
    SettlementService,
  ],
  exports: [GroupGiftService, SettlementService],
})
export class GroupGiftModule {}
