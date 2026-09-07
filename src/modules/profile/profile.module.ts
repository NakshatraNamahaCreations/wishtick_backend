import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { AuthModule } from 'src/modules/auth/auth.module';
import { MediaModule } from 'src/modules/media/media.module';
import { TaxonomyModule } from 'src/modules/taxonomy/taxonomy.module';
import { UsersModule } from 'src/modules/users/users.module';
import { AccountLifecycleRegistrar } from './account-lifecycle.processor';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AccountRestoreController } from './account-restore.controller';
import { AddressesController } from './addresses.controller';
import { AddressesService } from './addresses.service';
import { DataExportService } from './data-export.service';
import { ImportantDatesController } from './important-dates.controller';
import { ImportantDatesService } from './important-dates.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { Address, AddressSchema } from './schemas/address.schema';
import { ImportantDate, ImportantDateSchema } from './schemas/important-date.schema';
import { UserProfile, UserProfileSchema } from './schemas/user-profile.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: ImportantDate.name, schema: ImportantDateSchema },
      { name: Address.name, schema: AddressSchema },
    ]),
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
    UsersModule,
    TaxonomyModule,
    MediaModule,
    // For TokenService (revoke every session on deletion) and PasswordService
    // (verify credentials on restore). AuthModule does not import this module,
    // so there is no cycle.
    AuthModule,
  ],
  controllers: [
    ProfileController,
    ImportantDatesController,
    AddressesController,
    AccountRestoreController,
  ],
  providers: [
    ProfileService,
    ImportantDatesService,
    AddressesService,
    AccountLifecycleService,
    AccountLifecycleRegistrar,
    DataExportService,
  ],
  exports: [ProfileService, AccountLifecycleService, ImportantDatesService, MongooseModule],
})
export class ProfileModule {}
