import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { SharedDatesService, type SharedDateView } from './shared-dates.service';

/**
 * The dates a person shared with their WishMates, seen on their profile by a
 * WishMate — and "Remind me" on each.
 */
@ApiTags('profile')
@Controller('people/:userId/important-dates')
@ApiBearerAuth()
export class SharedDatesController {
  constructor(private readonly shared: SharedDatesService) {}

  @Get()
  @ApiOperation({
    summary: 'A WishMate’s shared dates, soonest first',
    description: 'Only dates they shared, and only to their WishMates.',
  })
  @ApiResponseDoc({ status: 403, description: 'NOT_WISHMATES' })
  list(
    @CurrentUser('id') viewerId: string,
    @Param('userId') ownerId: string,
  ): Promise<SharedDateView[]> {
    return this.shared.listFor(viewerId, ownerId);
  }

  @Put(':dateId/remind')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remind me of this date',
    description: 'A week before, three days before and on the day, every year.',
  })
  @ApiResponseDoc({ status: 403, description: 'NOT_WISHMATES' })
  @ApiResponseDoc({ status: 404, description: 'Not found, or not shared' })
  async remind(
    @CurrentUser('id') viewerId: string,
    @Param('userId') ownerId: string,
    @Param('dateId') dateId: string,
  ): Promise<void> {
    await this.shared.remind(viewerId, ownerId, dateId);
  }

  @Delete(':dateId/remind')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop reminding me of this date' })
  async stop(
    @CurrentUser('id') viewerId: string,
    @Param('userId') ownerId: string,
    @Param('dateId') dateId: string,
  ): Promise<void> {
    await this.shared.stopReminding(viewerId, ownerId, dateId);
  }
}
