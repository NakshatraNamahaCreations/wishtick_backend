import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { MediaService } from 'src/modules/media/media.service';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import { UsersService } from 'src/modules/users/users.service';
import type { UpdatePreferencesDto, UpdateProfileDto } from './dto/profile.dto';
import { type Gender, UserProfile, type UserProfileDocument } from './schemas/user-profile.schema';

export interface MeView {
  id: string;
  email?: string;
  phone?: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  roles: string[];
  createdAt: Date;
  profile: {
    displayName: string | null;
    /**
     * The `@handle`, or null for an account that never claimed one.
     *
     * Here rather than only on the WishMates endpoints because the app has to
     * know whether the signed-in user is discoverable *before* it offers them
     * any of the graph: without a handle, search cannot find them and every
     * WishMates screen is a dead end. It is the user's own handle, so no
     * privacy question arises — the opt-in one is about other people's.
     */
    username: string | null;
    photoUrl: string | null;
    /** A bundled avatar key when no photo was uploaded. */
    avatarKey: string | null;
    gender: Gender | null;
    bio: string | null;
    dateOfBirth: string | null;
    timezone: string;
    contact: { city: string | null; country: string | null; deliveryAddress: string | null };
    preferences: {
      interests: string[];
      interestCategories: string[];
      customInterests: string[];
      favouriteColors: string[];
      clothingSize: string | null;
      shoeSize: string | null;
      fitPreference: string | null;
      giftCategories: string[];
      lifestyle: string[];
      occasions: string[];
    };
    onboarding: {
      completed: boolean;
      completedAt: Date | null;
      completedSteps: string[];
    };
  };
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    @InjectModel(UserProfile.name) private readonly model: Model<UserProfileDocument>,
    private readonly users: UsersService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
  ) {}

  /**
   * Profiles are created lazily on first read rather than at signup.
   *
   * Signup must not depend on the profile collection being writable, and a user
   * created before this sprint (or by a future admin import) still needs to work.
   * upsert makes it race-safe: two concurrent /me calls cannot create two rows.
   */
  async getOrCreate(userId: string): Promise<UserProfileDocument> {
    const _id = new Types.ObjectId(userId);
    const existing = await this.model.findOne({ userId: _id }).exec();
    if (existing) return existing;

    return this.model
      .findOneAndUpdate(
        { userId: _id },
        { $setOnInsert: { userId: _id, timezone: 'UTC' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  async getMe(userId: string): Promise<MeView> {
    const [user, profile] = await Promise.all([
      this.users.findByIdOrFail(userId),
      this.getOrCreate(userId),
    ]);

    return {
      id: user._id.toString(),
      email: user.email,
      phone: user.phone,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      roles: user.roles,
      createdAt: user.createdAt,
      profile: {
        displayName: profile.displayName ?? user.name ?? null,
        username: profile.username ?? null,
        photoUrl: profile.photoUrl,
        avatarKey: profile.avatarKey,
        gender: profile.gender,
        bio: profile.bio,
        // Date-only field: the time component is meaningless and sending a
        // UTC timestamp invites clients to shift it across a day boundary.
        dateOfBirth: profile.dateOfBirth ? ProfileService.toDateOnly(profile.dateOfBirth) : null,
        timezone: profile.timezone,
        contact: {
          city: profile.contact?.city ?? null,
          country: profile.contact?.country ?? null,
          deliveryAddress: profile.contact?.deliveryAddress ?? null,
        },
        preferences: {
          interests: profile.preferences?.interests ?? [],
          interestCategories: profile.preferences?.interestCategories ?? [],
          customInterests: profile.preferences?.customInterests ?? [],
          favouriteColors: profile.preferences?.favouriteColors ?? [],
          clothingSize: profile.preferences?.clothingSize ?? null,
          shoeSize: profile.preferences?.shoeSize ?? null,
          fitPreference: profile.preferences?.fitPreference ?? null,
          giftCategories: profile.preferences?.giftCategories ?? [],
          lifestyle: profile.preferences?.lifestyle ?? [],
          occasions: profile.preferences?.occasions ?? [],
        },
        onboarding: {
          completed: profile.onboardingCompletedAt !== null,
          completedAt: profile.onboardingCompletedAt,
          completedSteps: profile.completedSteps ?? [],
        },
      },
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<MeView> {
    const profile = await this.getOrCreate(userId);

    if (dto.displayName !== undefined) profile.displayName = dto.displayName;
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.timezone !== undefined) profile.timezone = dto.timezone;

    if (dto.dateOfBirth !== undefined) {
      profile.dateOfBirth = dto.dateOfBirth
        ? ProfileService.parseDateOfBirth(dto.dateOfBirth)
        : null;
    }

    if (dto.contact) {
      profile.contact = {
        city: dto.contact.city !== undefined ? dto.contact.city : (profile.contact?.city ?? null),
        country:
          dto.contact.country !== undefined
            ? dto.contact.country
            : (profile.contact?.country ?? null),
        deliveryAddress:
          dto.contact.deliveryAddress !== undefined
            ? dto.contact.deliveryAddress
            : (profile.contact?.deliveryAddress ?? null),
      };
    }

    if (dto.gender !== undefined) profile.gender = dto.gender;

    if (dto.photoMediaId !== undefined) {
      await this.setPhoto(profile, userId, dto.photoMediaId);
      // A photo wins over a preset: keeping both would leave "which picture"
      // ambiguous, and the upload is the more deliberate choice.
      if (dto.photoMediaId !== null) profile.avatarKey = null;
    }

    if (dto.avatarKey !== undefined) {
      profile.avatarKey = dto.avatarKey;
      if (dto.avatarKey !== null) await this.setPhoto(profile, userId, null);
    }

    if (dto.email !== undefined) {
      await this.users.setEmail(userId, dto.email);
    }

    await profile.save();
    return this.getMe(userId);
  }

  /**
   * Attaches a photo, but only media the caller owns, confirmed, and uploaded
   * as a profile photo — otherwise a user could point their avatar at someone
   * else's media id, or at an unverified 100MB reel video.
   */
  private async setPhoto(
    profile: UserProfileDocument,
    userId: string,
    mediaId: string | null,
  ): Promise<void> {
    const previousMediaId = profile.photoMediaId;

    if (mediaId === null) {
      profile.photoMediaId = null;
      profile.photoUrl = null;
    } else {
      const media = await this.media.getReadyOwned(userId, mediaId);
      if (media.purpose !== MediaPurpose.PROFILE_PHOTO) {
        throw new AppException(
          ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
          'This media was not uploaded as a profile photo',
          400,
        );
      }
      profile.photoMediaId = media._id;
      profile.photoUrl = media.url;
    }

    // The old photo is now unreferenced; flag it so the object can be reclaimed
    // rather than paid for forever.
    if (previousMediaId && previousMediaId.toString() !== mediaId) {
      await this.media.markOrphaned(previousMediaId).catch((err: Error) => {
        this.logger.error(`Failed to orphan media ${previousMediaId.toString()}: ${err.message}`);
      });
    }
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto): Promise<MeView> {
    await this.assertPreferencesValid(dto);
    const profile = await this.getOrCreate(userId);

    const current = profile.preferences ?? ({} as UserProfile['preferences']);
    profile.preferences = {
      interests: dto.interests ?? current.interests ?? [],
      interestCategories: dto.interestCategories ?? current.interestCategories ?? [],
      customInterests: dto.customInterests ?? current.customInterests ?? [],
      favouriteColors: dto.favouriteColors ?? current.favouriteColors ?? [],
      clothingSize:
        dto.clothingSize !== undefined ? dto.clothingSize : (current.clothingSize ?? null),
      shoeSize: dto.shoeSize !== undefined ? dto.shoeSize : (current.shoeSize ?? null),
      fitPreference:
        dto.fitPreference !== undefined ? dto.fitPreference : (current.fitPreference ?? null),
      giftCategories: dto.giftCategories ?? current.giftCategories ?? [],
      lifestyle: dto.lifestyle ?? current.lifestyle ?? [],
      occasions: dto.occasions ?? current.occasions ?? [],
    };

    await profile.save();
    return this.getMe(userId);
  }

  /**
   * Every supplied key must exist in the taxonomy. Checked in parallel.
   * `customInterests` is exempt by design — it is free text (length-capped in
   * the DTO), which is exactly what the "Anything Else You Love?" screen is for.
   */
  async assertPreferencesValid(dto: UpdatePreferencesDto): Promise<void> {
    await Promise.all([
      this.taxonomy.assertValid(TaxonomyKind.INTEREST, dto.interests ?? [], 'interests'),
      this.taxonomy.assertValid(
        TaxonomyKind.INTEREST_CATEGORY,
        dto.interestCategories ?? [],
        'interestCategories',
      ),
      this.taxonomy.assertValid(TaxonomyKind.COLOR, dto.favouriteColors ?? [], 'favouriteColors'),
      this.taxonomy.assertValidOne(TaxonomyKind.CLOTHING_SIZE, dto.clothingSize, 'clothingSize'),
      this.taxonomy.assertValidOne(TaxonomyKind.SHOE_SIZE, dto.shoeSize, 'shoeSize'),
      this.taxonomy.assertValidOne(TaxonomyKind.FIT_PREFERENCE, dto.fitPreference, 'fitPreference'),
      this.taxonomy.assertValid(
        TaxonomyKind.GIFT_CATEGORY,
        dto.giftCategories ?? [],
        'giftCategories',
      ),
      this.taxonomy.assertValid(TaxonomyKind.LIFESTYLE, dto.lifestyle ?? [], 'lifestyle'),
      this.taxonomy.assertValid(TaxonomyKind.OCCASION, dto.occasions ?? [], 'occasions'),
    ]);
  }

  /** Wipes profile PII in place. Called by the anonymization job. */
  async anonymize(userId: Types.ObjectId): Promise<void> {
    await this.model
      .updateOne(
        { userId },
        {
          $set: {
            displayName: null,
            photoUrl: null,
            photoMediaId: null,
            bio: null,
            dateOfBirth: null,
            contact: { city: null, country: null, deliveryAddress: null },
          },
        },
      )
      .exec();
  }

  async deleteForUser(userId: Types.ObjectId): Promise<void> {
    await this.model.deleteOne({ userId }).exec();
  }

  /**
   * Stores a birth date at UTC midnight. A date-only value must not drift:
   * parsing "1995-04-17" in a server-local zone can land on the 16th, and the
   * reel would then unlock a day early for some users.
   */
  private static parseDateOfBirth(input: string): Date {
    const [y, m, d] = input.slice(0, 10).split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(date.getTime())) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'dateOfBirth is not a valid date', 400);
    }
    if (date.getTime() > Date.now()) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'dateOfBirth cannot be in the future',
        400,
      );
    }
    return date;
  }

  private static toDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
