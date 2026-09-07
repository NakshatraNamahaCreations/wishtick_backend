import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import { USER_REGISTERED, type UserRegisteredEvent } from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import { UsersService } from 'src/modules/users/users.service';
import type { UserDocument } from 'src/modules/users/schemas/user.schema';
import { OtpPurpose, type RequestContext, type TokenPair } from './auth.types';
import type { LoginDto } from './dto/login.dto';
import type { VerifyOtpLoginDto } from './dto/otp-login.dto';
import type { SignupDto } from './dto/signup.dto';
import {
  PasswordResetToken,
  type PasswordResetTokenDocument,
} from './schemas/password-reset-token.schema';
import { AuthNotificationsService } from './services/auth-notifications.service';
import { OtpService } from './services/otp.service';
import { PasswordService } from './services/password.service';
import { REVOKE_REASON, TokenService } from './services/token.service';

export interface AuthUserView {
  id: string;
  email?: string;
  phone?: string;
  name?: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  roles: string[];
  createdAt: Date;
}

export interface SessionView {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  /**
   * A real argon2 hash of a value nobody knows. Verifying against it on the
   * user-not-found path keeps login timing flat — otherwise a ~50ms difference
   * turns the login endpoint into a free user-enumeration oracle.
   */
  private decoyHash!: string;

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly authNotifications: AuthNotificationsService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly emitter: EventEmitter2,
    @InjectModel(PasswordResetToken.name)
    private readonly resetModel: Model<PasswordResetTokenDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.decoyHash = await this.passwords.hash(TokenService.randomToken(32));
  }

  // ── Signup ─────────────────────────────────────────────────────────────────

  async signup(
    dto: SignupDto,
    ctx: RequestContext,
  ): Promise<{ user: AuthUserView; tokens: TokenPair }> {
    if (!dto.email && !dto.phone) {
      throw new AppException(
        ErrorCode.IDENTIFIER_REQUIRED,
        'Provide either an email address or a phone number',
        400,
      );
    }

    this.passwords.assertStrong(dto.password, {
      email: dto.email,
      phone: dto.phone,
      name: dto.name,
    });

    // Pre-checks give a clean error message; the partial unique indexes are the
    // actual guarantee, and the exception filter maps a racing 11000 to 409.
    if (dto.email && (await this.users.existsByEmail(dto.email))) {
      throw new AppException(
        ErrorCode.EMAIL_ALREADY_REGISTERED,
        'An account with this email already exists',
        409,
      );
    }
    if (dto.phone && (await this.users.existsByPhone(dto.phone))) {
      throw new AppException(
        ErrorCode.PHONE_ALREADY_REGISTERED,
        'An account with this phone number already exists',
        409,
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);
    // First-touch attribution: the referring link's source, known only now.
    const source = dto.source?.trim() || 'organic';
    const user = await this.users.create({
      email: dto.email,
      phone: dto.phone,
      passwordHash,
      name: dto.name,
      acquisition: { source, ref: dto.ref?.trim() || null },
    });

    // Fire the verification code but never fail signup because delivery failed —
    // the account exists and the user can always request a fresh code.
    await this.sendVerificationForNewUser(user).catch((err: Error) =>
      this.logger.error(`Failed to send verification for ${user._id.toString()}: ${err.message}`),
    );

    // Announce the new account so events and wishlists can attach any invites
    // that were sent to this email/phone before it existed. Fire-and-forget on
    // an emitter rather than a direct call, because auth is upstream of both and
    // must not depend on them.
    this.emitter.emit(USER_REGISTERED, {
      userId: user._id.toString(),
      email: user.email,
      phone: user.phone,
      source,
    } satisfies UserRegisteredEvent);

    const tokens = await this.tokens.issuePair(user, ctx);
    this.logger.log(`New signup: ${user._id.toString()}`);
    return { user: AuthService.toUserView(user), tokens };
  }

  private async sendVerificationForNewUser(user: UserDocument): Promise<void> {
    if (user.email) {
      const code = await this.otp.issue(OtpPurpose.VERIFY_EMAIL, user.email);
      await this.authNotifications.sendEmailVerification(user.email, code);
    } else if (user.phone) {
      const code = await this.otp.issue(OtpPurpose.VERIFY_PHONE, user.phone);
      await this.authNotifications.sendPhoneVerification(user.phone, code);
    }
  }

  // ── Passwordless phone sign-in ─────────────────────────────────────────────

  /**
   * Sends a sign-in code to any number, registered or not.
   *
   * Unlike `requestPhoneVerification`, this deliberately does not care whether
   * an account exists: the same call opens both the sign-up and the sign-in
   * door, so the response reveals nothing either way.
   */
  async requestOtpLogin(phone: string): Promise<{ expiresInSeconds: number; devCode?: string }> {
    const normalized = UsersService.normalizePhone(phone);

    // Refuse before spending an SMS on an account that could not sign in anyway.
    const existing = await this.users.findByPhone(normalized);
    if (existing) this.users.assertUsable(existing);

    const code = await this.otp.issue(OtpPurpose.SIGN_IN, normalized);
    await this.authNotifications.sendPhoneVerification(normalized, code);

    return {
      expiresInSeconds: this.config.get('otp.ttlSeconds', { infer: true }),
      // Lets the app show the code inline instead of reading it off the SMS
      // adapter's console log — never sent once real SMS delivery is live.
      ...(this.config.get('app.isProduction', { infer: true }) ? {} : { devCode: code }),
    };
  }

  /**
   * Confirms a sign-in code and returns a session, creating the account on the
   * first successful code for an unknown number.
   */
  async verifyOtpLogin(
    dto: VerifyOtpLoginDto,
    ctx: RequestContext,
  ): Promise<{ user: AuthUserView; tokens: TokenPair; isNewUser: boolean }> {
    const normalized = UsersService.normalizePhone(dto.phone);

    // Consumes the code, so everything below runs at most once per code.
    await this.otp.verify(OtpPurpose.SIGN_IN, normalized, dto.code);

    const existing = await this.users.findByPhone(normalized);
    if (existing) {
      this.users.assertUsable(existing);
      // The code proves possession, so the number is verified from here on.
      if (!existing.phoneVerifiedAt) await this.users.markPhoneVerified(existing._id);
      await this.users.recordLogin(existing._id);

      const tokens = await this.tokens.issuePair(existing, ctx);
      const fresh = (await this.users.findById(existing._id)) ?? existing;
      return { user: AuthService.toUserView(fresh), tokens, isNewUser: false };
    }

    // A soft-deleted account still holds this number in the unique index, so
    // creating one here would fail on a duplicate key and surface as a bare 409.
    // Say what actually happened instead.
    const deleted = await this.users.findDeletedByIdentifierForRestore(normalized);
    if (deleted) {
      throw new AppException(
        ErrorCode.ACCOUNT_DELETED,
        'This account is pending deletion. Restore it before signing in again.',
        403,
      );
    }

    const source = dto.source?.trim() || 'organic';
    // No passwordHash: the account is passwordless until its owner sets one
    // through the reset flow.
    const user = await this.users.create({
      phone: normalized,
      name: dto.name,
      phoneVerified: true,
      acquisition: { source, ref: dto.ref?.trim() || null },
    });

    // Same announcement as password signup, so invites addressed to this number
    // before it existed get attached.
    this.emitter.emit(USER_REGISTERED, {
      userId: user._id.toString(),
      phone: user.phone,
      source,
    } satisfies UserRegisteredEvent);

    const tokens = await this.tokens.issuePair(user, ctx);
    this.logger.log(`New passwordless signup: ${user._id.toString()}`);
    return { user: AuthService.toUserView(user), tokens, isNewUser: true };
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  async login(
    dto: LoginDto,
    ctx: RequestContext,
  ): Promise<{ user: AuthUserView; tokens: TokenPair }> {
    const user = await this.users.findByIdentifier(dto.identifier, true);

    if (!user?.passwordHash) {
      // Covers both "no such user" and "passwordless account". Burn equivalent
      // CPU before failing so the response time matches a real account with a
      // wrong password — and so the two cases stay indistinguishable.
      await this.passwords.verify(this.decoyHash, dto.password);
      throw AuthService.invalidCredentials();
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) throw AuthService.invalidCredentials();

    // Checked only after the password verifies: telling an anonymous caller that
    // an account is suspended would confirm the account exists.
    this.users.assertUsable(user);

    const tokens = await this.tokens.issuePair(user, ctx);
    await this.users.recordLogin(user._id);
    return { user: AuthService.toUserView(user), tokens };
  }

  private static invalidCredentials(): AppException {
    // One message for "no such user" and "wrong password" — the distinction is
    // exactly what enumerates accounts.
    return new AppException(
      ErrorCode.INVALID_CREDENTIALS,
      'Incorrect email/phone or password',
      401,
    );
  }

  // ── Refresh / logout ───────────────────────────────────────────────────────

  async refresh(rawRefreshToken: string, ctx: RequestContext): Promise<TokenPair> {
    const decoded = this.decodeRefreshSubject(rawRefreshToken);
    const user = await this.users.findById(decoded);
    if (!user) {
      throw new AppException(ErrorCode.TOKEN_INVALID, 'Invalid refresh token', 401);
    }
    this.users.assertUsable(user);

    return this.tokens.rotate(rawRefreshToken, ctx, user);
  }

  /** Reads `sub` without verifying — TokenService.rotate does the real verification. */
  private decodeRefreshSubject(raw: string): string {
    try {
      const [, payloadPart] = raw.split('.');
      const json = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
        sub?: string;
      };
      if (!json.sub) throw new Error('missing sub');
      return json.sub;
    } catch {
      throw new AppException(ErrorCode.TOKEN_INVALID, 'Invalid refresh token', 401);
    }
  }

  /** Ends the current session only: this device's family plus this access token. */
  async logout(user: AuthenticatedUser, accessTokenExp: number): Promise<void> {
    await Promise.all([
      this.tokens.revokeFamily(user.sessionId, REVOKE_REASON.LOGOUT),
      this.tokens.denylistAccessToken(user.jti, accessTokenExp),
    ]);
  }

  /**
   * Ends every session. `tokensInvalidBefore` is what makes this immediate for
   * access tokens too — we cannot enumerate outstanding access-token jtis, so
   * we move the goalposts instead and JwtStrategy rejects anything older.
   */
  async logoutAll(user: AuthenticatedUser): Promise<{ sessionsRevoked: number }> {
    const userId = new Types.ObjectId(user.id);
    const [sessionsRevoked] = await Promise.all([
      this.tokens.revokeAllForUser(userId, REVOKE_REASON.LOGOUT_ALL),
      this.users.invalidateTokensBefore(userId),
    ]);
    return { sessionsRevoked };
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async listSessions(user: AuthenticatedUser): Promise<SessionView[]> {
    const docs = await this.tokens.listSessions(new Types.ObjectId(user.id));

    // Many rows share a familyId after rotation; a user thinks in devices, not
    // tokens, so collapse to the newest row per family.
    const byFamily = new Map<string, (typeof docs)[number]>();
    for (const doc of docs) {
      const existing = byFamily.get(doc.familyId);
      if (!existing || doc.createdAt > existing.createdAt) byFamily.set(doc.familyId, doc);
    }

    return [...byFamily.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((doc) => ({
        id: doc.familyId,
        userAgent: doc.userAgent,
        ip: doc.ip,
        createdAt: doc.createdAt,
        expiresAt: doc.expiresAt,
        current: doc.familyId === user.sessionId,
      }));
  }

  async revokeSession(user: AuthenticatedUser, sessionId: string): Promise<void> {
    const found = await this.tokens.findFamilyById(new Types.ObjectId(user.id), sessionId);
    if (!found) {
      throw new AppException(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }
    await this.tokens.revokeFamily(sessionId, REVOKE_REASON.REVOKED_BY_USER);
  }

  // ── Verification ───────────────────────────────────────────────────────────

  async requestEmailVerification(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    // Silent no-op for unknown addresses: responding differently would let
    // anyone test whether an email is registered.
    if (!user) return;
    if (user.emailVerifiedAt) {
      throw new AppException(ErrorCode.ALREADY_VERIFIED, 'This email is already verified', 409);
    }
    const code = await this.otp.issue(OtpPurpose.VERIFY_EMAIL, UsersService.normalizeEmail(email));
    await this.authNotifications.sendEmailVerification(email, code);
  }

  async confirmEmailVerification(email: string, code: string): Promise<void> {
    const normalized = UsersService.normalizeEmail(email);
    await this.otp.verify(OtpPurpose.VERIFY_EMAIL, normalized, code);

    const user = await this.users.findByEmail(normalized);
    if (!user) throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    await this.users.markEmailVerified(user._id);
  }

  async requestPhoneVerification(phone: string): Promise<void> {
    const user = await this.users.findByPhone(phone);
    if (!user) return;
    if (user.phoneVerifiedAt) {
      throw new AppException(
        ErrorCode.ALREADY_VERIFIED,
        'This phone number is already verified',
        409,
      );
    }
    const code = await this.otp.issue(OtpPurpose.VERIFY_PHONE, UsersService.normalizePhone(phone));
    await this.authNotifications.sendPhoneVerification(phone, code);
  }

  async confirmPhoneVerification(phone: string, code: string): Promise<void> {
    const normalized = UsersService.normalizePhone(phone);
    await this.otp.verify(OtpPurpose.VERIFY_PHONE, normalized, code);

    const user = await this.users.findByPhone(normalized);
    if (!user) throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    await this.users.markPhoneVerified(user._id);
  }

  // ── Password reset ─────────────────────────────────────────────────────────

  /**
   * Always resolves, whether or not the identifier exists. The caller gets one
   * generic message; only a real mailbox owner learns anything.
   */
  async forgotPassword(identifier: string, ctx: RequestContext): Promise<void> {
    const user = await this.users.findByIdentifier(identifier);
    if (!user || user.deletedAt) return;

    const rawToken = TokenService.randomToken(32);
    const ttl = this.config.get('passwordReset.ttlSeconds', { infer: true });

    // One live token at a time: an old link left working after a new request is
    // a needlessly wide window.
    await this.resetModel
      .updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: new Date() } })
      .exec();

    await this.resetModel.create({
      userId: user._id,
      tokenHash: TokenService.hashToken(rawToken),
      expiresAt: new Date(Date.now() + ttl * 1_000),
      requestedIp: ctx.ip ?? null,
    });

    if (user.email) {
      await this.authNotifications.sendPasswordReset(user.email, rawToken, ttl);
    } else if (user.phone) {
      await this.authNotifications.sendPasswordResetSms(user.phone, rawToken, ttl);
    }
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const record = await this.resetModel
      .findOne({ tokenHash: TokenService.hashToken(rawToken) })
      .exec();

    if (!record || record.usedAt) {
      throw new AppException(
        ErrorCode.RESET_TOKEN_INVALID,
        'This reset link is invalid or has already been used',
        400,
      );
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new AppException(
        ErrorCode.RESET_TOKEN_EXPIRED,
        'This reset link has expired. Please request a new one.',
        400,
      );
    }

    const user = await this.users.findByIdOrFail(record.userId);
    this.passwords.assertStrong(newPassword, {
      email: user.email,
      phone: user.phone,
      name: user.name,
    });

    const passwordHash = await this.passwords.hash(newPassword);

    // Consume the token first. If the write below fails we would rather leave a
    // burned token than a reusable one.
    await this.resetModel.updateOne({ _id: record._id }, { $set: { usedAt: new Date() } }).exec();

    // setPassword also stamps tokensInvalidBefore, so every access token dies here.
    await this.users.setPassword(user._id, passwordHash);
    await this.tokens.revokeAllForUser(user._id, REVOKE_REASON.PASSWORD_RESET);

    this.logger.log(`Password reset completed for ${user._id.toString()}`);

    if (user.email) {
      await this.authNotifications
        .sendPasswordChangedNotice(user.email)
        .catch((err: Error) => this.logger.error(`Password-changed notice failed: ${err.message}`));
    }
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  async getMe(userId: string): Promise<AuthUserView> {
    const user = await this.users.findByIdOrFail(userId);
    return AuthService.toUserView(user);
  }

  static toUserView(user: UserDocument): AuthUserView {
    return {
      id: user._id.toString(),
      email: user.email,
      phone: user.phone,
      name: user.name,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      roles: user.roles,
      createdAt: user.createdAt,
    };
  }
}
