import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import {
  CreateImportantDateDto,
  LinkImportantDateDto,
  UpdateImportantDateDto,
} from './dto/important-date.dto';
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

  @Patch(':id')
  @ApiOperation({ summary: 'Change a saved date' })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  @ApiResponseDoc({ status: 400, description: 'TAXONOMY_VALUE_INVALID — unknown occasionKey' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateImportantDateDto,
  ): Promise<ImportantDateView> {
    return this.dates.update(userId, id, dto);
  }

  /**
   * Links a saved date to the account that person actually has.
   *
   * Only for an accepted WishMate — and the link stops counting the moment
   * that stops being true, because every read re-checks it.
   */
  @Put(':id/link')
  @ApiOperation({
    summary: 'Say that a saved date is one of your WishMates',
    description:
      'Lets gift ideas for this person come from what they said they like, instead of ' +
      'from the occasion alone. Re-checked on every read, so removing them as a WishMate ' +
      'takes effect at once.',
  })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  @ApiResponseDoc({ status: 403, description: 'NOT_WISHMATES — they are not an accepted WishMate' })
  link(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: LinkImportantDateDto,
  ): Promise<ImportantDateView> {
    return this.dates.link(userId, id, dto.userId);
  }

  @Delete(':id/link')
  @ApiOperation({ summary: 'Forget the account behind a saved date, keeping the date' })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  unlink(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<ImportantDateView> {
    return this.dates.unlink(userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a saved date' })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<void> {
    return this.dates.remove(userId, id);
  }
}
