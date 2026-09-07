import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { UserRole } from '../enums/user-role.enum';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AuthenticatedUser } from '../types/authenticated-user';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) {
      throw new AppException(ErrorCode.UNAUTHENTICATED, 'Authentication required', 401);
    }
    if (!required.some((role) => user.roles.includes(role))) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'You do not have permission to perform this action',
        403,
      );
    }
    return true;
  }
}
