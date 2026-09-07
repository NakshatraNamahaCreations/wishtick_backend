import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { LoginDto } from 'src/modules/auth/dto/login.dto';
import { PasswordService } from 'src/modules/auth/services/password.service';
import { UsersService } from 'src/modules/users/users.service';
import { AccountLifecycleService } from './account-lifecycle.service';

// Same bucket as login: this endpoint takes a password, so it is a credential
// oracle if left unthrottled.
const RESTORE_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth/account')
export class AccountRestoreController {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly lifecycle: AccountLifecycleService,
  ) {}

  @Post('restore')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(RESTORE_THROTTLE)
  @ApiOperation({
    summary: 'Restore an account pending deletion',
    description:
      'Public because a deleted account cannot hold a session — the password is the ' +
      'authorization. Works only inside the grace window returned by DELETE /me.',
  })
  @ApiResponseDoc({ status: 401, description: 'INVALID_CREDENTIALS' })
  @ApiResponseDoc({ status: 410, description: 'RESTORE_WINDOW_EXPIRED' })
  async restore(@Body() dto: LoginDto): Promise<{ message: string }> {
    const user = await this.users.findDeletedByIdentifierForRestore(dto.identifier);

    // No user, wrong password, and "not actually deleted" all return the same
    // 401. Anything else turns this into an oracle for which accounts exist and
    // which are pending deletion — and it is unauthenticated by necessity.
    //
    // A passwordless (phone sign-in) account has nothing to verify against and
    // so cannot be restored here. Restoring one needs an OTP-authorized path;
    // until that exists it falls into the same generic 401.
    if (!user?.passwordHash || !(await this.passwords.verify(user.passwordHash, dto.password))) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Incorrect email/phone or password, or this account cannot be restored',
        401,
      );
    }

    // Throws RESTORE_WINDOW_EXPIRED once the data is genuinely gone. That is
    // safe to reveal: the caller already proved they own the account.
    await this.lifecycle.restore(user);
    return { message: 'Account restored. You can log in again.' };
  }
}
