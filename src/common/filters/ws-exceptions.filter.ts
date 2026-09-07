import { type ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { WS_EVENT } from 'src/modules/chat/chat.types';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Turns an exception thrown in a gateway handler into the *same* error envelope
 * a REST client gets, delivered over the socket's `error` event.
 *
 * The HTTP AllExceptionsFilter is `switchToHttp()`-only, so it never catches a
 * socket exception. This reproduces its `AppException` mapping (code +
 * message + details) for the WS transport; anything unrecognized is a bug and is
 * flattened to INTERNAL_ERROR without leaking its message.
 */
@Catch()
export class WsExceptionsFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger('WsExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();

    let code: ErrorCode | string = ErrorCode.INTERNAL_ERROR;
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof AppException) {
      code = exception.errorCode;
      message = exception.message;
      details = exception.details;
    } else {
      this.logger.error(
        `Unhandled socket exception: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    client.emit(WS_EVENT.ERROR, {
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      timestamp: new Date().toISOString(),
    });
  }
}
