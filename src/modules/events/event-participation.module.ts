import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EVENT_PARTICIPATION } from 'src/modules/wishlists/access/event-participation.port';
import { MongoEventParticipation } from './event-participation.service';
import { SharedEventsService } from './shared-events.service';
import { EventInvite, EventInviteSchema } from './schemas/event-invite.schema';
import { Event, EventSchema } from './schemas/event.schema';

/**
 * A deliberately tiny module holding the invite/event models and the two narrow
 * lookups other modules need out of events.
 *
 * It exists to break a cycle. WishlistsModule needs EVENT_PARTICIPATION for the
 * EVENT_ONLY rule, and EventsModule needs WishlistsModule (to link wishlists and
 * to authorize through AccessPolicyService). Having WishlistsModule import the
 * full EventsModule would make the two import each other, and `forwardRef` would
 * paper over a dependency that does not actually need to be circular: the only
 * thing wishlists want from events is one boolean.
 *
 *   EventParticipationModule ← WishlistsModule ← EventsModule
 *
 * [SharedEventsService] joined it for the same reason from the other side:
 * WishmatesModule needs "which events are these two both going to?" for a
 * profile's Recent Activity, and EventsModule already reaches WishmatesModule
 * transitively through wishlists.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EventInvite.name, schema: EventInviteSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  providers: [
    { provide: EVENT_PARTICIPATION, useClass: MongoEventParticipation },
    SharedEventsService,
  ],
  exports: [EVENT_PARTICIPATION, SharedEventsService, MongooseModule],
})
export class EventParticipationModule {}
