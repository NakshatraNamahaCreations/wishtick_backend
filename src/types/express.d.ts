import type { AuthenticatedUser } from 'src/common/types/authenticated-user';

declare global {
  namespace Express {
    // Passport declares `Request.user` as `Express.User`; this makes it our shape.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthenticatedUser {}

    interface Request {
      /** Set by RequestIdMiddleware; also consumed by pino-http for log correlation. */
      id?: string;
    }
  }
}

export {};
