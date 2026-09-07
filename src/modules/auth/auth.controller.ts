import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import { AuthService, type AuthUserView, type SessionView } from './auth.service';
import type { RequestContext, TokenPair } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RequestOtpLoginDto, VerifyOtpLoginDto } from './dto/otp-login.dto';
import { SignupDto } from './dto/signup.dto';
import { RefreshTokenDto } from './dto/token.dto';
import {
  ConfirmEmailVerificationDto,
  ConfirmPhoneVerificationDto,
  ForgotPasswordDto,
  RequestEmailVerificationDto,
  RequestPhoneVerificationDto,
  ResetPasswordDto,
} from './dto/verification.dto';

/**
 * Throttle buckets are per-route and deliberately tighter than the global
 * default. These endpoints are where an attacker spends their time, and the
 * OTP/reset ones also cost real money per request.
 *
 * The `default` key is load-bearing: @Throttle takes a record keyed by
 * *configured throttler name*, and ThrottlerGuard only reads metadata under the
 * names registered in ThrottlerModule. A key that matches no registered
 * throttler (e.g. `auth`) is not an error — it is silently ignored, and the
 * route quietly keeps the global limit. Renaming the throttler in AppModule
 * without renaming it here would disable every limit below.
 */
const LOGIN_THROTTLE = { default: { limit: 5, ttl: 60_000 } };
const SIGNUP_THROTTLE = { default: { limit: 5, ttl: 3_600_000 } };
/** Sending a code costs a real SMS/email, so requests are capped hard. */
const OTP_REQUEST_THROTTLE = { default: { limit: 3, ttl: 300_000 } };
/**
 * Checking a code is free, so this bucket only stops crude flooding. It must
 * stay comfortably ABOVE OTP_MAX_ATTEMPTS (5): if the HTTP throttle bit first,
 * the per-code attempt counter could never reach its limit and the code would
 * never be burned — the throttle would mask the stronger control rather than
 * add to it.
 */
const OTP_CONFIRM_THROTTLE = { default: { limit: 10, ttl: 300_000 } };
const RESET_THROTTLE = { default: { limit: 3, ttl: 900_000 } };
const REFRESH_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ── Registration & session ─────────────────────────────────────────────────

  @Post('signup')
  @Public()
  @Throttle(SIGNUP_THROTTLE)
  @ApiOperation({ summary: 'Create an account with an email or phone number' })
  @ApiResponseDoc({ status: 201, description: 'Account created; verification code sent' })
  @ApiResponseDoc({
    status: 409,
    description: 'EMAIL_ALREADY_REGISTERED / PHONE_ALREADY_REGISTERED',
  })
  signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
  ): Promise<{ user: AuthUserView; tokens: TokenPair }> {
    return this.auth.signup(dto, AuthController.contextOf(req));
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(LOGIN_THROTTLE)
  @ApiOperation({ summary: 'Log in with an email or phone number' })
  @ApiResponseDoc({ status: 401, description: 'INVALID_CREDENTIALS' })
  @ApiResponseDoc({ status: 429, description: 'RATE_LIMITED' })
  login(
    @Body() dto: LoginDto,
    @Req() req: Request,
  ): Promise<{ user: AuthUserView; tokens: TokenPair }> {
    return this.auth.login(dto, AuthController.contextOf(req));
  }

  // ── Passwordless phone sign-in ─────────────────────────────────────────────

  @Post('otp/request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(OTP_REQUEST_THROTTLE)
  @ApiOperation({
    summary: 'Send a sign-in code by SMS, whether or not the number is registered',
  })
  @ApiResponseDoc({ status: 202, description: 'Code sent' })
  @ApiResponseDoc({ status: 429, description: 'OTP_COOLDOWN' })
  requestOtpLogin(
    @Body() dto: RequestOtpLoginDto,
  ): Promise<{ expiresInSeconds: number; devCode?: string }> {
    return this.auth.requestOtpLogin(dto.phone);
  }

  @Post('otp/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(OTP_CONFIRM_THROTTLE)
  @ApiOperation({
    summary: 'Exchange a sign-in code for a session, creating the account if new',
  })
  @ApiResponseDoc({ status: 400, description: 'OTP_INVALID / OTP_EXPIRED' })
  @ApiResponseDoc({ status: 429, description: 'OTP_MAX_ATTEMPTS' })
  verifyOtpLogin(
    @Body() dto: VerifyOtpLoginDto,
    @Req() req: Request,
  ): Promise<{ user: AuthUserView; tokens: TokenPair; isNewUser: boolean }> {
    return this.auth.verifyOtpLogin(dto, AuthController.contextOf(req));
  }

  // ── Session ────────────────────────────────────────────────────────────────

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(REFRESH_THROTTLE)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  @ApiResponseDoc({
    status: 401,
    description: 'TOKEN_EXPIRED / TOKEN_INVALID / TOKEN_REVOKED / REFRESH_TOKEN_REUSED',
  })
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken, AuthController.contextOf(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End the current session' })
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    await this.auth.logout(user, AuthController.accessTokenExp(req));
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End every session on every device' })
  logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<{ sessionsRevoked: number }> {
    return this.auth.logoutAll(user);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated user' })
  me(@CurrentUser('id') userId: string): Promise<AuthUserView> {
    return this.auth.getMe(userId);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions (one per device)' })
  sessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionView[]> {
    return this.auth.listSessions(user);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one session' })
  @ApiResponseDoc({ status: 404, description: 'SESSION_NOT_FOUND' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
  ): Promise<void> {
    await this.auth.revokeSession(user, sessionId);
  }

  // ── Verification ───────────────────────────────────────────────────────────

  @Post('verify/email/request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(OTP_REQUEST_THROTTLE)
  @ApiOperation({ summary: 'Send an email verification code' })
  async requestEmailVerification(
    @Body() dto: RequestEmailVerificationDto,
  ): Promise<{ message: string }> {
    await this.auth.requestEmailVerification(dto.email);
    return { message: 'If that email is registered, a verification code has been sent.' };
  }

  @Post('verify/email/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(OTP_CONFIRM_THROTTLE)
  @ApiOperation({ summary: 'Confirm an email verification code' })
  @ApiResponseDoc({ status: 400, description: 'OTP_INVALID / OTP_EXPIRED' })
  @ApiResponseDoc({ status: 429, description: 'OTP_MAX_ATTEMPTS' })
  async confirmEmailVerification(
    @Body() dto: ConfirmEmailVerificationDto,
  ): Promise<{ message: string }> {
    await this.auth.confirmEmailVerification(dto.email, dto.code);
    return { message: 'Email verified.' };
  }

  @Post('verify/phone/request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(OTP_REQUEST_THROTTLE)
  @ApiOperation({ summary: 'Send an SMS verification code' })
  async requestPhoneVerification(
    @Body() dto: RequestPhoneVerificationDto,
  ): Promise<{ message: string }> {
    await this.auth.requestPhoneVerification(dto.phone);
    return { message: 'If that number is registered, a verification code has been sent.' };
  }

  @Post('verify/phone/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(OTP_CONFIRM_THROTTLE)
  @ApiOperation({ summary: 'Confirm an SMS verification code' })
  async confirmPhoneVerification(
    @Body() dto: ConfirmPhoneVerificationDto,
  ): Promise<{ message: string }> {
    await this.auth.confirmPhoneVerification(dto.phone, dto.code);
    return { message: 'Phone number verified.' };
  }

  // ── Password reset ─────────────────────────────────────────────────────────

  @Post('password/forgot')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(RESET_THROTTLE)
  @ApiOperation({ summary: 'Request a password reset link' })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.auth.forgotPassword(dto.identifier, AuthController.contextOf(req));
    // Always the same response, whether or not the account exists.
    return { message: 'If that account exists, a password reset link has been sent.' };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(RESET_THROTTLE)
  @ApiOperation({ summary: 'Reset a password using a token; signs out every session' })
  @ApiResponseDoc({
    status: 400,
    description: 'RESET_TOKEN_INVALID / RESET_TOKEN_EXPIRED / WEAK_PASSWORD',
  })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.auth.resetPassword(dto.token, dto.password);
    return { message: 'Password updated. Please log in again.' };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private static contextOf(req: Request): RequestContext {
    return {
      userAgent: req.headers['user-agent']?.slice(0, 300),
      ip: req.ip,
    };
  }

  /** The guard already verified this token, so decoding the claim is safe here. */
  private static accessTokenExp(req: Request): number {
    const header = req.headers.authorization ?? '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      const [, payload] = raw.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        exp?: number;
      };
      return claims.exp ?? 0;
    } catch {
      return 0;
    }
  }
}
