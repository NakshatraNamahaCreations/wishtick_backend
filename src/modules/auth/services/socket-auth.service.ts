import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import type { AppConfig } from 'src/config/configuration';
import type { AccessTokenPayload } from '../auth.types';
import { JwtStrategy } from '../strategies/jwt.strategy';

/**
 * Authenticates a Socket.IO handshake with the *same* checks a REST request
 * gets.
 *
 * The signature verification here mirrors what passport-jwt does for the HTTP
 * guard (same secret, issuer, audience, expiry), and then it delegates to
 * `JwtStrategy.validate` for the stateful checks — denylist, account status, and
 * the `tokensInvalidBefore` cutoff — so a socket connection is authorized
 * identically to a request and there is exactly one copy of those rules.
 */
@Injectable()
export class SocketAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly strategy: JwtStrategy,
  ) {}

  async authenticate(rawToken: string | undefined): Promise<AuthenticatedUser> {
    const token = SocketAuthService.normalize(rawToken);
    if (!token) {
      throw new AppException(ErrorCode.WS_UNAUTHENTICATED, 'A connection token is required', 401);
    }

    const jwtCfg = this.config.get('jwt', { infer: true });
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: jwtCfg.accessSecret,
        issuer: jwtCfg.issuer,
        audience: jwtCfg.audience,
      });
    } catch {
      throw new AppException(ErrorCode.WS_UNAUTHENTICATED, 'Invalid or expired token', 401);
    }

    // The stateful checks (denylist / suspended / deleted / logout-all) live here.
    return this.strategy.validate(payload);
  }

  /** Accepts a bare token or an `Authorization: Bearer <token>` string. */
  private static normalize(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed;
  }
}
