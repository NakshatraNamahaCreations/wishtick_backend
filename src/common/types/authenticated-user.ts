import type { UserRole } from '../enums/user-role.enum';

/** What JwtStrategy.validate() attaches to `request.user`. */
export interface AuthenticatedUser {
  id: string;
  email?: string;
  phone?: string;
  roles: UserRole[];
  emailVerified: boolean;
  phoneVerified: boolean;
  /** Access-token id — needed to denylist exactly this token on logout. */
  jti: string;
  /** Refresh-token family this access token descends from. */
  sessionId: string;
}
