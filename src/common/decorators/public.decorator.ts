import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of the globally-applied JwtAuthGuard.
 * Auth is deny-by-default: forgetting this decorator makes a route private,
 * which fails safe. Forgetting a guard would not.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
