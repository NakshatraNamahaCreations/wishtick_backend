import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { AdminService, type AdminView } from './admin.service';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './admin.decorators';
import type { AuthenticatedAdmin } from './admin.types';
import { AdminLoginDto } from './dto/admin.dto';

/** Bounds brute-force against admin login. */
const LOGIN_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('admin')
@Controller('admin/auth')
@Public() // The global user guard skips these; login is open, the rest use AdminGuard.
export class AdminAuthController {
  constructor(private readonly admins: AdminService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(LOGIN_THROTTLE)
  @ApiOperation({ summary: 'Admin login (email + password)' })
  login(
    @Body() dto: AdminLoginDto,
    @Ip() ip: string,
  ): Promise<{
    accessToken: string;
    expiresInSeconds: number;
    admin: AdminView;
  }> {
    return this.admins.login(dto, ip ?? null);
  }

  @Post('logout')
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End this admin session' })
  async logout(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<{ ok: true }> {
    await this.admins.logout(admin.jti);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated admin' })
  me(@CurrentAdmin() admin: AuthenticatedAdmin): AuthenticatedAdmin {
    return admin;
  }
}
