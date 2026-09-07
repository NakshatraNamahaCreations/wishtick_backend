import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { MediaModule } from 'src/modules/media/media.module';
import { ProfileModule } from 'src/modules/profile/profile.module';
import { UsersModule } from 'src/modules/users/users.module';
import { EventGroupGiftsModule } from 'src/modules/group-gifts/event-group-gifts.module';
import { WishmatesModule } from 'src/modules/wishmates/wishmates.module';
import { WishlistsModule } from 'src/modules/wishlists/wishlists.module';
import { EventParticipationModule } from './event-participation.module';
import { EventRemindersRegistrar } from './event-reminders.processor';
import { EventRemindersService } from './event-reminders.service';
import { EventsController } from './events.controller';
import { EventWishlistsService } from './event-wishlists.service';
import { EventsService } from './events.service';
import { InviteCardRenderer } from './invite-card.renderer';
import { InviteNotificationsService } from './invite-notifications.service';
import { InvitePreviewService } from './invite-preview.service';
import { InvitesService } from './invites.service';
import { GuestListExportService } from './guest-list-export.service';
import { PublicEventsController, PublicInvitesController } from './public-invites.controller';
import { PublicInvitesService } from './public-invites.service';
import {
  EventWishlistSubmission,
  EventWishlistSubmissionSchema,
} from './schemas/event-wishlist-submission.schema';
import { Event, EventSchema } from './schemas/event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
      {
        name: EventWishlistSubmission.name,
        schema: EventWishlistSubmissionSchema,
      },
    ]),
    // Brings the EventInvite model with it, and is the same module WishlistsModule
    // imports for EVENT_PARTICIPATION — one registration, no duplicate model.
    EventParticipationModule,
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
    UsersModule,
    MediaModule,
    // For the UserProfile model (host first name on the public invite).
    ProfileModule,
    // For AccessPolicyService and the Wishlist model. One-way: events know about
    // wishlists, and wishlists reach back only through the tiny participation
    // port — never the whole module.
    WishlistsModule,
    // For guest identities on the invite list. Also one-way, and it reaches
    // events only through EventParticipationModule, so this is not a cycle.
    WishmatesModule,
    // Just the "which groups are running for this party?" lookup — see the
    // note on the module itself.
    EventGroupGiftsModule,
  ],
  controllers: [EventsController, PublicInvitesController, PublicEventsController],
  providers: [
    EventsService,
    InvitesService,
    GuestListExportService,
    PublicInvitesService,
    EventWishlistsService,
    EventRemindersService,
    EventRemindersRegistrar,
    InviteNotificationsService,
    InvitePreviewService,
    InviteCardRenderer,
  ],
  exports: [EventsService, InvitesService, EventRemindersService],
})
export class EventsModule {}
