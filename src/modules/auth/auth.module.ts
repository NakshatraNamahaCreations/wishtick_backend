import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from 'src/modules/users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  PasswordResetToken,
  PasswordResetTokenSchema,
} from './schemas/password-reset-token.schema';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema';
import { AuthNotificationsService } from './services/auth-notifications.service';
import { OtpService } from './services/otp.service';
import { PasswordService } from './services/password.service';
import { SocketAuthService } from './services/socket-auth.service';
import { TokenService } from './services/token.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    // Secrets are passed per-signAsync call rather than registered here: access
    // and refresh tokens use different secrets, and a module-level default would
    // make it easy to sign a refresh token with the access secret by accident.
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      { name: PasswordResetToken.name, schema: PasswordResetTokenSchema },
    ]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    PasswordService,
    OtpService,
    AuthNotificationsService,
    JwtStrategy,
    SocketAuthService,
  ],
  // PasswordService is exported for the account-restore flow, which must verify
  // credentials without going through login (a deleted user cannot log in).
  // SocketAuthService lets the chat gateway authenticate a handshake identically.
  exports: [AuthService, TokenService, PasswordService, SocketAuthService],
})
export class AuthModule {}
