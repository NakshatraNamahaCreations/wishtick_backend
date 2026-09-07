import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Honours an inbound x-request-id so a trace survives across services, and
 * mints one otherwise. Echoed back on the response so a user can quote it in
 * a support ticket and we can find their exact request in the logs.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const id =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128
        ? inbound
        : randomUUID();
    req.id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
