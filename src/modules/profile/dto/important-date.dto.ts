import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
}
