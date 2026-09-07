import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'aarav@example.com',
    description: 'Email address or E.164 phone number',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s()-]/g, '')
      : value,
  )
  identifier!: string;

  @ApiProperty({ example: 'a-long-passphrase-you-remember' })
  @IsString()
  // No length floor here: rejecting a short password at the DTO would tell an
  // attacker their guess was malformed rather than merely wrong, and would
  // lock out any user whose password predates a policy change.
  @MaxLength(128)
  password!: string;
}
