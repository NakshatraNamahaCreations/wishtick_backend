import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateImportantDateDto } from './dto/important-date.dto';
import { UpcomingOccasionsQueryDto } from './dto/upcoming-occasions.dto';
import {
  ImportantDatesService,
  type ImportantDateView,
  type UpcomingOccasionView,
} from './important-dates.service';

/**
 * The dated people the user cares about — collected by onboarding's
 * "Never Miss a Celebration" step (Figma `199:10`) and managed from the
 * profile later. Feeds Home's "Upcoming Events" and, eventually, reminders.
 */
@ApiTags('profile')
@Controller('me/important-dates')
@ApiBearerAuth()
export class ImportantDatesController {
  constructor(private readonly dates: ImportantDatesService) {}

  @Get()
  @ApiOperation({ summary: 'The caller’s saved dates, soonest first' })
  list(@CurrentUser('id') userId: string): Promise<ImportantDateView[]> {
    return this.dates.list(userId);
  }

  /**
   * Declared before ':id' would matter on a GET, and kept next to `list` so the
   * two read paths stay together.
   */
  @Get('upcoming')
  @ApiOperation({
    summary: 'Saved dates whose next yearly occurrence is near, soonest first',
    description:
      'Recurrence is by month/day, so a birthday saved with a 1999 date surfaces every year. ' +
      'Each row carries nextOccurrence, daysAway and turningAge.',
  })
  @ApiQuery({ name: 'withinDays', required: false, type: Number })
  upcoming(
    @CurrentUser('id') userId: string,
    @Query() query: UpcomingOccasionsQueryDto,
  ): Promise<UpcomingOccasionView[]> {
    return this.dates.upcoming(userId, query.withinDays);
  }

  @Post()
  @ApiOperation({ summary: 'Save a date (person, relationship, occasion, when)' })
  @ApiResponseDoc({ status: 400, description: 'TAXONOMY_VALUE_INVALID — unknown occasionKey' })
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateImportantDateDto,
  ): Promise<ImportantDateView> {
    return this.dates.create(userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a saved date' })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<void> {
    return this.dates.remove(userId, id);
  }
}
