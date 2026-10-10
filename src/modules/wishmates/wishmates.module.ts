import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TasteModule } from '../taste/taste.module';
import { EventParticipationModule } from 'src/modules/events/event-participation.module';
import { UserProfile, UserProfileSchema } from 'src/modules/profile/schemas/user-profile.schema';
import { User, UserSchema } from 'src/modules/users/schemas/user.schema';
import { UserBlock, UserBlockSchema } from './schemas/user-block.schema';
import { WishLink, WishLinkSchema } from './schemas/wish-link.schema';
import { PresenceService } from './presence.service';
import { WishmatesController } from './wishmates.controller';
import { WishmateLinkModule } from './wishmate-link.module';
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
      { name: UserBlock.name, schema: UserBlockSchema },
      // Read-only here: the profile is where a handle and photo live, and the
      // graph has no business writing either beyond claiming the handle.
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: User.name, schema: UserSchema },
    ]),
    // One question only: which events are these two people both going to?
    // The tiny module rather than EventsModule — see its own note on the cycle.
    EventParticipationModule,
    // The profile screen shows what a WishMate likes. One-way: TasteModule
    // knows nothing about the graph, and is handed the relationship instead.
    TasteModule,
    // The one boolean, in the module that owns it — see its own note.
    WishmateLinkModule,
  ],
  controllers: [WishmatesController],
  providers: [WishmatesService, PresenceService],
  // Re-exported as the module rather than the token: this module no longer
  // provides WISHMATE_LINK itself, and Nest refuses to export a provider a
  // module does not own. Anything importing WishmatesModule still gets it.
  exports: [WishmatesService, PresenceService, WishmateLinkModule],
})
export class WishmatesModule {}
