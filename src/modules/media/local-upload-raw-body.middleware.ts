import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { raw } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from 'src/config/configuration';

/**
 * Feeds the raw request body to the local upload endpoint, and only to it.
 *
 * Scoping this by URL at runtime rather than via `forRoutes('media/local/*')`
 * is deliberate: MiddlewareConsumer paths are matched against the global prefix
 * but NOT the URI version segment, so a path-scoped rule silently registers for
 * `/api/media/local/...` while the real route is `/api/v1/media/local/...`. The
 * middleware then never runs, the body is never a Buffer, and every upload 400s.
 *
 * Registering globally and filtering here cannot drift from the route, and the
 * guard keeps every other endpoint on the normal JSON parser — a blanket raw
 * parser would make the whole API accept arbitrary blobs.
 */
@Injectable()
export class LocalUploadRawBodyMiddleware implements NestMiddleware {
  private readonly handler: RequestHandler;

  constructor(config: ConfigService<AppConfig, true>) {
    this.handler = raw({
      type: () => true,
      limit: config.get('storage.maxBytes', { infer: true }),
    });
  }

  use(req: Request, res: Response, next: NextFunction): void {
    // originalUrl, NOT req.path: Nest mounts this middleware under the global
    // prefix, and Express strips the mount path, so req.path is "/" here for
    // every request. Matching on it silently never fires.
    const isLocalUpload = req.method === 'PUT' && /\/media\/local\//.test(req.originalUrl);
    if (!isLocalUpload) return next();
    this.handler(req, res, next);
  }
}
