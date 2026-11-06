import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import type { AppVersionCheckView } from './app-version.types';
import { AppVersionService } from './app-version.service';
import { AppVersionCheckQueryDto } from './dto/app-version.dto';

/**
 * "Should this build update?" Public, because a build that must update has
 * to be told so even when it is signed out, or when its token is too old to
 * refresh.
 */
@ApiTags('app')
@Controller('app')
export class AppVersionController {
  constructor(private readonly versions: AppVersionService) {}

  @Get('version')
  @Public()
  @ApiOperation({
    summary: 'Whether this build is current, may update (optional), or must update (required)',
  })
  check(@Query() q: AppVersionCheckQueryDto): Promise<AppVersionCheckView> {
    return this.versions.check(q.platform, q.versionCode);
  }
}
