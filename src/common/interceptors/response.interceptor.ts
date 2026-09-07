import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import type { Request } from 'express';
import { map, type Observable } from 'rxjs';

export interface ApiResponse<T> {
  success: true;
  data: T;
  requestId?: string;
  timestamp: string;
}

/**
 * Wraps every successful response so clients see one shape for success and one
 * for failure. Paginated endpoints return `{items, nextCursor}` as their `data`.
 *
 * **Except file downloads.** A [StreamableFile] is the response body, not a
 * payload to describe: wrapping one serialises the stream object itself, so the
 * client receives JSON describing a buffer instead of the file. The guest-list
 * export (`4096:206`) is the first such endpoint; any future one is covered
 * automatically.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    const req = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      map((data) =>
        data instanceof StreamableFile
          ? data
          : {
              success: true as const,
              data,
              requestId: req.id as string | undefined,
              timestamp: new Date().toISOString(),
            },
      ),
    );
  }
}
