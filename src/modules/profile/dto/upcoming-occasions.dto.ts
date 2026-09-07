import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpcomingOccasionsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 366,
    default: 30,
    description: 'How far ahead to look. Home shows 30 days.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  withinDays?: number;
}
