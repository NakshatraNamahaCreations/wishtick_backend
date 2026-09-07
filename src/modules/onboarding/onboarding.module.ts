import { Module } from '@nestjs/common';
import { ProfileModule } from 'src/modules/profile/profile.module';
import { TaxonomyModule } from 'src/modules/taxonomy/taxonomy.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [ProfileModule, TaxonomyModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
