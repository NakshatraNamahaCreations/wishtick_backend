import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class SignupDto {
  @ApiPropertyOptional({
    example: 'aarav@example.com',
    description: 'Required if phone is omitted',
  })
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email?: string;

  @ApiPropertyOptional({
    example: '+919876543210',
    description: 'E.164. Required if email is omitted',
  })
  @IsOptional()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid E.164 number, e.g. +919876543210',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value,
  )
  phone?: string;

  @ApiProperty({ example: 'a-long-passphrase-you-remember', minLength: 10, maxLength: 128 })
  @IsString()
  // 10 is above the 8 most sites use: length is the only knob that reliably
  // raises cracking cost. The 128 ceiling bounds argon2 CPU per request.
  @Length(10, 128, { message: 'password must be between 10 and 128 characters' })
  password!: string;

  @ApiPropertyOptional({ example: 'Aarav Sharma' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

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
