import { Controller, Get, Param, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { Public } from 'src/common/decorators/public.decorator';
import { LocalStorageAdapter } from 'src/infra/storage/adapters/local-storage.adapter';

/**
 * Receives and serves the local storage driver's uploads. This stands in for S3
 * in dev and tests, so it is hidden from the public API docs — a client should
 * never code against it, only follow the `uploadUrl` it is handed.
 *
 * Public by design: the presigned signature *is* the authorization, exactly as
 * with S3. A bearer token is not available to a raw PUT from a browser.
 * MediaModule only mounts this controller when STORAGE_DRIVER=local, and
 * StorageModule refuses that driver in production.
 */
@ApiExcludeController()
@Controller('media/local')
@Public()
@SkipThrottle()
export class LocalUploadController {
  constructor(private readonly local: LocalStorageAdapter) {}

  @Put('*path')
  async upload(
    @Param('path') pathParam: string | string[],
    @Query('contentType') contentType: string,
    @Query('maxBytes') maxBytes: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Req() req: Request,
  ): Promise<{ ok: true; storageKey: string }> {
    const storageKey = LocalUploadController.joinPath(pathParam);

    // express.raw() (see MediaModule) leaves the body as a Buffer here.
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Expected a raw binary body', 400);
    }

    await this.local.acceptUpload({
      storageKey,
      contentType,
      maxBytes: Number(maxBytes),
      expiresAtMs: Number(expires),
      signature: signature ?? '',
      body,
    });

    return { ok: true, storageKey };
  }

  @Get('*path')
  async serve(@Param('path') pathParam: string | string[], @Res() res: Response): Promise<void> {
    const stored = await this.local.read(LocalUploadController.joinPath(pathParam));
    if (!stored) {
      throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'File not found', 404);
    }

    // nosniff matters even here: it is what stops a browser from re-interpreting
    // a file we typed as an image and executing it as something else.
    res.setHeader('Content-Type', stored.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(stored.body);
  }

  /** Nest hands a wildcard segment back as an array. */
  private static joinPath(param: string | string[]): string {
    return Array.isArray(param) ? param.join('/') : param;
  }
}
