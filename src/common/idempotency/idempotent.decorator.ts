import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a route as requiring an `Idempotency-Key` header, handled by
 * IdempotencyInterceptor.
 *
 * Retries are a client's right, not a bug: a gifter whose "reserve" request
 * times out will tap again, and without this that second tap could double-book
 * or 409 them off their own reservation. The key makes the retry return the
 * first response verbatim.
 */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, true);
