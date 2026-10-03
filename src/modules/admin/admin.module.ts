import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { AnalyticsModule } from 'src/modules/analytics/analytics.module';
import { AuthModule } from 'src/modules/auth/auth.module';
import { Message, MessageSchema } from 'src/modules/chat/schemas/message.schema';
import { Event, EventSchema } from 'src/modules/events/schemas/event.schema';
import { WebhookEvent, WebhookEventSchema } from 'src/modules/gifting/schemas/webhook-event.schema';
import { GroupGift, GroupGiftSchema } from 'src/modules/group-gifts/schemas/group-gift.schema';
import { Order, OrderSchema } from 'src/modules/orders/schemas/order.schema';
import { Gift, GiftSchema } from 'src/modules/gifting/schemas/gift.schema';
import { Media, MediaSchema } from 'src/modules/media/schemas/media.schema';
import {
  MemoryCapsule,
  MemoryCapsuleSchema,
} from 'src/modules/memories/schemas/memory-capsule.schema';
import {
  DeliveryLog,
  DeliveryLogSchema,
} from 'src/modules/notifications/schemas/delivery-log.schema';
import { ClickEvent, ClickEventSchema } from 'src/modules/products/schemas/click-event.schema';
import { Conversion, ConversionSchema } from 'src/modules/products/schemas/conversion.schema';
import {
  WishlistItem,
  WishlistItemSchema,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { UserProfile, UserProfileSchema } from 'src/modules/profile/schemas/user-profile.schema';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import {
  ReelCollection,
  ReelCollectionSchema,
} from 'src/modules/reels/schemas/reel-collection.schema';
import { Wish, WishSchema } from 'src/modules/reels/schemas/wish.schema';
import { User, UserSchema } from 'src/modules/users/schemas/user.schema';
import { Wishlist, WishlistSchema } from 'src/modules/wishlists/schemas/wishlist.schema';
import { AdminAuthController } from './admin-auth.controller';
import { AdminTokenService } from './admin-token.service';
import { AdminUsersService } from './admin-users.service';
import { AdminWebhooksService } from './admin-webhooks.service';
import { AdminSearchService } from './admin-search.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { AuditService } from './audit.service';
import { ModerationListener } from './moderation.listener';
import { ModerationService } from './moderation.service';
import { ReportsController } from './reports.controller';
import { NoopSafetyProvider, SAFETY_PROVIDER } from './safety-provider';
import { Admin, AdminSchema } from './schemas/admin.schema';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';
import { Report, ReportSchema } from './schemas/report.schema';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { TotpService } from './totp.service';

/**
 * The operator plane: separate admin auth (distinct JWT audience), the moderation
 * hub, the audit trail, and user administration. The "borrowed" schemas
 * (Message/Wish/Reel/Wishlist/Event/User) are read + moderated directly here —
 * they are schemas, not module dependencies, because moderation reaches across
 * every content domain without owning any of it.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Admin.name, schema: AdminSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
      { name: Report.name, schema: ReportSchema },
      { name: User.name, schema: UserSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Wish.name, schema: WishSchema },
      { name: ReelCollection.name, schema: ReelCollectionSchema },
      { name: Wishlist.name, schema: WishlistSchema },
      { name: Event.name, schema: EventSchema },
      { name: WebhookEvent.name, schema: WebhookEventSchema },
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: GroupGift.name, schema: GroupGiftSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Gift.name, schema: GiftSchema },
      { name: WishlistItem.name, schema: WishlistItemSchema },
      { name: MemoryCapsule.name, schema: MemoryCapsuleSchema },
      { name: ClickEvent.name, schema: ClickEventSchema },
      { name: Conversion.name, schema: ConversionSchema },
      { name: DeliveryLog.name, schema: DeliveryLogSchema },
      { name: Media.name, schema: MediaSchema },
    ]),
    // Admin tokens are signed per-call with the admin secret + audience; the
    // module-level default stays empty so a user secret can never leak in.
    JwtModule.register({}),
    PassportModule,
    // Moderation re-enqueues a reel compile when a released wish is removed.
    // Every queue: moderation re-enqueues reel compiles, and the dashboard
    // counts each queue's failed jobs.
    BullModule.registerQueue(...Object.values(QUEUE).map((name) => ({ name }))),
    AuthModule, // TokenService (session kill) + PasswordService (admin login)
    NotificationsModule, // owner notice on content removal
    AnalyticsModule, // dashboards read the rollup
  ],
  controllers: [AdminAuthController, AdminController, ReportsController],
  providers: [
    TotpService,
    AdminTokenService,
    AdminService,
    AdminJwtStrategy,
    AdminGuard,
    AuditService,
    AdminUsersService,
    AdminWebhooksService,
    AdminSearchService,
    AdminDashboardService,
    ModerationService,
    ModerationListener,
    NoopSafetyProvider,
    { provide: SAFETY_PROVIDER, useExisting: NoopSafetyProvider },
  ],
  exports: [AdminService, AuditService],
})
export class AdminModule {}
