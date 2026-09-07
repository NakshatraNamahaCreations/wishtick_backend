import type { UserRole } from 'src/common/enums/user-role.enum';

/** Claims carried by an access token. Keep this small — it rides on every request. */
export interface AccessTokenPayload {
  sub: string;
  /** Session (refresh-token family) id, so an access token can be traced to its device. */
  sid: string;
  jti: string;
  email?: string;
  phone?: string;
  roles: UserRole[];
  /** email verified */
  ev: boolean;
  /** phone verified */
  pv: boolean;
  /**
   * Issued-at in **milliseconds**.
   *
   * Standard `iat` has second granularity, which cannot express the difference
   * between a token minted just before a logout-all and one minted just after
   * the user logged back in — both land on the same second. Comparing that
   * against `tokensInvalidBefore` forces a choice between leaving a revoked
   * token alive for the rest of the second and rejecting the fresh token from a
   * legitimate re-login. This claim removes the ambiguity instead of trading it.
   */
  ims: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds, so clients can schedule a refresh. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface RequestContext {
  userAgent?: string;
  ip?: string;
}

export enum OtpPurpose {
  VERIFY_EMAIL = 'verify_email',
  VERIFY_PHONE = 'verify_phone',
  /**
   * Passwordless sign-in. Kept distinct from VERIFY_PHONE because the codes are
   * salted by purpose: a code issued to verify an existing user's number must
   * never be replayable to mint a session, and vice versa.
   */
  SIGN_IN = 'sign_in',
}
