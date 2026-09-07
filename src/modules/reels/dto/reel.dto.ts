import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsTimezone } from 'src/common/validators/is-timezone.validator';
import { WishKind } from '../reel.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateReelDto {
  @ApiProperty({ description: 'The birthday person this reel is for.' })
  @IsMongoId()
  recipientUserId!: string;

  @ApiProperty({ description: 'Collection title, e.g. "Aarav\'s Birthday".' })
  @IsString()
  @MaxLength(140)
  @Transform(trim)
  title!: string;

  @ApiProperty({ description: 'The birthday (its month/day drives release). ISO date.' })
  @IsDateString({ strict: true })
  birthdayDate!: string;

  @ApiProperty({ description: 'IANA timezone; the reel releases at local midnight here.' })
  @IsTimezone()
  timezone!: string;

  @ApiPropertyOptional({ description: 'Link the collection to an event.' })
  @IsOptional()
  @IsMongoId()
  eventId?: string;
}

export class SubmitWishDto {
  @ApiProperty({ enum: WishKind })
  @IsEnum(WishKind)
  kind!: WishKind;

  @ApiPropertyOptional({ description: 'Required for a text wish.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  text?: string;

  @ApiPropertyOptional({ description: 'A confirmed reel_wish media id (audio/video wishes).' })
  @IsOptional()
  @IsMongoId()
  mediaId?: string;

  @ApiPropertyOptional({ description: 'Display name; defaults to your account name.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  authorName?: string;
}

export class ModerateWishDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';
}

export class ShareReelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  rotate?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(trim)
  passcode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string | null;
}

export class PublicReelQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  passcode?: string;
}
