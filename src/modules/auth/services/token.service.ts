import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import type { UserDocument } from 'src/modules/users/schemas/user.schema';
import { RefreshToken, type RefreshTokenDocument } from '../schemas/refresh-token.schema';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
  RequestContext,
  TokenPair,
} from '../auth.types';

/**
 * Why a refresh token stopped being valid. ROTATED is load-bearing rather than
 * merely informational: it is the signal rotate() uses to tell a replay attack
 * apart from an ordinary dead token.
 */
export const REVOKE_REASON = {
  ROTATED: 'rotated',
  REUSE: 'refresh_token_reuse',
  LOGOUT: 'logout',
  LOGOUT_ALL: 'logout_all',
  REVOKED_BY_USER: 'revoked_by_user',
  PASSWORD_RESET: 'password_reset',
} as const;

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly cache: CacheService,
    @InjectModel(RefreshToken.name)
    private readonly refreshModel: Model<RefreshTokenDocument>,
  ) {}

  // ── Issuing ────────────────────────────────────────────────────────────────

  /** Issues a fresh access+refresh pair, starting a new session family. */
  async issuePair(user: UserDocument, ctx: RequestContext): Promise<TokenPair> {
    return this.mint(user, randomUUID(), ctx);
  }

  private async mint(
    user: UserDocument,
    familyId: string,
    ctx: RequestContext,
  ): Promise<TokenPair> {
    const jwtCfg = this.config.get('jwt', { infer: true });

    const accessToken = await this.jwt.signAsync(
      {
        sub: user._id.toString(),
        sid: familyId,
        jti: randomUUID(),
        email: user.email,
        phone: user.phone,
        roles: user.roles,
        ev: user.emailVerifiedAt !== null,
        pv: user.phoneVerifiedAt !== null,
        // See AccessTokenPayload.ims — millisecond precision is what makes
        // logout-all exact rather than "sometime within this second".
        ims: Date.now(),
      },
      {
        secret: jwtCfg.accessSecret,
        expiresIn: TokenService.duration(jwtCfg.accessTtl),
        issuer: jwtCfg.issuer,
        audience: jwtCfg.audience,
      },
    );

    const refreshJti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: user._id.toString(), sid: familyId, jti: refreshJti },
      {
        secret: jwtCfg.refreshSecret,
        expiresIn: TokenService.duration(jwtCfg.refreshTtl),
        issuer: jwtCfg.issuer,
        audience: jwtCfg.audience,
      },
    );

    const decodedRefresh = this.jwt.decode<RefreshTokenPayload>(refreshToken);
    await this.refreshModel.create({
      userId: user._id,
      familyId,
      tokenHash: TokenService.hashToken(refreshToken),
      expiresAt: new Date(decodedRefresh.exp * 1000),
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip ?? null,
    });

    const decodedAccess = this.jwt.decode<AccessTokenPayload>(accessToken);
    return {
      accessToken,
      refreshToken,
      expiresIn: decodedAccess.exp - decodedAccess.iat,
      tokenType: 'Bearer',
    };
  }

  // ── Rotation + reuse detection ─────────────────────────────────────────────

  /**
   * Verifies a refresh token, rotates it, and returns a new pair.
   *
   * The security-critical case is the *second* presentation of an
   * already-rotated token. Legitimate clients never do this — they discard the
   * old token the moment they receive a new one. So a replay means the token
   * leaked, and since we cannot tell the thief from the victim, we revoke the
   * entire family and force both to log in again. Losing one session is the
   * correct price for evicting an attacker.
   */
  async rotate(rawToken: string, ctx: RequestContext, user: UserDocument): Promise<TokenPair> {
    const jwtCfg = this.config.get('jwt', { infer: true });

    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(rawToken, {
        secret: jwtCfg.refreshSecret,
        issuer: jwtCfg.issuer,
        audience: jwtCfg.audience,
      });
    } catch (err) {
      const expired = err instanceof Error && err.name === 'TokenExpiredError';
      throw new AppException(
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        expired ? 'Refresh token has expired. Please log in again.' : 'Invalid refresh token',
        401,
      );
    }

    const tokenHash = TokenService.hashToken(rawToken);
    const stored = await this.refreshModel.findOne({ tokenHash }).exec();

    if (!stored) {
      // Signature is valid but we have no record: the family was revoked and
      // reaped, or this token was minted against a database we no longer have.
      throw new AppException(
        ErrorCode.TOKEN_REVOKED,
        'This session is no longer valid. Please log in again.',
        401,
      );
    }

    if (stored.revokedAt) {
      // Only a token that was revoked *by rotation* indicates reuse: its owner
      // was handed a replacement and should never present it again. A token
      // revoked for any other reason (logout, password reset, or the fallout of
      // someone else's reuse) is simply dead, and reporting that as an attack
      // would tell the honest client the wrong story — and re-revoke a family
      // that is already revoked on every retry.
      if (stored.revokedReason === REVOKE_REASON.ROTATED) {
        this.logger.warn(
          `Refresh token reuse detected for user ${payload.sub} (family ${payload.sid}) — revoking family`,
        );
        await this.revokeFamily(payload.sid, REVOKE_REASON.REUSE);
        throw new AppException(
          ErrorCode.REFRESH_TOKEN_REUSED,
          'This session was ended for security reasons. Please log in again.',
          401,
        );
      }

      throw new AppException(
        ErrorCode.TOKEN_REVOKED,
        'This session is no longer valid. Please log in again.',
        401,
      );
    }

    const newPair = await this.mint(user, payload.sid, ctx);

    // Mark the old token rotated rather than deleting it — the tombstone is
    // exactly what makes the reuse check above possible.
    await this.refreshModel
      .updateOne(
        { _id: stored._id },
        {
          $set: {
            revokedAt: new Date(),
            revokedReason: REVOKE_REASON.ROTATED,
            replacedByHash: TokenService.hashToken(newPair.refreshToken),
          },
        },
      )
      .exec();

    return newPair;
  }

  // ── Revocation ─────────────────────────────────────────────────────────────

  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const res = await this.refreshModel
      .updateMany(
        { familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: reason } },
      )
      .exec();
    return res.modifiedCount;
  }

  async revokeAllForUser(userId: Types.ObjectId, reason: string): Promise<number> {
    const res = await this.refreshModel
      .updateMany(
        { userId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: reason } },
      )
      .exec();
    return res.modifiedCount;
  }

  // ── Access-token denylist ──────────────────────────────────────────────────

  /**
   * Access tokens are stateless, so logout cannot "delete" one. We instead
   * remember its jti until it would have expired anyway — bounded memory, and
   * the key self-reaps.
   */
  async denylistAccessToken(jti: string, exp: number): Promise<void> {
    const ttl = exp - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return;
    await this.cache.set(TokenService.denylistKey(jti), true, ttl);
  }

  async isAccessTokenDenylisted(jti: string): Promise<boolean> {
    return this.cache.exists(TokenService.denylistKey(jti));
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  /** One row per active session (family), newest first. */
  async listSessions(userId: Types.ObjectId): Promise<RefreshTokenDocument[]> {
    return this.refreshModel
      .find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findFamilyById(
    userId: Types.ObjectId,
    familyId: string,
  ): Promise<RefreshTokenDocument | null> {
    return this.refreshModel.findOne({ userId, familyId, revokedAt: null }).exec();
  }

  /**
   * jsonwebtoken@9 types `expiresIn` as a `ms` template-literal union, which a
   * config-loaded string cannot satisfy structurally. The Joi schema is what
   * actually validates these values, so the assertion is narrowing a validated
   * string, not bypassing a check.
   */
  private static duration(ttl: string): JwtSignOptions['expiresIn'] {
    return ttl as JwtSignOptions['expiresIn'];
  }

  static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  static randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  private static denylistKey(jti: string): string {
    return `auth:denylist:${jti}`;
  }
}
