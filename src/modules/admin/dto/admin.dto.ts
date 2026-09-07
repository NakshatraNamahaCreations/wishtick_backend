import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { UserStatus } from 'src/common/enums/user-role.enum';
import { AdminRole, AdminStatus } from '../admin.types';
import { ModerationAction, ReportStatus, ReportTargetType } from '../moderation.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class AdminLoginDto {
  @ApiProperty()
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 128)
  password!: string;

  @ApiPropertyOptional({ description: 'Required once 2FA is enabled.' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totp?: string;
}

export class TotpTokenDto {
  @ApiProperty()
  @IsString()
  @Matches(/^\d{6}$/)
  token!: string;
}

export class CreateAdminDto {
  @ApiProperty()
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @Length(12, 128)
  password!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  name!: string;

  @ApiProperty({ enum: AdminRole, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AdminRole, { each: true })
  roles!: AdminRole[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ipAllowlist?: string[];
}

export class ListUsersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SuspendUserDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason!: string;
}

export class ModerationQueueQueryDto {
  @ApiPropertyOptional({ enum: ReportTargetType })
  @IsOptional()
  @IsEnum(ReportTargetType)
  type?: ReportTargetType;

  @ApiPropertyOptional({ enum: ReportStatus })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ModerationActionDto {
  @ApiProperty({ enum: ModerationAction })
  @IsEnum(ModerationAction)
  action!: ModerationAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason?: string;
}

export class AnalyticsRangeDto {
  @ApiPropertyOptional({ description: 'Start day, YYYY-MM-DD (UTC).' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'End day, YYYY-MM-DD (UTC).' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class AuditQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetId?: string;

  @ApiPropertyOptional({ description: 'e.g. user.suspend, moderation.remove' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @ApiPropertyOptional({ description: 'Filter to one admin actor.' })
  @IsOptional()
  @IsString()
  actorAdminId?: string;

  @ApiPropertyOptional({ description: 'Start day, YYYY-MM-DD (UTC), inclusive.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'End day, YYYY-MM-DD (UTC), inclusive.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class UpdateAdminDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @ApiPropertyOptional({ enum: AdminRole, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AdminRole, { each: true })
  roles?: AdminRole[];

  @ApiPropertyOptional({ enum: AdminStatus })
  @IsOptional()
  @IsEnum(AdminStatus)
  status?: AdminStatus;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ipAllowlist?: string[];
}

export class ResetAdminPasswordDto {
  @ApiProperty({ minLength: 12 })
  @IsString()
  @Length(12, 128)
  password!: string;
}

export class CreateReportDto {
  @ApiProperty({ enum: ReportTargetType })
  @IsEnum(ReportTargetType)
  targetType!: ReportTargetType;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  targetId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  detail?: string;
}

class TrackEventDto {
  @ApiProperty()
  @IsString()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  props?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  anonymousId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ts?: string;
}

export class TrackDto {
  @ApiProperty({ type: [TrackEventDto] })
  @IsArray()
  @ArrayMinSize(1)
  @Type(() => TrackEventDto)
  events!: TrackEventDto[];
}
