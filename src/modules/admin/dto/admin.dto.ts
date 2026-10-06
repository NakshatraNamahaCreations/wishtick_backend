import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsISO8601,
  IsMongoId,
  IsObject,
  IsUrl,
  ValidateNested,
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

  @ApiPropertyOptional({
    enum: ['email', 'phone', 'any', 'none'],
    description: 'Verified email, verified phone, either, or neither.',
  })
  @IsOptional()
  @IsIn(['email', 'phone', 'any', 'none'])
  verified?: 'email' | 'phone' | 'any' | 'none';

  @ApiPropertyOptional({ description: 'Acquisition source, e.g. whatsapp, invite, organic.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;

  @ApiPropertyOptional({ example: '2026-09-01', description: 'Joined on or after (UTC day).' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'Joined on or before (UTC day).' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ enum: ['joined', 'lastLogin', 'name'], default: 'joined' })
  @IsOptional()
  @IsIn(['joined', 'lastLogin', 'name'])
  sort?: 'joined' | 'lastLogin' | 'name';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

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

/** The panel's search box. */
export class AdminSearchQueryDto {
  @ApiProperty({ example: 'rohan', minLength: 2, maxLength: 120 })
  @IsString()
  @Length(2, 120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  q!: string;
}

/** Page and limit for any admin list. Lists clamp the limit to 100 themselves. */
export class PageQueryDto {
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

  @ApiPropertyOptional({ enum: ['user', 'auto'] })
  @IsOptional()
  @IsIn(['user', 'auto'])
  source?: 'user' | 'auto';

  @ApiPropertyOptional({ enum: ['me', 'none'], description: 'Claimed by me, or by nobody.' })
  @IsOptional()
  @IsIn(['me', 'none'])
  assigned?: 'me' | 'none';
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

  @ApiPropertyOptional({
    enum: ['read', 'change'],
    description: 'read: reveals of private data and exports. change: everything else.',
  })
  @IsOptional()
  @IsIn(['read', 'change'])
  kind?: 'read' | 'change';

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

// ── Users 360° ───────────────────────────────────────────────────────────────

/** Why an admin is doing something to a user — kept in the audit log. */
export class AdminReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  reason!: string;
}

export class RevealDto extends AdminReasonDto {
  @ApiProperty({ enum: ['email', 'phone', 'upi', 'addresses'] })
  @IsIn(['email', 'phone', 'upi', 'addresses'])
  field!: 'email' | 'phone' | 'upi' | 'addresses';
}

export class VerifyContactDto extends AdminReasonDto {
  @ApiProperty({ enum: ['email', 'phone'] })
  @IsIn(['email', 'phone'])
  field!: 'email' | 'phone';
}

export class EditUserProfileDto extends AdminReasonDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  displayName?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'priya_s' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._]{3,30}$/i, {
    message: 'username must be 3–30 letters, digits, dots or underscores',
  })
  username?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  bio?: string | null;
}

export class ClaimReportDto {
  @ApiPropertyOptional({ description: 'Take it from the moderator holding it.' })
  @IsOptional()
  @IsBoolean()
  takeOver?: boolean;
}

export class BulkModerationDto extends ModerationActionDto {
  @ApiProperty({ type: [String], maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  ids!: string[];
}

const yesNo = ['yes', 'no'] as const;

/** Every filter the content lists understand; each list reads the ones it has. */
export class ContentListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Title, name or id.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @ApiPropertyOptional({ description: 'Owner / host / author user id.' })
  @IsOptional()
  @IsMongoId()
  owner?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  visibility?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;

  @ApiPropertyOptional({ enum: yesNo })
  @IsOptional()
  @IsIn(yesNo)
  archived?: 'yes' | 'no';

  @ApiPropertyOptional({ enum: yesNo })
  @IsOptional()
  @IsIn(yesNo)
  hasEvent?: 'yes' | 'no';

  @ApiPropertyOptional({ enum: yesNo })
  @IsOptional()
  @IsIn(yesNo)
  hasGift?: 'yes' | 'no';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({ description: 'Minor units (paise).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Minor units (paise).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ description: 'Bytes, for media.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minSize?: number;

  @ApiPropertyOptional({ description: 'Bytes, for media.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  purpose?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  refId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  participant?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class ContentActionDto extends AdminReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  itemId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  wishId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  replyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  messageId?: string;

  @ApiPropertyOptional({ description: 'ISO date-time; when a relocked memory opens.' })
  @IsOptional()
  @IsISO8601()
  unlockAt?: string;
}

export class SectionRevealDto extends AdminReasonDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class RemovalsQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  targetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  owner?: string;
}

const yesNoValues = ['yes', 'no'] as const;

/** Every filter the money lists understand; each list reads the ones it has. */
export class MoneyListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Reference, title, order id or id.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: 'Gifter / host / buyer user id.' })
  @IsOptional()
  @IsMongoId()
  owner?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  mode?: string;

  @ApiPropertyOptional({ enum: yesNoValues, description: 'Reservations past their hold.' })
  @IsOptional()
  @IsIn(yesNoValues)
  stuck?: 'yes' | 'no';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  stage?: string;

  @ApiPropertyOptional({
    description: 'Who moved an order: gift, affiliate_webhook, courier_webhook, manual.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  courier?: string;

  @ApiPropertyOptional({ enum: yesNoValues })
  @IsOptional()
  @IsIn(yesNoValues)
  cancelled?: 'yes' | 'no';

  @ApiPropertyOptional({ enum: yesNoValues, description: 'Group gifts that ever drifted.' })
  @IsOptional()
  @IsIn(yesNoValues)
  drift?: 'yes' | 'no';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  network?: string;

  @ApiPropertyOptional({ enum: yesNoValues, description: 'Sales matched to a gift.' })
  @IsOptional()
  @IsIn(yesNoValues)
  matched?: 'yes' | 'no';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  provider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  eventType?: string;
}

export class MoneyActionDto extends AdminReasonDto {
  @ApiPropertyOptional({ description: 'ISO date-time: when an extended hold ends.' })
  @IsOptional()
  @IsISO8601()
  until?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  stage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  courier?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  trackingNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  trackingUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  contributionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  settlementId?: string;
}

/** A from–to range of months (`YYYY-MM`) or days. */
export class MonthRangeDto {
  @ApiPropertyOptional({ description: 'YYYY-MM' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}(-\d{2})?$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}(-\d{2})?$/)
  to?: string;
}

/** Every filter the notification lists understand. */
export class NotificationListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Reference, provider reference, error or id.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  owner?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  channel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  platform?: string;

  @ApiPropertyOptional({ enum: ['yes', 'no'] })
  @IsOptional()
  @IsIn(['yes', 'no'])
  revoked?: 'yes' | 'no';
}

export class OverviewQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 90, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

export class UnsuppressDto extends AdminReasonDto {
  @ApiProperty({ enum: ['email', 'sms'] })
  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';

  @ApiProperty()
  @IsString()
  @Length(3, 320)
  address!: string;
}

export class PreviewNotificationDto {
  @ApiPropertyOptional({ description: 'Values for the blanks; left out, fallbacks show.' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class TestSendDto extends PreviewNotificationDto {
  @ApiProperty()
  @IsString()
  @MaxLength(60)
  type!: string;

  @ApiProperty()
  @IsMongoId()
  userId!: string;
}

export class BroadcastSegmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  city?: string;

  @ApiPropertyOptional({ description: 'An interest key from onboarding.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  interest?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  activeWithinDays?: number;
}

export class BroadcastDryRunDto {
  @ApiProperty({ type: BroadcastSegmentDto })
  @ValidateNested()
  @Type(() => BroadcastSegmentDto)
  segment!: BroadcastSegmentDto;
}

export class BroadcastDto extends BroadcastDryRunDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @Length(3, 80)
  @Transform(trim)
  title!: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @Length(3, 300)
  @Transform(trim)
  body!: string;

  @ApiPropertyOptional({ description: 'Where tapping it goes.' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  url?: string;
}

export class JobListQueryDto {
  @ApiPropertyOptional({ enum: ['failed', 'waiting', 'active', 'delayed', 'completed'] })
  @IsOptional()
  @IsIn(['failed', 'waiting', 'active', 'delayed', 'completed'])
  state?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class PauseQueueDto extends AdminReasonDto {
  @ApiProperty({ description: 'true pauses, false resumes.' })
  @IsBoolean()
  paused!: boolean;
}

/** The product list's filters. */
export class CatalogListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Title, brand, store, provider id or id.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: 'Last synced from, YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'Last synced to, YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  provider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  merchant?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ enum: ['yes', 'no'] })
  @IsOptional()
  @IsIn(['yes', 'no'])
  inStock?: 'yes' | 'no';

  @ApiPropertyOptional({ enum: ['yes', 'no'] })
  @IsOptional()
  @IsIn(['yes', 'no'])
  affiliated?: 'yes' | 'no';
}

/** An optional note kept with a catalogue change in the audit log. */
export class CatalogNoteDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason?: string;
}

/** A new taxonomy option, or the parts of one being changed. */
export class TaxonomyTermDto extends CatalogNoteDto {
  @ApiPropertyOptional({ description: 'New options only; never changed afterwards.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({ description: 'Kind-specific extras; an empty value removes one.' })
  @IsOptional()
  @IsObject()
  meta?: Record<string, string>;
}

export class TaxonomyActiveDto extends CatalogNoteDto {
  @ApiProperty({ description: 'false retires the option, true brings it back.' })
  @IsBoolean()
  active!: boolean;
}

export class TaxonomyReorderDto extends CatalogNoteDto {
  @ApiProperty({ type: [String], description: 'Option ids, first to last.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  ids!: string[];
}

export class RetentionQueryDto {
  @ApiPropertyOptional({ minimum: 2, maximum: 26, default: 8 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(26)
  weeks?: number;
}

/** The raw analytics event stream's filters. */
export class RawEventsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Event name, exactly.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ description: 'User id.' })
  @IsOptional()
  @IsMongoId()
  user?: string;

  @ApiPropertyOptional({ description: 'Part of an anonymous (signed-out) id.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class AdminActivityQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}
