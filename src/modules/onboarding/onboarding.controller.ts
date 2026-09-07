import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { SaveOnboardingStepDto } from './dto/onboarding.dto';
import {
  OnboardingService,
  type OnboardingOptionsView,
  type OnboardingStatusView,
} from './onboarding.service';
import type { MeView } from 'src/modules/profile/profile.service';

@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('options')
  @Public()
  @ApiOperation({
    summary: 'The onboarding flow and every selectable value',
    description:
      'Public so a client can render onboarding before the account exists. Cached for an hour.',
  })
  getOptions(): Promise<OnboardingOptionsView> {
    return this.onboarding.getOptions();
  }

  @Get('status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Which steps are done and what is still required' })
  getStatus(@CurrentUser('id') userId: string): Promise<OnboardingStatusView> {
    return this.onboarding.getStatus(userId);
  }

  @Post('steps/:step')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Save one onboarding step',
    description: 'Idempotent — safe to retry, and safe to re-send to change an answer.',
  })
  @ApiResponseDoc({ status: 404, description: 'ONBOARDING_STEP_UNKNOWN' })
  @ApiResponseDoc({ status: 400, description: 'TAXONOMY_VALUE_INVALID' })
  saveStep(
    @CurrentUser('id') userId: string,
    @Param('step') step: string,
    @Body() dto: SaveOnboardingStepDto,
  ): Promise<{ status: OnboardingStatusView; me: MeView }> {
    return this.onboarding.saveStep(userId, step, dto);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Finish onboarding' })
  @ApiResponseDoc({ status: 400, description: 'ONBOARDING_INCOMPLETE' })
  @ApiResponseDoc({ status: 409, description: 'ONBOARDING_ALREADY_COMPLETE' })
  complete(@CurrentUser('id') userId: string): Promise<OnboardingStatusView> {
    return this.onboarding.complete(userId);
  }
}
