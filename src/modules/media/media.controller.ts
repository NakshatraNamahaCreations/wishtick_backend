import { Body, Controller, Get, Param, Post, Redirect } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { ConfirmUploadDto, CreateUploadUrlDto } from './dto/media.dto';
import {
  MediaService,
  type MediaLimitsView,
  type MediaView,
  type UploadTicket,
} from './media.service';

/** Issuing URLs is cheap, but an unbounded loop would fill a bucket for free. */
const UPLOAD_URL_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('media')
@Controller('media')
@ApiBearerAuth()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload-url')
  @Throttle(UPLOAD_URL_THROTTLE)
  @ApiOperation({
    summary: 'Get a presigned upload URL',
    description:
      'PUT the file straight to `uploadUrl` with the returned `requiredHeaders`, then call ' +
      '/media/confirm. Bytes never pass through this API.',
  })
  @ApiResponseDoc({ status: 400, description: 'MEDIA_TYPE_NOT_ALLOWED' })
  @ApiResponseDoc({ status: 413, description: 'MEDIA_TOO_LARGE' })
  createUploadUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateUploadUrlDto,
  ): Promise<UploadTicket> {
    return this.media.createUploadUrl(userId, dto);
  }

  @Post('confirm')
  @ApiOperation({
    summary: 'Confirm an upload landed',
    description: 'Verifies the object against storage and returns its permanent URL. Idempotent.',
  })
  @ApiResponseDoc({ status: 409, description: 'MEDIA_NOT_UPLOADED' })
  @ApiResponseDoc({
    status: 413,
    description: 'MEDIA_TOO_LARGE — the real file exceeded the limit',
  })
  confirm(@CurrentUser('id') userId: string, @Body() dto: ConfirmUploadDto): Promise<MediaView> {
    return this.media.confirm(userId, dto.mediaId);
  }

  /**
   * Declared before `:id` on purpose — Nest matches routes in declaration
   * order, so with these the other way round `/media/limits` is read as a
   * request for the media whose id is "limits".
   */
  @Get('limits')
  @ApiOperation({
    summary: 'What may be uploaded, per purpose',
    description:
      'The effective size cap and mime allowlist for each purpose, so a client can refuse ' +
      'an oversized file at the picker rather than after the upload. The cap is the ' +
      "per-purpose rule clamped by this deployment's global MEDIA_MAX_BYTES, which is why " +
      'it cannot be hardcoded in the app.',
  })
  limits(): MediaLimitsView {
    return this.media.limits();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one media, refreshing a transcode in progress',
    description:
      'Poll this while `status` is `processing` to learn when a clip becomes playable. ' +
      'Each call also asks the transcoder where it has got to, so the state is never stale.',
  })
  @ApiResponseDoc({ status: 404, description: 'MEDIA_NOT_FOUND' })
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<MediaView> {
    return this.media.viewOwned(userId, id);
  }

  /**
   * Redirects to a freshly signed playback URL.
   *
   * Public and unguessable-by-id rather than authenticated, because this is
   * what a video player fetches: `video_player` follows the redirect but sends
   * no Authorization header, and a 401 here would simply read as a broken
   * video. The signed URL it lands on is short-lived, which is the control.
   */
  @Get(':id/play')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Redirect to a signed, expiring playback URL',
    description:
      'The stable link stored on a memory or a wishlist. Signed URLs expire, so this ' +
      'mints a new one per play rather than persisting one that would go stale.',
  })
  async play(@Param('id') id: string): Promise<{ url: string; statusCode: number }> {
    return { url: await this.media.playbackUrl(id), statusCode: 302 };
  }
}
