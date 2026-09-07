import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNumberString, IsString, Length, Matches } from 'class-validator';

export class RequestEmailVerificationDto {
  @ApiProperty({ example: 'aarav@example.com' })
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;
}

export class RequestPhoneVerificationDto {
  @ApiProperty({ example: '+919876543210' })
  @Matches(/^\+?[1-9]\d{7,14}$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value,
  )
  phone!: string;
}

export class ConfirmEmailVerificationDto extends RequestEmailVerificationDto {
  @ApiProperty({ example: '482913' })
  @IsNumberString({ no_symbols: true })
  @Length(4, 8)
  code!: string;
}

export class ConfirmPhoneVerificationDto extends RequestPhoneVerificationDto {
  @ApiProperty({ example: '482913' })
  @IsNumberString({ no_symbols: true })
  @Length(4, 8)
  code!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'aarav@example.com', description: 'Email or E.164 phone number' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s()-]/g, '')
      : value,
  )
  identifier!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use token from the reset email' })
  @IsString()
  @Length(16, 256)
  token!: string;

  @ApiProperty({ example: 'a-new-long-passphrase', minLength: 10, maxLength: 128 })
  @IsString()
  @Length(10, 128)
  password!: string;
}
