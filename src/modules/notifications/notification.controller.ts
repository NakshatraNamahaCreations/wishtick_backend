import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import {
  RegisterDeviceDto,
  UpdatePreferenceDto,
  UnsubscribeQueryDto,
} from './dto/notification.dto';
import { DeviceTokenService } from './device-token.service';
import { NotificationService } from './notification.service';
import { NotificationChannel } from './notification.types';
import {
  toNotificationView,
  toPreferenceView,
  type NotificationView,
  type PreferenceView,
} from './notification.views';

@ApiTags('notifications')
@Controller()
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly devices: DeviceTokenService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Post('me/devices')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register this install for push',
    description:
      'Upserts on the token, not on (user, token): a handset handed to a second account keeps ' +
      'the same FCM token, and a second row would deliver one person’s notifications to ' +
      'the other.',
  })
  registerDevice(
    @CurrentUser('id') userId: string,
    @Body() dto: RegisterDeviceDto,
  ): Promise<{ id: string }> {
    return this.devices.register(userId, dto);
  }

  @Delete('me/devices/:token')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Drop this install’s push token — what sign-out calls',
    description:
      'Scoped to the caller: a token is a delivery address, and unregistering an arbitrary one ' +
      'would be a way to silence someone else.',
  })
  unregisterDevice(
    @CurrentUser('id') userId: string,
    @Param('token') token: string,
  ): Promise<void> {
    return this.devices.unregister(userId, token);
  }

  @Get('notifications')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Your in-app notifications (newest first)' })
  async list(@CurrentUser('id') userId: string): Promise<NotificationView[]> {
    const rows = await this.notifications.list(userId);
    return rows.map(toNotificationView);
  }

  @Post('notifications/read-all')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every notification read' })
  markAllRead(@CurrentUser('id') userId: string): Promise<{ updated: number }> {
    return this.notifications.markAllRead(userId);
  }

  @Get('notifications/preferences')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Your notification preferences' })
  async getPreferences(@CurrentUser('id') userId: string): Promise<PreferenceView> {
    return toPreferenceView(await this.notifications.getOrCreatePreference(userId));
  }

  @Patch('notifications/preferences')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update channels, quiet hours, timezone, thank-you auto-send' })
  async updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdatePreferenceDto,
  ): Promise<PreferenceView> {
    return toPreferenceView(await this.notifications.updatePreference(userId, dto));
  }

  @Post('notifications/:id/read')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one notification read' })
  async markRead(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.notifications.markRead(userId, id);
    return { ok: true };
  }

  @Get('notifications/unsubscribe/:token')
  @Public()
  @SkipThrottle()
  @ApiOperation({ summary: 'One-click unsubscribe from an email category (from the email footer)' })
  async unsubscribe(
    @Param('token') token: string,
    @Query() query: UnsubscribeQueryDto,
  ): Promise<{ unsubscribed: string }> {
    await this.notifications.unsubscribeByToken(token, query.category);
    return { unsubscribed: query.category };
  }

  /**
   * Simplified bounce/complaint webhook: an authenticated POST { type, email }.
   * Real SES/SNS signature verification is a follow-up; the shared-secret header
   * is enough to keep this internal endpoint honest today. A bounced address is
   * suppressed so no future email is attempted to it.
   */
  @Post('webhooks/notifications/bounce')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async bounce(
    @Headers('x-bounce-secret') secret: string | undefined,
    @Body() body: { type?: string; email?: string },
  ): Promise<{ suppressed: boolean }> {
    const expected = this.config.get('notifications.bounceWebhookSecret', { infer: true });
    if (!expected || !NotificationController.safeEqual(secret ?? '', expected)) {
      throw new AppException(ErrorCode.BOUNCE_SIGNATURE_INVALID, 'Invalid webhook secret', 401);
    }
    if (!body.email) return { suppressed: false };
    await this.notifications.suppress(NotificationChannel.EMAIL, body.email);
    return { suppressed: true };
  }

  private static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
