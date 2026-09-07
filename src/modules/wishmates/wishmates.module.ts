import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventParticipationModule } from 'src/modules/events/event-participation.module';
import { UserProfile, UserProfileSchema } from 'src/modules/profile/schemas/user-profile.schema';
import { User, UserSchema } from 'src/modules/users/schemas/user.schema';
import { WishLink, WishLinkSchema } from './schemas/wish-link.schema';
import { PresenceService } from './presence.service';
import { WishmatesController } from './wishmates.controller';
import { WishmatesService } from './wishmates.service';

/**
 * The connection graph.
 *
 * Exports [WishmatesService] because other modules need to ask one question of
 * it — "are these two connected?" — before letting people reach each other.
 * Direct chat is the first caller; anything that opens a channel between two
 * accounts should be the next.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WishLink.name, schema: WishLinkSchema },
      // Read-only here: the profile is where a handle and photo live, and the
      // graph has no business writing either beyond claiming the handle.
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: User.name, schema: UserSchema },
    ]),
    // One question only: which events are these two people both going to?
    // The tiny module rather than EventsModule — see its own note on the cycle.
    EventParticipationModule,
  ],
  controllers: [WishmatesController],
  providers: [WishmatesService, PresenceService],
  exports: [WishmatesService, PresenceService],
})
export class WishmatesModule {}
