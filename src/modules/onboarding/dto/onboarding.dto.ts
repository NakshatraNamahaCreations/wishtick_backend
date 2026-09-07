import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsTimezone } from 'src/common/validators/is-timezone.validator';
import { AVATAR_KEY_PATTERN, Gender } from 'src/modules/profile/schemas/user-profile.schema';

/**
 * One permissive DTO covering every step's fields.
 *
 * Each step sends only its own subset, and the service enforces which fields a
 * given step may write. A DTO per step would be tidier on paper, but the step
 * list is server-driven — adding a step must not mean shipping a new DTO class
 * and a new route.
 */
export class SaveOnboardingStepDto {
  // ── profile ──
  @ApiPropertyOptional({ example: 'Aarav Sharma' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  displayName?: string;

  @ApiPropertyOptional({ example: '1995-04-17' })
  @IsOptional()
  @IsDateString({ strict: true })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsTimezone()
  timezone?: string;

  @ApiPropertyOptional({
    example: 'ananya@example.com',
    description:
      'Stored unverified — a phone-signup user has no email yet. The client ' +
      'can send them through /auth/verify/email/* afterwards.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender | null;

  @ApiPropertyOptional({
    example: 'avatar_07',
    description: 'A bundled illustrated avatar. Mutually exclusive with photoMediaId.',
  })
  @IsOptional()
  @Matches(AVATAR_KEY_PATTERN, { message: 'avatarKey must be avatar_01 … avatar_20' })
  avatarKey?: string | null;

  @ApiPropertyOptional({ description: 'A confirmed media id from /media/confirm' })
  @IsOptional()
  @IsMongoId()
  photoMediaId?: string | null;

  // ── interests ──
  @ApiPropertyOptional({ example: ['fashion_shoes', 'tech_gaming'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  interests?: string[];

  @ApiPropertyOptional({ example: ['fashion', 'health_fitness'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(12)
  interestCategories?: string[];

  @ApiPropertyOptional({ example: ['Astronomy'], description: 'Free text, max 40 chars each' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @ArrayMaxSize(10)
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '')
      : value,
  )
  customInterests?: string[];

  // ── sizes ──
  @ApiPropertyOptional({ example: 'm' })
  @IsOptional()
  @IsString()
  clothingSize?: string | null;

  @ApiPropertyOptional({ example: 'uk_8' })
  @IsOptional()
  @IsString()
  shoeSize?: string | null;

  @ApiPropertyOptional({ example: 'regular' })
  @IsOptional()
  @IsString()
  fitPreference?: string | null;

  @ApiPropertyOptional({ example: ['purple_plum', 'green_sage'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  favouriteColors?: string[];

  // ── gifting ──
  @ApiPropertyOptional({ example: ['books', 'electronics'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  giftCategories?: string[];

  @ApiPropertyOptional({ example: ['minimalist'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(15)
  lifestyle?: string[];

  // ── occasions ──
  @ApiPropertyOptional({ example: ['birthday'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(15)
  occasions?: string[];
}
