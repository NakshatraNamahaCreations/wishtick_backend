import { HttpException } from '@nestjs/common';
import type { ErrorCode } from './error-codes';

/**
 * The only exception type application code should throw. Carrying the ErrorCode
 * on the exception is what lets the global filter emit a stable `errorCode` in
 * every 4xx/5xx body without a status→code lookup table.
 */
export class AppException extends HttpException {
  constructor(
    readonly errorCode: ErrorCode,
    message: string,
    status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super({ errorCode, message, details }, status);
  }
}
