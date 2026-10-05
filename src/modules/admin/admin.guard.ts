import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { REQUIRE_PERMISSION_KEY } from './admin.decorators';
import type { AdminPermission, AuthenticatedAdmin } from './admin.types';

/**
 * The one guard on every `/admin` route. Runs the admin-jwt strategy (which
 * enforces the distinct audience, denylist, status, and IP allowlist), then, if
 * the route declared `@RequirePermission(...)`, checks the admin holds it.
 *
 * Admin controllers are `@Public()` so the GLOBAL user JwtAuthGuard skips them —
 * this guard is the sole gate, and it only accepts an admin-audience token.
 */
@Injectable()
export class AdminGuard extends AuthGuard('admin-jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;

    const required = this.reflector.getAllAndOverride<AdminPermission | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const admin = context.switchToHttp().getRequest<{ user?: AuthenticatedAdmin }>().user;
    if (!admin || !admin.permissions.includes(required)) {
      throw new AppException(
        ErrorCode.ADMIN_FORBIDDEN,
        'You do not have permission for this action',
        403,
      );
    }
    return true;
  }

  handleRequest<TAdmin = AuthenticatedAdmin>(err: unknown, admin: TAdmin): TAdmin {
    // Re-throw the strategy's AppException (denylist / disabled / IP) verbatim,
    // so it reaches the client with its own code rather than a flat 401.
    if (err instanceof Error) throw err;
    if (err || !admin) {
      throw new AppException(ErrorCode.ADMIN_UNAUTHENTICATED, 'Admin authentication required', 401);
    }
    return admin;
  }
}
