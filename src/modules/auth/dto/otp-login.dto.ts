import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumberString, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class RequestOtpLoginDto {
  @ApiProperty({ example: '+919876543210', description: 'E.164 phone number' })
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid E.164 number, e.g. +919876543210',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value,
  )
  phone!: string;

  @ApiPropertyOptional({
    example: 'whatsapp',
    description: 'Acquisition source, from the link the user arrived via.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @ApiPropertyOptional({ description: 'The specific referring link/token/campaign.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  ref?: string;
}

export class VerifyOtpLoginDto {
  @ApiProperty({ example: '+919876543210' })
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid E.164 number, e.g. +919876543210',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value,
  )
  phone!: string;

  @ApiProperty({ example: '482913' })
  @IsNumberString({ no_symbols: true })
  @Length(4, 8)
  code!: string;

  @ApiPropertyOptional({
    example: 'Ananya Mehra',
    description: 'Applied only when this call creates the account.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({ example: 'whatsapp' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  ref?: string;
}
