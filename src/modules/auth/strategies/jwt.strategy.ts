import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import type { AppConfig } from 'src/config/configuration';
import { UsersService } from 'src/modules/users/users.service';
import type { AccessTokenPayload } from '../auth.types';
import { TokenService } from '../services/token.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
  ) {
    const jwt = config.get('jwt', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwt.accessSecret,
      issuer: jwt.issuer,
      audience: jwt.audience,
    });
  }

  /**
   * Runs on every authenticated request, so it must stay cheap: one Redis
   * lookup and one indexed Mongo read.
   *
   * We do hit the database rather than trusting the token's claims outright.
   * A stateless-only check would keep a suspended or deleted user working for
   * the rest of their 15-minute access window, and "ban this user" needs to
   * mean now, not eventually.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (await this.tokens.isAccessTokenDenylisted(payload.jti)) {
      throw new AppException(ErrorCode.TOKEN_REVOKED, 'This token has been revoked', 401);
    }

    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new AppException(ErrorCode.TOKEN_INVALID, 'Account no longer exists', 401);
    }

    // Throws ACCOUNT_SUSPENDED / ACCOUNT_DELETED with a 403.
    this.users.assertUsable(user);

    // Logout-all and password changes move this marker forward, invalidating
    // every token issued before that moment without tracking each jti.
    //
    // Compared against `ims` (millisecond issue time) rather than `iat`: at
    // second granularity a token minted just before the invalidation and one
    // minted just after a legitimate re-login are indistinguishable, so either
    // a revoked token survives the rest of the second or the fresh one is
    // wrongly rejected. Milliseconds make the boundary exact.
    if (user.tokensInvalidBefore && payload.ims < user.tokensInvalidBefore.getTime()) {
      throw new AppException(
        ErrorCode.TOKEN_REVOKED,
        'This session has ended. Please log in again.',
        401,
      );
    }

    return {
      id: user._id.toString(),
      email: user.email,
      phone: user.phone,
      roles: user.roles,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      jti: payload.jti,
      sessionId: payload.sid,
    };
  }
}
