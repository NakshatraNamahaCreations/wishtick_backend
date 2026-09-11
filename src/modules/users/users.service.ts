import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UserStatus } from 'src/common/enums/user-role.enum';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { User, type UserDocument } from './schemas/user.schema';

export interface CreateUserInput {
  email?: string;
  phone?: string;
  /** Omitted for passwordless accounts created via phone sign-in. */
  passwordHash?: string;
  name?: string;
  acquisition?: { source: string; ref: string | null };
  /**
   * Stamps the number verified at creation. Set by the OTP sign-in flow, where
   * possession of the number has just been proven.
   */
  phoneVerified?: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    // Read-only, and only for [displayNamesFor]: what to call somebody lives
    // on their profile, not on their account.
    @InjectModel(UserProfile.name)
    private readonly profileModel: Model<UserProfileDocument>,
  ) {}

  /**
   * What to call these people, in front of other people.
   *
   * Profile display name first, the account's `name` only as a fallback. The
   * phone sign-up the app uses never sets the account name — onboarding writes
   * the name somebody chooses to their *profile* and never back — so reading
   * the account alone named every real user "Someone", on push notifications
   * and gift lists alike.
   *
   * One resolver rather than one per module: this lookup had been written out
   * by hand in nine places, and the three that got it right were no help to
   * the six that did not. Ids with no name anywhere are simply absent from the
   * map; the caller supplies the wording for that.
   */
  async displayNamesFor(ids: Array<string | Types.ObjectId>): Promise<Map<string, string>> {
    // Malformed ids are dropped rather than thrown on, matching [findById]
    // and [findManyByIds] — a bad id in a list of twenty should cost that one
    // name, not the whole screen.
    const unique = [...new Set(ids.map((id) => id.toString()))].filter((id) =>
      Types.ObjectId.isValid(id),
    );
    if (unique.length === 0) return new Map();

    const [users, profiles] = await Promise.all([
      this.findManyByIds(unique),
      this.profileModel
        .find({ userId: { $in: unique.map((id) => new Types.ObjectId(id)) } })
        .exec(),
    ]);

    const names = new Map<string, string>();
    // Accounts first so profiles overwrite them, which is the precedence.
    for (const user of users) {
      const name = user.name?.trim();
      if (name) names.set(user._id.toString(), name);
    }
    for (const profile of profiles) {
      const name = profile.displayName?.trim();
      if (name) names.set(profile.userId.toString(), name);
    }
    return names;
  }

  /** [displayNamesFor] for one person, with the caller's wording for nobody. */
  async displayNameFor(id: string | Types.ObjectId, fallback: string): Promise<string> {
    const names = await this.displayNamesFor([id]);
    return names.get(id.toString()) ?? fallback;
  }

  /** Lowercases email and strips formatting from phone so lookups are stable. */
  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  static normalizePhone(phone: string): string {
    const trimmed = phone.trim().replace(/[\s()-]/g, '');
    return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  }

  async create(input: CreateUserInput): Promise<UserDocument> {
    return this.userModel.create({
      ...(input.email ? { email: UsersService.normalizeEmail(input.email) } : {}),
      ...(input.phone ? { phone: UsersService.normalizePhone(input.phone) } : {}),
      ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
      ...(input.phoneVerified ? { phoneVerifiedAt: new Date() } : {}),
      name: input.name,
      // First-touch attribution, stamped once and never overwritten.
      ...(input.acquisition
        ? { acquisition: { source: input.acquisition.source, ref: input.acquisition.ref } }
        : {}),
    });
  }

  /** Soft-deleted users are invisible to every lookup below. */
  private notDeleted() {
    return { deletedAt: null };
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.userModel.findOne({ _id: id, ...this.notDeleted() }).exec();
  }

  async findByIdOrFail(id: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.findById(id);
    if (!user) throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    return user;
  }

  /**
   * Batch lookup for display purposes (e.g. resolving group-gift participant
   * names in one query instead of N). Soft-deleted users are omitted, so a
   * caller must tolerate fewer results than ids and a missing id maps to "unknown".
   */
  async findManyByIds(ids: Array<string | Types.ObjectId>): Promise<UserDocument[]> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return [];
    return this.userModel.find({ _id: { $in: valid }, ...this.notDeleted() }).exec();
  }

  async findByEmail(email: string, withPassword = false): Promise<UserDocument | null> {
    const q = this.userModel.findOne({
      email: UsersService.normalizeEmail(email),
      ...this.notDeleted(),
    });
    return withPassword ? q.select('+passwordHash').exec() : q.exec();
  }

  async findByPhone(phone: string, withPassword = false): Promise<UserDocument | null> {
    const q = this.userModel.findOne({
      phone: UsersService.normalizePhone(phone),
      ...this.notDeleted(),
    });
    return withPassword ? q.select('+passwordHash').exec() : q.exec();
  }

  /** Resolves a login identifier that may be either an email or a phone number. */
  async findByIdentifier(identifier: string, withPassword = false): Promise<UserDocument | null> {
    return identifier.includes('@')
      ? this.findByEmail(identifier, withPassword)
      : this.findByPhone(identifier, withPassword);
  }

  /**
   * Deliberately bypasses the soft-delete filter every other lookup applies.
   *
   * Exactly one flow needs this: account restore, which by definition must find
   * an account that normal queries hide. It is a named, awkward method rather
   * than a `includeDeleted` flag on findByIdentifier so it cannot be reached by
   * accident — a deleted user leaking back into a login or a search is the bug
   * the soft-delete filter exists to prevent.
   *
   * An anonymized account is not returned: its PII is already destroyed, so
   * there is nothing left to restore.
   */
  async findDeletedByIdentifierForRestore(identifier: string): Promise<UserDocument | null> {
    const query = identifier.includes('@')
      ? { email: UsersService.normalizeEmail(identifier) }
      : { phone: UsersService.normalizePhone(identifier) };

    return this.userModel
      .findOne({ ...query, deletedAt: { $ne: null }, anonymizedAt: null })
      .select('+passwordHash')
      .exec();
  }

  async existsByEmail(email: string): Promise<boolean> {
    const found = await this.userModel
      .exists({ email: UsersService.normalizeEmail(email), ...this.notDeleted() })
      .exec();
    return found !== null;
  }

  async existsByPhone(phone: string): Promise<boolean> {
    const found = await this.userModel
      .exists({ phone: UsersService.normalizePhone(phone), ...this.notDeleted() })
      .exec();
    return found !== null;
  }

  /**
   * Sets (or changes) an account's email address, leaving it **unverified**.
   *
   * A phone sign-up has no email, so onboarding is where most users first give
   * one. It lands unverified deliberately — possession is only proven by
   * `/auth/verify/email/*`, and treating a self-declared address as verified
   * would let anyone claim someone else's mailbox.
   */
  async setEmail(userId: string | Types.ObjectId, email: string): Promise<void> {
    const normalized = UsersService.normalizeEmail(email);
    const _id = new Types.ObjectId(userId.toString());

    const current = await this.userModel.findById(_id).exec();
    if (!current) throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    if (current.email === normalized) return;

    // Pre-check for a clean message; the partial unique index is the guarantee
    // and the exception filter maps a racing 11000 to 409.
    if (await this.existsByEmail(normalized)) {
      throw new AppException(
        ErrorCode.EMAIL_ALREADY_REGISTERED,
        'An account with this email already exists',
        409,
      );
    }

    await this.userModel
      .updateOne({ _id }, { $set: { email: normalized, emailVerifiedAt: null } })
      .exec();
  }

  async markEmailVerified(id: Types.ObjectId): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { emailVerifiedAt: new Date() } }).exec();
  }

  async markPhoneVerified(id: Types.ObjectId): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { phoneVerifiedAt: new Date() } }).exec();
  }

  async recordLogin(id: Types.ObjectId): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } }).exec();
  }

  /**
   * Changing a password invalidates every access token issued so far. Without
   * this, "reset my password because it leaked" would leave the attacker's
   * current access token working for up to 15 more minutes.
   */
  async setPassword(id: Types.ObjectId, passwordHash: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: id }, { $set: { passwordHash, tokensInvalidBefore: new Date() } })
      .exec();
  }

  async invalidateTokensBefore(id: Types.ObjectId, at: Date = new Date()): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { tokensInvalidBefore: at } }).exec();
  }

  /** Throws if the account cannot hold a session (suspended/deleted). */
  assertUsable(user: UserDocument): void {
    if (user.deletedAt) {
      throw new AppException(ErrorCode.ACCOUNT_DELETED, 'This account has been deleted', 403);
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new AppException(
        ErrorCode.ACCOUNT_SUSPENDED,
        user.suspendedReason
          ? `This account is suspended: ${user.suspendedReason}`
          : 'This account is suspended',
        403,
      );
    }
  }
}
