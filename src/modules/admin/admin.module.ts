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
    ]),
    // Admin tokens are signed per-call with the admin secret + audience; the
    // module-level default stays empty so a user secret can never leak in.
    JwtModule.register({}),
    PassportModule,
    // Moderation re-enqueues a reel compile when a released wish is removed.
    BullModule.registerQueue({ name: QUEUE.REELS }),
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
    ModerationService,
    ModerationListener,
    NoopSafetyProvider,
    { provide: SAFETY_PROVIDER, useExisting: NoopSafetyProvider },
  ],
  exports: [AdminService, AuditService],
})
export class AdminModule {}
