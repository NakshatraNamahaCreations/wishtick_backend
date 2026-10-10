import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  IMPORTANT_DATE_VISIBILITIES,
  type ImportantDateVisibility,
} from '../schemas/important-date.schema';

export class CreateImportantDateDto {
  @ApiProperty({ example: 'Ananya' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  personName!: string;

  @ApiPropertyOptional({
    example: 'Best Friend',
    description:
      'Free text relationship. Optional — a date is worth keeping without one, ' +
      'and this is only ever displayed beside the name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  relation?: string;

  @ApiProperty({ example: 'birthday', description: 'A taxonomy occasion key' })
  @IsString()
  @MaxLength(60)
  occasionKey!: string;

  @ApiProperty({ example: '1999-07-17', description: 'ISO date; recurs yearly' })
  @IsDateString({ strict: true })
  date!: string;

  @ApiPropertyOptional({
    example: 'Naming ceremony',
    description: "What they call it. Required when occasionKey is 'other', ignored otherwise.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  customOccasion?: string;

  @ApiPropertyOptional({
    enum: IMPORTANT_DATE_VISIBILITIES,
    default: 'private',
    description:
      "'private' (only you) or 'wishmates' — shown on your profile to your WishMates, " +
      'who can ask to be reminded of it.',
  })
  @IsOptional()
  @IsIn(IMPORTANT_DATE_VISIBILITIES)
  visibility?: ImportantDateVisibility;
}

/**
 * Saying that a saved date is one of your WishMates.
 *
 * Its own endpoint rather than a field on the update: a link is a claim about
 * the connection graph, refused for anyone who is not an accepted WishMate,
 * and a PATCH whose other fields succeed while this one 403s would be a
 * confusing half-write.
 */
export class LinkImportantDateDto {
  @ApiProperty({ example: '665f2e1c9b1e4a0012ab34cd', description: 'A WishMate’s user id' })
  @IsMongoId()
  userId!: string;
}

/**
 * Changing a saved date. Every field is optional — what is not sent is left
 * alone — but each is validated exactly as on creation.
 *
 * `PartialType` rather than a hand-written copy so a validator added to
 * [CreateImportantDateDto] cannot be forgotten here.
 */
export class UpdateImportantDateDto extends PartialType(CreateImportantDateDto) {}
