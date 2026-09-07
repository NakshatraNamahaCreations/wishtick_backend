import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Injects the authenticated user, or one of its fields:
 *   @CurrentUser() user: AuthenticatedUser
 *   @CurrentUser('id') userId: string
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
