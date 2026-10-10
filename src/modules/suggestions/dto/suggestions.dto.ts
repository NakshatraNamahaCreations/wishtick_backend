import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class GiftSuggestionsQueryDto {
  @ApiPropertyOptional({ example: 'birthday', description: 'An occasion taxonomy key.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  occasionKey?: string;

  @ApiPropertyOptional({ example: 50000, description: 'Minor units.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceMinor?: number;

  @ApiPropertyOptional({
    example: 200000,
    description: 'Minor units. Snapped to the nearest shared price band before searching.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceMinor?: number;

  @ApiPropertyOptional({ example: 12, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  limit?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Only the explore query — where to search for them — with no products and no vendor ' +
      'calls. For a screen that runs the search itself.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  queryOnly?: boolean;
}
