import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { BANNER_LINK_PATTERN, BannerPlacement } from '../home-banner.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** An empty string from a cleared field means "none". */
const blankToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });

/** Everything the panel sets on a banner. */
export class CreateHomeBannerDto {
  @ApiProperty({ enum: BannerPlacement })
  @IsEnum(BannerPlacement)
  placement!: BannerPlacement;

  /** The app no longer draws it — the words are in the picture. Kept for older builds. */
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  title?: string;

  @ApiPropertyOptional({ maxLength: 120, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  @Transform(blankToNull)
  subtitle?: string | null;

  @ApiProperty({ description: 'A picture uploaded through /admin/banners/images.' })
  @IsString()
  @MaxLength(500)
  imageUrl!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'A web page (https://…) or an app screen (/discover/occasions/birthday).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  @Matches(BANNER_LINK_PATTERN, {
    message: 'linkUrl is an https:// address or an app path starting with /',
  })
  @Transform(blankToNull)
  linkUrl?: string | null;

  @ApiPropertyOptional({ description: 'Lower shows first.', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  position?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Shown from this moment; none = now.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  startsAt?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Shown until this moment; none = no end.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  endsAt?: string | null;
}

/** Any of the above; the placement may move too. */
export class UpdateHomeBannerDto extends PartialType(CreateHomeBannerDto) {}

export class AdminBannerListQueryDto {
  @ApiPropertyOptional({ enum: BannerPlacement })
  @IsOptional()
  @IsEnum(BannerPlacement)
  placement?: BannerPlacement;
}
