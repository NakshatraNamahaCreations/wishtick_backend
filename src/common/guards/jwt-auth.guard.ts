import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { TokenExpiredError } from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser, info: unknown): TUser {
    // JwtStrategy.validate() throws AppException for revoked/suspended/deleted;
    // those must reach the client with their own code, not be flattened to 401.
    if (err instanceof Error) throw err;
    if (err) {
      throw new AppException(ErrorCode.UNAUTHENTICATED, 'Authentication failed', 401);
    }

    if (!user) {
      // Distinguishing "expired" from "invalid" lets clients refresh instead of
      // bouncing the user to the login screen on a routine 15-minute lapse.
      if (info instanceof TokenExpiredError) {
        throw new AppException(ErrorCode.TOKEN_EXPIRED, 'Access token has expired', 401);
      }
      throw new AppException(ErrorCode.UNAUTHENTICATED, 'Authentication required', 401);
    }
    return user;
  }
}
