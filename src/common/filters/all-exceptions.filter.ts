import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
// Mongoose's own re-export, NOT the `mongodb` package directly.
//
// `mongodb` is not a declared dependency here — it only appears at the top of
// node_modules because a dev dependency (mongodb-memory-server) drags in its
// own copy, and npm pins Mongoose to a different one. Importing from 'mongodb'
// therefore yields a DIFFERENT MongoServerError class than the one Mongoose
// actually throws, so `instanceof` silently never matches in dev and tests, and
// a duplicate-key race would 500 instead of 409. Going through Mongoose
// guarantees the same copy in every environment.
import { Error as MongooseError, mongo } from 'mongoose';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

interface ErrorBody {
  success: false;
  error: {
    code: ErrorCode | string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, code, message, details } = this.normalize(exception);

    const body: ErrorBody = {
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      requestId: req.id as string | undefined,
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    };

    // 5xx means we broke something — log the stack. 4xx is the client's problem
    // and logging stacks for every bad password would drown the logs.
    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.originalUrl} → ${status} ${code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug(`${req.method} ${req.originalUrl} → ${status} ${code}: ${message}`);
    }

    res.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: ErrorCode | string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.errorCode,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests. Please slow down and try again shortly.',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      // ValidationPipe failures arrive as { message: string[], error, statusCode }.
      if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        if (Array.isArray(r.message)) {
          return {
            status,
            code: ErrorCode.VALIDATION_FAILED,
            message: 'Request validation failed',
            details: { fields: r.message },
          };
        }
        if (typeof r.errorCode === 'string') {
          return {
            status,
            code: r.errorCode,
            message: typeof r.message === 'string' ? r.message : exception.message,
            details: r.details,
          };
        }
      }

      return {
        status,
        code: this.statusToCode(status),
        message: exception.message,
      };
    }

    // Duplicate key on a unique index. Reached only when a race beats our
    // pre-check; the index is the real guarantee, this just makes it readable.
    if (exception instanceof mongo.MongoServerError && exception.code === 11000) {
      const field = Object.keys((exception.keyPattern ?? {}) as Record<string, unknown>)[0];
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: field ? `A record with this ${field} already exists` : 'Duplicate record',
      };
    }

    if (exception instanceof MongooseError.ValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Request validation failed',
        details: { fields: Object.keys(exception.errors) },
      };
    }

    if (exception instanceof MongooseError.CastError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ErrorCode.VALIDATION_FAILED,
        message: `Invalid value for ${exception.path}`,
      };
    }

    // Anything unrecognized is a bug. Never leak its message to the client.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
    };
  }

  /** Last resort for HttpExceptions thrown by Nest itself rather than by us. */
  private statusToCode(status: number): ErrorCode | string {
    return STATUS_TO_CODE[status] ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : `HTTP_${status}`);
  }
}
