import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { from, of, tap, type Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import { CacheService } from 'src/infra/redis/cache.service';
import { IDEMPOTENT_KEY } from './idempotent.decorator';

interface StoredResult {
  status: 'done' | 'in_flight';
  /** Hash of the request body, so the same key with a different body is caught. */
  fingerprint: string;
  body?: unknown;
}

/** How long a completed result is replayable. */
const RESULT_TTL_SECONDS = 24 * 60 * 60;
/** A crashed in-flight marker self-heals after this, so a key is never wedged. */
const IN_FLIGHT_TTL_SECONDS = 60;

/**
 * Makes a mutating endpoint safe to retry.
 *
 * On a route marked `@Idempotent()`:
 *  - the `Idempotency-Key` header is required;
 *  - the first request runs and its response is cached under the key for 24h;
 *  - a retry with the same key returns that cached response without re-running —
 *    so a reserve that timed out on the client is replayed, never re-executed.
 *
 * Two subtleties the naive version gets wrong:
 *
 *  - **In-flight collision.** Two requests with the same key arriving at once
 *    (a double-tap) must not both execute. The first claims the key with an
 *    `in_flight` marker via SET NX; the second sees it and 409s rather than
 *    racing into the critical section.
 *
 *  - **Key reuse with a different body.** An idempotency key is a promise that
 *    "this is the same operation". Reusing it for a different payload is a
 *    client bug, and silently replaying the old result would hide it — so the
 *    body is fingerprinted and a mismatch is rejected.
 *
 * Keyed per user, so one client's key cannot collide with or read another's.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isIdempotent) return next.handle();

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const rawKey = req.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    if (!key || key.length < 8 || key.length > 200) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'This request requires an Idempotency-Key header (8–200 chars)',
        400,
      );
    }

    const userId = req.user?.id ?? 'anon';
    const cacheKey = `idempotency:${userId}:${key}`;
    const fingerprint = IdempotencyInterceptor.fingerprint(req.body);

    return from(this.claim(cacheKey, fingerprint)).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new AppException(
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
              'This Idempotency-Key was already used for a different request',
              422,
            );
          }
          if (existing.status === 'in_flight') {
            // The original is still running. Tell the client to back off rather
            // than run a second copy of a money-adjacent operation.
            throw new AppException(
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
              'A request with this Idempotency-Key is already in progress',
              409,
            );
          }
          return of(existing.body);
        }

        // We hold the claim. Run the handler, then store its result.
        return next.handle().pipe(
          tap({
            next: (body) => {
              void this.store(cacheKey, { status: 'done', fingerprint, body });
            },
            error: () => {
              // Release the claim on failure so the client can genuinely retry.
              // Caching an error would make a transient failure permanent.
              void this.cache.del(cacheKey);
            },
          }),
        );
      }),
    );
  }

  /**
   * Atomically claims the key, or returns the existing record.
   *
   * SET NX is the whole game: exactly one concurrent caller wins the write and
   * proceeds; everyone else reads back what is already there.
   */
  private async claim(cacheKey: string, fingerprint: string): Promise<StoredResult | null> {
    const marker: StoredResult = { status: 'in_flight', fingerprint };
    const won = await this.cache.client.set(
      cacheKey,
      JSON.stringify(marker),
      'EX',
      IN_FLIGHT_TTL_SECONDS,
      'NX',
    );
    if (won === 'OK') return null;

    const raw = await this.cache.client.get(cacheKey);
    if (!raw) return null; // expired between our NX and GET; treat as free
    return JSON.parse(raw) as StoredResult;
  }

  private async store(cacheKey: string, result: StoredResult): Promise<void> {
    try {
      await this.cache.set(cacheKey, result, RESULT_TTL_SECONDS);
    } catch (err) {
      this.logger.error(
        `Failed to cache idempotent result for ${cacheKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private static fingerprint(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}))
      .digest('hex')
      .slice(0, 32);
  }
}
