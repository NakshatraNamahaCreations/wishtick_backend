import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { IsTimezone } from 'src/common/validators/is-timezone.validator';
import { MEMORY_REPLY_MAX_RECIPIENTS, MemoryWishKind, MEMORY_WISH_TEXT_MAX } from '../memory.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateMemoryDto {
  @ApiProperty({ example: "Ananya's Birthday" })
  @IsString()
  @Length(1, 140)
  @Transform(trim)
  title!: string;

  /**
   * Who the memory is for — a WishMate of the caller.
   *
   * A user id, not a name: the server checks the link before it will create
   * the capsule, and a name could not be checked against anything.
   */
  @ApiProperty({ description: 'A WishMate of the caller' })
  @IsMongoId()
  recipientUserId!: string;

  @ApiPropertyOptional({ description: 'A `relation` taxonomy key (`2252:423`)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  relation?: string | null;

  @ApiProperty({ example: 'birthday', description: 'An `occasion` taxonomy key' })
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  occasion!: string;

  @ApiPropertyOptional({
    description: "The occasion's own date, which is not the unlock instant",
    example: '2026-07-17T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  occasionDate?: string | null;

  @ApiPropertyOptional({ default: false, description: "Whether the occasion date's year matters" })
  @IsOptional()
  @IsBoolean()
  includeYear?: boolean;

  @ApiProperty({ example: '2026-07-19T18:30:00.000Z', description: 'When it opens (`2198:73`)' })
  @IsDateString({ strict: true })
  unlockAt!: string;

  @ApiProperty({ example: 'Asia/Kolkata' })
  @IsTimezone()
  timezone!: string;

  @ApiPropertyOptional({ description: 'A confirmed media id you own (purpose: memory_cover)' })
  @IsOptional()
  @IsMongoId()
  coverMediaId?: string | null;
}

export class UpdateMemoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 140)
  @Transform(trim)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  relation?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  occasion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({ strict: true })
  occasionDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeYear?: boolean;

  @ApiPropertyOptional({ description: 'Moving this reschedules the unlock job' })
  @IsOptional()
  @IsDateString({ strict: true })
  unlockAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTimezone()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  coverMediaId?: string | null;
}

export class AddMemoryWishDto {
  @ApiProperty({ enum: MemoryWishKind })
  @IsEnum(MemoryWishKind)
  kind!: MemoryWishKind;

  @ApiPropertyOptional({
    maxLength: MEMORY_WISH_TEXT_MAX,
    description: 'Optional for media wishes; required for a text wish',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MEMORY_WISH_TEXT_MAX)
  @Transform(trim)
  text?: string | null;

  @ApiPropertyOptional({ description: 'A confirmed media id you own (purpose: memory_wish)' })
  @IsOptional()
  @IsMongoId()
  mediaId?: string | null;

  @ApiPropertyOptional({
    description: 'Name to show on the wish. Defaults to your profile name.',
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  contributorName?: string;
}

/**
 * The recipient of an opened capsule writing back.
 *
 * Deliberately the same shape as [AddMemoryWishDto] plus an addressee list —
 * it is composed on the same screen, in the same four kinds.
 */
export class SendMemoryReplyDto {
  @ApiProperty({ enum: MemoryWishKind })
  @IsEnum(MemoryWishKind)
  kind!: MemoryWishKind;

  @ApiPropertyOptional({
    maxLength: MEMORY_WISH_TEXT_MAX,
    description: 'Optional for media replies; required for a text reply',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MEMORY_WISH_TEXT_MAX)
  @Transform(trim)
  text?: string | null;

  @ApiPropertyOptional({ description: 'A confirmed media id you own (purpose: memory_reply)' })
  @IsOptional()
  @IsMongoId()
  mediaId?: string | null;

  /**
   * Who to send it to.
   *
   * Every id is checked against the people who actually sent the caller a
   * memory — the list is a selection from that audience, never a way to
   * address someone who has not.
   */
  @ApiProperty({
    type: [String],
    description: 'User ids drawn from GET /memories/reply-audience',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MEMORY_REPLY_MAX_RECIPIENTS)
  @IsMongoId({ each: true })
  recipientIds!: string[];
}
