import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Defence-in-depth against NoSQL operator injection.
 *
 * The typed DTO + `forbidNonWhitelisted` ValidationPipe already stops an operator
 * object (`{"$gt": ""}`) from deserializing into a scalar field, so this is a
 * second line, not the only one — but it runs *before* the pipes and covers the
 * gaps a DTO cannot see: query strings, `SchemaTypes.Mixed` fields (payloads,
 * props) that legitimately accept objects, and any handler that reads
 * `req.body`/`req.query` directly. A key beginning with `$` has no legitimate use
 * in a request from a Wishtick client, so the whole request is rejected rather
 * than silently stripped — a stripped payload hides the attempt; a 400 surfaces
 * it (and logs it under a distinct error code).
 *
 * A guard, not middleware, so the throw lands in `AllExceptionsFilter` and the
 * client gets the standard error envelope; it also sidesteps the Express 5
 * read-only `req.query` getter that trips up mutate-in-place sanitizers.
 * Registered as the first global guard, so injection is rejected before auth.
 */
@Injectable()
export class NoSqlInjectionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const offender = firstOperatorKey(req.body) ?? firstOperatorKey(req.query);
    if (offender) {
      throw new AppException(
        ErrorCode.SUSPECT_INPUT_REJECTED,
        'Request contained a disallowed key',
        400,
        { key: offender },
      );
    }
    return true;
  }
}

/** Depth-bounded scan for the first `$`-prefixed key anywhere in the value. */
function firstOperatorKey(value: unknown, depth = 0): string | null {
  // A crafted deeply-nested body must not blow the stack; real request shapes are
  // shallow, so this ceiling never bites a legitimate client.
  if (depth > 12 || value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstOperatorKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) return key;
    const found = firstOperatorKey(child, depth + 1);
    if (found) return found;
  }
  return null;
}
