import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token issued by /auth/login or a prior /auth/refresh' })
  @IsString()
  @IsJWT({ message: 'refreshToken must be a valid token' })
  refreshToken!: string;
}
