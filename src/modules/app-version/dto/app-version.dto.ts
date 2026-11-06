import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { AppPlatform, STORE_URL_PATTERN } from '../app-version.types';

/** An empty string from a cleared field means "none". */
const blankToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? (value.trim() === '' ? null : value.trim()) : value;

/** Version names people read: "1.0.2", "1.0.2-beta". */
const VERSION_NAME = /^\d+(\.\d+){0,3}([-+][\w.]+)?$/;

/** What the app sends: its platform and its own build number. */
export class AppVersionCheckQueryDto {
  @ApiProperty({ enum: AppPlatform })
  @IsEnum(AppPlatform)
  platform!: AppPlatform;

  @ApiProperty({ description: "The build's number (Android versionCode)", example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_100_000_000)
  versionCode!: number;
}

/**
 * The whole policy for one platform, saved at once. To force an update, set
 * [minVersionCode] to the build everyone must be on. Set it to 0 to stop
 * forcing.
 */
export class UpdateAppVersionPolicyDto {
  @ApiProperty({ description: 'The newest build in the store', example: 3 })
  @IsInt()
  @Min(0)
  @Max(2_100_000_000)
  latestVersionCode!: number;

  @ApiPropertyOptional({ example: '1.0.2', nullable: true })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  @Matches(VERSION_NAME, { message: 'latestVersionName must look like 1.0.2' })
  latestVersionName?: string | null;

  @ApiProperty({ description: 'Builds below this must update. 0 turns force update off.' })
  @IsInt()
  @Min(0)
  @Max(2_100_000_000)
  minVersionCode!: number;

  @ApiPropertyOptional({ example: '1.0.2', nullable: true })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  @Matches(VERSION_NAME, { message: 'minVersionName must look like 1.0.2' })
  minVersionName?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'The store listing; empty for the default' })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  @Matches(STORE_URL_PATTERN, { message: 'storeUrl must be a Play Store or App Store link' })
  storeUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  message?: string | null;

  @ApiPropertyOptional({ description: 'Why, for the audit log', maxLength: 300 })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  reason?: string | null;
}
