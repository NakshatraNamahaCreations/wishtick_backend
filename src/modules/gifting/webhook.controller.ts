import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { UserRole } from 'src/common/enums/user-role.enum';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { WebhookService, type NormalizedWebhookEvent, type WebhookResult } from './webhook.service';

@ApiTags('gifting')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  /**
   * Affiliate conversion webhook — the auto-ticking entry point.
   *
   * `@Public()` because a webhook carries no user session; its authorization is
   * the HMAC signature, verified before we read the payload. `@SkipThrottle()`
   * because a provider bursts legitimately and the signature already gates who
   * may call it — throttling verified webhooks would drop real conversions.
   */
  @Post('affiliate/:provider')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async affiliate(
    @Param('provider') provider: string,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Headers('x-webhook-timestamp') timestamp: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<WebhookResult> {
    // rawBody: true (main.ts / test-app.ts) captures the exact received bytes at
    // parse time. HMAC must run over those, not a re-serialized object.
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Expected a raw request body', 400);
    }

    // Verify BEFORE parsing or trusting a single byte.
    this.webhooks.verifySignature(provider, rawBody, signature ?? '', timestamp ?? '');

    let event: NormalizedWebhookEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as NormalizedWebhookEvent;
    } catch {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Webhook body is not valid JSON', 400);
    }
    if (!event.providerEventId || !event.orderRef) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'Webhook is missing providerEventId or orderRef',
        400,
      );
    }

    return this.webhooks.process(provider, event);
  }

  @Get('affiliate/dead-letter')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Signature-valid webhooks that matched no gift (admin)' })
  async deadLetter(): Promise<{ events: unknown[] }> {
    const events = await this.webhooks.listDeadLettered();
    return { events };
  }
}
