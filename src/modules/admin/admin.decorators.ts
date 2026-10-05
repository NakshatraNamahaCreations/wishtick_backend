import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { AdminPermission, AuthenticatedAdmin } from './admin.types';

export const REQUIRE_PERMISSION_KEY = 'requireAdminPermission';

/** Gate a route on a permission; AdminGuard reads this and checks the admin's set. */
export const RequirePermission = (permission: AdminPermission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);

/** The authenticated admin (or one of its fields) off the request. */
export const CurrentAdmin = createParamDecorator(
  (field: keyof AuthenticatedAdmin | undefined, ctx: ExecutionContext) => {
    const admin = ctx.switchToHttp().getRequest<{ user?: AuthenticatedAdmin }>().user;
    return field ? admin?.[field] : admin;
  },
);
