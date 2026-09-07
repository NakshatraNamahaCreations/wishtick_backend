import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { Error as MongooseError, mongo } from 'mongoose';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

interface CapturedResponse {
  status: number;
  body: { success: boolean; error: { code: string; message: string; details?: unknown } };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  /** Minimal ArgumentsHost that records what the filter wrote. */
  const capture = (exception: unknown): CapturedResponse => {
    const captured = { status: 0, body: undefined as unknown } as {
      status: number;
      body: CapturedResponse['body'];
    };

    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: CapturedResponse['body']) {
        captured.body = body;
        return this;
      },
    };

    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/auth/signup', id: 'req-1' }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);
    return captured;
  };

  it('maps an AppException to its own code and status', () => {
    const res = capture(new AppException(ErrorCode.OTP_INVALID, 'Incorrect code', 400));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.OTP_INVALID);
  });

  /**
   * This is the regression guard for a duplicate-`mongodb` bug.
   *
   * `mongodb` is not a declared dependency: it only sits at the top of
   * node_modules because mongodb-memory-server (a dev dependency) brings its own
   * copy, while npm pins Mongoose to a different one. A filter that imported
   * MongoServerError from 'mongodb' would compare against a DIFFERENT class than
   * the one Mongoose throws, so this instanceof check silently failed and a
   * duplicate-key race returned 500 INTERNAL_ERROR instead of 409 CONFLICT.
   *
   * The error is constructed from `mongoose.mongo` on purpose — that is the copy
   * a real duplicate key arrives from.
   */
  it('maps a Mongo duplicate-key error to 409 CONFLICT', () => {
    const err = new mongo.MongoServerError({ message: 'E11000 duplicate key error' });
    err.code = 11000;
    (err as unknown as { keyPattern: Record<string, number> }).keyPattern = { email: 1 };

    const res = capture(err);

    expect(res.status).toBe(HttpStatus.CONFLICT);
    expect(res.body.error.code).toBe(ErrorCode.CONFLICT);
    // Names the offending field so the message is actionable.
    expect(res.body.error.message).toContain('email');
  });

  it('does not leak an unexpected error to the client', () => {
    const res = capture(new Error('connection string contains a password'));
    expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(res.body.error.message).toBe('An unexpected error occurred');
  });

  it('maps a Mongoose CastError to a 400 naming the field', () => {
    // Same duplicate-copy hazard as MongoServerError: this must be Mongoose's
    // own CastError, which is what a malformed ObjectId actually throws.
    const err = new MongooseError.CastError('ObjectId', 'not-an-id', 'userId');
    const res = capture(err);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(res.body.error.message).toContain('userId');
  });
});
