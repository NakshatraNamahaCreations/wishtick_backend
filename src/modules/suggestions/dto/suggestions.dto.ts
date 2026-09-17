import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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
}
