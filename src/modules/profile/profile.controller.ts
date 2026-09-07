import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AccountLifecycleService, type DeletionReceipt } from './account-lifecycle.service';
import { DataExportService, type UserDataExport } from './data-export.service';
import { UpdatePreferencesDto, UpdateProfileDto } from './dto/profile.dto';
import { ProfileService, type MeView } from './profile.service';

/** A full export is a heavy cross-collection scan; bound how often one runs. */
const EXPORT_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

export class DeleteAccountDto {
  @ApiPropertyOptional({ example: 'Not using it anymore' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

@ApiTags('profile')
@Controller('me')
@ApiBearerAuth()
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly lifecycle: AccountLifecycleService,
    private readonly dataExport: DataExportService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The authenticated user with their full profile' })
  getMe(@CurrentUser('id') userId: string): Promise<MeView> {
    return this.profiles.getMe(userId);
  }

  @Get('export')
  @Throttle(EXPORT_THROTTLE)
  @ApiOperation({
    summary: 'Export everything we hold about you (GDPR-style)',
    description:
      'One JSON document with the caller’s data across every domain — account, ' +
      'wishlists, events, gifts, group gifts, reels, chat, notifications, analytics, and ' +
      'reports. Secrets are redacted; only your own rows are included.',
  })
  exportMe(@CurrentUser('id') userId: string): Promise<UserDataExport> {
    return this.dataExport.exportForUser(userId, new Date());
  }

  @Patch()
  @ApiOperation({ summary: 'Update profile details (name, photo, DOB, timezone, contact)' })
  @ApiResponseDoc({ status: 404, description: 'MEDIA_NOT_FOUND — unknown or unowned photoMediaId' })
  updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto): Promise<MeView> {
    return this.profiles.updateProfile(userId, dto);
  }

  @Patch('preferences')
  @ApiOperation({
    summary: 'Update gifting preferences',
    description: 'Every value must be a key from GET /onboarding/options.',
  })
  @ApiResponseDoc({ status: 400, description: 'TAXONOMY_VALUE_INVALID' })
  updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<MeView> {
    return this.profiles.updatePreferences(userId, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete this account',
    description:
      'Soft delete. Every session ends immediately and the account disappears from the product, ' +
      'but it can be restored via POST /auth/account/restore until `restorableUntil`, after ' +
      'which the data is irreversibly anonymized.',
  })
  @ApiResponseDoc({ status: 409, description: 'ACCOUNT_DELETED — already pending deletion' })
  deleteMe(
    @CurrentUser('id') userId: string,
    @Body() dto: DeleteAccountDto,
  ): Promise<DeletionReceipt> {
    return this.lifecycle.requestDeletion(userId, dto.reason);
  }
}
