import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../enums/user-role.enum';

export const ROLES_KEY = 'roles';

/** Requires the caller to hold at least one of the listed roles. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
