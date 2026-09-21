import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class OccasionShelfQueryDto {
  @ApiPropertyOptional({
    example: 'Mom',
    description:
      "Who the shelf is for, as free text — a saved date's relation. Picks between the " +
      "occasion's own categories, so Mum's birthday is not the same shelf as Dad's.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  relation?: string;
}
