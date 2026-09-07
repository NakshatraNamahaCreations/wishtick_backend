import { Injectable, Logger } from '@nestjs/common';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { ProfileService, type MeView } from 'src/modules/profile/profile.service';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import type { TaxonomyOptions } from 'src/modules/taxonomy/taxonomy.types';
import type { SaveOnboardingStepDto } from './dto/onboarding.dto';
import { ONBOARDING_STEPS, OnboardingStep, REQUIRED_STEPS } from './onboarding.steps';

export interface OnboardingOptionsView {
  steps: typeof ONBOARDING_STEPS;
  options: TaxonomyOptions;
}

export interface OnboardingStatusView {
  completed: boolean;
  completedAt: Date | null;
  completedSteps: string[];
  remainingRequiredSteps: string[];
}

/** Which profile fields each step is allowed to write. */
const STEP_FIELDS: Record<OnboardingStep, (keyof SaveOnboardingStepDto)[]> = {
  [OnboardingStep.PROFILE]: [
    'displayName',
    'dateOfBirth',
    'timezone',
    'email',
    'gender',
    'avatarKey',
    'photoMediaId',
  ],
  [OnboardingStep.INTERESTS]: ['interests', 'interestCategories', 'customInterests'],
  [OnboardingStep.SIZES]: ['clothingSize', 'shoeSize', 'favouriteColors', 'fitPreference'],
  [OnboardingStep.GIFTING]: ['giftCategories', 'lifestyle'],
  [OnboardingStep.OCCASIONS]: ['occasions'],
};

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly profiles: ProfileService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** The whole flow definition plus every selectable value, in one call. */
  async getOptions(): Promise<OnboardingOptionsView> {
    return {
      steps: [...ONBOARDING_STEPS].sort((a, b) => a.order - b.order),
      options: await this.taxonomy.getOptions(),
    };
  }

  async getStatus(userId: string): Promise<OnboardingStatusView> {
    const profile = await this.profiles.getOrCreate(userId);
    const completedSteps = profile.completedSteps ?? [];
    return {
      completed: profile.onboardingCompletedAt !== null,
      completedAt: profile.onboardingCompletedAt,
      completedSteps,
      remainingRequiredSteps: REQUIRED_STEPS.filter((s) => !completedSteps.includes(s)),
    };
  }

  /**
   * Saves one step. Idempotent: re-sending a step overwrites its fields and
   * records it once, so a client that lost the response can retry, and a user
   * can go back and change an answer without the step being marked twice.
   */
  async saveStep(
    userId: string,
    step: string,
    dto: SaveOnboardingStepDto,
  ): Promise<{ status: OnboardingStatusView; me: MeView }> {
    // `step` is an unvalidated path param, so this is a string-to-string
    // comparison; narrowing to the enum is exactly what the lookup decides.
    const definition = ONBOARDING_STEPS.find((s) => (s.step as string) === step);
    if (!definition) {
      throw new AppException(
        ErrorCode.ONBOARDING_STEP_UNKNOWN,
        `Unknown onboarding step: ${step}`,
        404,
        {
          validSteps: ONBOARDING_STEPS.map((s) => s.step),
        },
      );
    }

    // A step may only write its own fields. Without this, one request could
    // post the whole DTO to `occasions` and skip every other step's validation.
    const allowed = STEP_FIELDS[definition.step];
    const submitted = Object.keys(dto).filter(
      (k) => dto[k as keyof SaveOnboardingStepDto] !== undefined,
    );
    const unexpected = submitted.filter((k) => !allowed.includes(k as keyof SaveOnboardingStepDto));
    if (unexpected.length > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        `Fields not accepted by the "${step}" step: ${unexpected.join(', ')}`,
        400,
        { allowed },
      );
    }

    await this.applyStep(userId, definition.step, dto);

    const profile = await this.profiles.getOrCreate(userId);
    if (!profile.completedSteps.includes(definition.step)) {
      profile.completedSteps.push(definition.step);
      await profile.save();
    }

    const [status, me] = await Promise.all([this.getStatus(userId), this.profiles.getMe(userId)]);
    return { status, me };
  }

  private async applyStep(
    userId: string,
    step: OnboardingStep,
    dto: SaveOnboardingStepDto,
  ): Promise<void> {
    // Reuses ProfileService rather than writing the document directly, so
    // taxonomy validation and the date-of-birth handling behave identically
    // whether a value arrives through onboarding or a later profile edit.
    switch (step) {
      case OnboardingStep.PROFILE:
        await this.profiles.updateProfile(userId, {
          displayName: dto.displayName,
          dateOfBirth: dto.dateOfBirth,
          timezone: dto.timezone,
          email: dto.email,
          gender: dto.gender,
          avatarKey: dto.avatarKey,
          photoMediaId: dto.photoMediaId,
        });
        return;
      case OnboardingStep.INTERESTS:
        await this.profiles.updatePreferences(userId, {
          interests: dto.interests,
          interestCategories: dto.interestCategories,
          customInterests: dto.customInterests,
        });
        return;
      case OnboardingStep.SIZES:
        await this.profiles.updatePreferences(userId, {
          clothingSize: dto.clothingSize,
          shoeSize: dto.shoeSize,
          favouriteColors: dto.favouriteColors,
          fitPreference: dto.fitPreference,
        });
        return;
      case OnboardingStep.GIFTING:
        await this.profiles.updatePreferences(userId, {
          giftCategories: dto.giftCategories,
          lifestyle: dto.lifestyle,
        });
        return;
      case OnboardingStep.OCCASIONS:
        await this.profiles.updatePreferences(userId, { occasions: dto.occasions });
        return;
    }
  }

  /**
   * Finalizes onboarding. Idempotent — completing twice returns the existing
   * timestamp rather than moving it, since "when did they join" is a metric
   * Sprint 11 reports on.
   */
  async complete(userId: string): Promise<OnboardingStatusView> {
    const profile = await this.profiles.getOrCreate(userId);

    if (profile.onboardingCompletedAt) {
      throw new AppException(
        ErrorCode.ONBOARDING_ALREADY_COMPLETE,
        'Onboarding is already complete',
        409,
      );
    }

    const missing = REQUIRED_STEPS.filter((s) => !profile.completedSteps.includes(s));
    if (missing.length > 0) {
      throw new AppException(
        ErrorCode.ONBOARDING_INCOMPLETE,
        `Finish these steps first: ${missing.join(', ')}`,
        400,
        { missingSteps: missing },
      );
    }

    profile.onboardingCompletedAt = new Date();
    await profile.save();
    this.logger.log(`Onboarding completed for ${userId}`);

    return this.getStatus(userId);
  }
}
