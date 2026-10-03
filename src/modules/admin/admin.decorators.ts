import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { AdminPermission, AuthenticatedAdmin } from './admin.types';

export const REQUIRE_PERMISSION_KEY = 'requireAdminPermission';
export const ALLOW_WITHOUT_TOTP_KEY = 'allowAdminWithoutTotp';

/** Gate a route on a permission; AdminGuard reads this and checks the admin's set. */
export const RequirePermission = (permission: AdminPermission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);

/**
 * Reachable before two-factor sign-in is set up: only what it takes to set it
 * up (and to see who you are, or leave). Everything else refuses such an admin.
 */
export const AllowWithoutTotp = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WITHOUT_TOTP_KEY, true);

/** The authenticated admin (or one of its fields) off the request. */
export const CurrentAdmin = createParamDecorator(
  (field: keyof AuthenticatedAdmin | undefined, ctx: ExecutionContext) => {
    const admin = ctx.switchToHttp().getRequest<{ user?: AuthenticatedAdmin }>().user;
    return field ? admin?.[field] : admin;
  },
);
