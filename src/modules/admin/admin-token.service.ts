import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import type { AdminDocument } from './schemas/admin.schema';

export interface AdminTokenResult {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Mints and revokes admin access tokens.
 *
 * The token is signed with the admin secret and — crucially — a DISTINCT
 * audience (`admin.jwtAudience`). Passport rejects a wrong `aud` before any
 * validate() runs, so a user token (audience `wishtick-app`) can never
 * authenticate on `/admin`, and vice versa. Sessions are short (2h) and
 * revocable: logout denylists the jti, and stamping `tokensInvalidBefore` on the
 * admin kills every outstanding token at once.
 */
@Injectable()
export class AdminTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly cache: CacheService,
  ) {}

  async mint(admin: AdminDocument): Promise<AdminTokenResult> {
    const adminCfg = this.config.get('admin', { infer: true });
    const jwtCfg = this.config.get('jwt', { infer: true });
    const ttlSeconds = adminCfg.accessTtlHours * 3600;
    const accessToken = await this.jwt.signAsync(
      {
        sub: admin._id.toString(),
        jti: randomUUID(),
        email: admin.email,
        roles: admin.roles,
        ims: Date.now(),
      },
      {
        secret: adminCfg.accessSecret,
        expiresIn: `${adminCfg.accessTtlHours}h`,
        issuer: jwtCfg.issuer,
        audience: adminCfg.jwtAudience,
      },
    );
    return { accessToken, expiresInSeconds: ttlSeconds };
  }

  /** Denylists a jti until the token would have expired anyway. */
  async denylist(jti: string, expSeconds: number): Promise<void> {
    const ttl = Math.max(1, expSeconds - Math.floor(Date.now() / 1000));
    await this.cache.set(AdminTokenService.denylistKey(jti), true, ttl);
  }

  async isDenylisted(jti: string): Promise<boolean> {
    return this.cache.exists(AdminTokenService.denylistKey(jti));
  }

  private static denylistKey(jti: string): string {
    return `admin:denylist:${jti}`;
  }
}
