import { type ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Authenticates when a token is present, and lets the request through when it
 * is not.
 *
 * For endpoints that serve both signed-in users and anonymous visitors — the
 * affiliate redirect is the first: it is reachable from a public share link, so
 * it cannot require a token, but the owner of a *private* wishlist clicking
 * their own item must still be recognized. Marking such a route `@Public()`
 * alone skips the guard entirely, `request.user` is never populated, and the
 * owner is anonymous to their own list — a 404 on their own link.
 *
 * The route still needs `@Public()` to opt out of the global JwtAuthGuard; this
 * guard is then applied explicitly on top.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // An absent, expired, or revoked token means "anonymous", not "denied".
      // Authorization is still the endpoint's own job.
    }
    return true;
  }

  handleRequest<TUser>(_err: unknown, user: TUser): TUser {
    // Never throws: a bad token degrades to anonymous rather than rejecting.
    return user;
  }
}
