import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CourierWebhookService, type CourierWebhookResult } from './courier-webhook.service';
import { CourierWebhookDto } from './dto/courier-webhook.dto';

@ApiTags('orders')
@Controller('webhooks')
export class CourierWebhookController {
  constructor(private readonly webhooks: CourierWebhookService) {}

  /**
   * Carrier status feed. Unused until a logistics contract exists — see
   * CourierWebhookService for why it is here anyway.
   *
   * `@Public()` because a webhook carries no session; its authorization is the
   * HMAC. `@SkipThrottle()` because carriers burst legitimately and the
   * signature already decides who may call — throttling verified events would
   * drop real deliveries.
   */
  @Post('courier/:provider')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async courier(
    @Param('provider') provider: string,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Headers('x-webhook-timestamp') timestamp: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Body() dto: CourierWebhookDto,
  ): Promise<CourierWebhookResult> {
    // rawBody captures the exact received bytes; the HMAC must run over those,
    // not a re-serialized object, or every real webhook fails on a re-encode.
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Expected a raw request body', 400);
    }
    if (!signature || !timestamp) {
      throw new AppException(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
        'Missing webhook signature or timestamp',
        401,
      );
    }

    this.webhooks.verifySignature(provider, rawBody, signature, timestamp);
    return this.webhooks.apply(provider, dto);
  }
}
