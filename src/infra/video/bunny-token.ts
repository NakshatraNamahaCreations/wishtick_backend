import { createHmac } from 'node:crypto';

/**
 * Bunny CDN "advanced" token authentication.
 *
 *   message = signaturePath + expires + signingData + userIp
 *   token   = "HS256-" + base64url(HMAC-SHA256(securityKey, message))
 *
 * Two URL shapes carry it, and which one you need is not a style choice:
 *
 * - **query** — `?token=…&expires=…`, authorizing exactly one file.
 * - **directory** — `/bcdn_token=…&expires=…/path`, authorizing everything
 *   under a prefix.
 *
 * HLS requires the directory form. A player fetches `playlist.m3u8` and then
 * requests each segment as its own URL; those requests carry no query string,
 * so a query token authorizes the playlist and nothing it points at — the
 * video would 403 the instant playback actually started.
 */
export function signBunnyPath(input: {
  securityKey: string;
  /** Path being authorized, leading slash included, e.g. `/abc-guid/`. */
  path: string;
  expiresAt: number;
  /** Optional client IP to pin the token to. */
  userIp?: string;
}): { token: string; expires: number } {
  const { securityKey, path, expiresAt, userIp = '' } = input;

  // No query parameters are signed: nothing we issue carries any, and an
  // unsorted or unexpected parameter is the usual cause of a token that
  // validates locally and 403s at the edge.
  const message = `${path}${expiresAt}${''}${userIp}`;

  const token = createHmac('sha256', securityKey).update(message).digest('base64url');

  return { token: `HS256-${token}`, expires: expiresAt };
}

/**
 * Builds a directory-token URL: the token sits in the path, so every sibling
 * file — every HLS segment — is covered by the same signature.
 */
export function signedDirectoryUrl(input: {
  securityKey: string;
  hostname: string;
  /** Directory to authorize, no leading or trailing slash, e.g. the video id. */
  directory: string;
  /** File inside it, e.g. `playlist.m3u8`. */
  file: string;
  ttlSeconds: number;
  now?: Date;
}): string {
  const { securityKey, hostname, directory, file, ttlSeconds } = input;
  const expiresAt = Math.floor((input.now ?? new Date()).getTime() / 1000) + ttlSeconds;

  // The trailing slash matters: this authorizes the directory's *contents*.
  const { token, expires } = signBunnyPath({
    securityKey,
    path: `/${directory}/`,
    expiresAt,
  });

  return `https://${hostname}/bcdn_token=${token}&expires=${expires}/${directory}/${file}`;
}
