import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class SetUsernameDto {
  @ApiProperty({ example: 'rohan_prasad' })
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  username!: string;
}

export class SearchPeopleQueryDto {
  @ApiProperty({ example: 'ro', description: 'Handle or display name. A leading @ is ignored.' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  q!: string;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
