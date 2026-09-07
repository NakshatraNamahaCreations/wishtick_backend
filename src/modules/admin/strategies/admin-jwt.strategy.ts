import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { AdminTokenService } from '../admin-token.service';
import { AdminService } from '../admin.service';
import { permissionsFor, type AdminTokenPayload, type AuthenticatedAdmin } from '../admin.types';

/**
 * The admin-token validator — a SEPARATE passport strategy from the user 'jwt'
 * one, keyed to the admin secret and audience. Passport rejects a wrong `aud`
 * before validate() runs, so a user token cannot reach here. Beyond the
 * signature it re-checks denylist, admin status, the logout-all cutoff, and the
 * per-admin IP allowlist — the same defence-in-depth the user strategy applies.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly admins: AdminService,
    private readonly tokens: AdminTokenService,
  ) {
    const adminCfg = config.get('admin', { infer: true });
    const jwtCfg = config.get('jwt', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: adminCfg.accessSecret,
      issuer: jwtCfg.issuer,
      audience: adminCfg.jwtAudience,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: AdminTokenPayload): Promise<AuthenticatedAdmin> {
    if (await this.tokens.isDenylisted(payload.jti)) {
      throw new AppException(ErrorCode.ADMIN_UNAUTHENTICATED, 'This session has ended', 401);
    }
    const admin = await this.admins.findActive(payload.sub);
    if (admin.tokensInvalidBefore && payload.ims < admin.tokensInvalidBefore.getTime()) {
      throw new AppException(ErrorCode.ADMIN_UNAUTHENTICATED, 'This session has ended', 401);
    }
    this.admins.assertIpAllowed(admin, req.ip ?? null);
    return {
      id: admin._id.toString(),
      email: admin.email,
      roles: admin.roles,
      permissions: permissionsFor(admin.roles),
      jti: payload.jti,
    };
  }
}
