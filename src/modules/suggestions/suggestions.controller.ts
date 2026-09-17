import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { GiftSuggestionsQueryDto } from './dto/suggestions.dto';
import { SuggestionsService } from './suggestions.service';
import type { GiftSuggestionsView } from './suggestions.views';

/**
 * Each request can reach the paid product search up to three times, so it is
 * held to the same pace as product search itself.
 */
const SUGGESTIONS_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

/**
 * Gift ideas for a person.
 *
 * No route prefix, like `WishmatesController`: this hangs off `/people/:id`,
 * which is where the app already is when it asks.
 */
@ApiTags('suggestions')
@Controller()
@ApiBearerAuth()
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get('people/:userId/gift-suggestions')
  @Throttle(SUGGESTIONS_THROTTLE)
  @ApiOperation({
    summary: 'Gift ideas for a WishMate, ranked by what they like',
    description:
      'Accepted WishMates and the person themself only. `personalised` is false when ' +
      'the shelf could not honestly be tuned to them — see `reasonCode`.',
  })
  @ApiResponseDoc({ status: 403, description: 'NOT_WISHMATES' })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND' })
  @ApiResponseDoc({ status: 503, description: 'PRODUCT_SEARCH_UNAVAILABLE' })
  giftSuggestions(
    @CurrentUser('id') viewerId: string,
    @Param('userId') userId: string,
    @Query() query: GiftSuggestionsQueryDto,
  ): Promise<GiftSuggestionsView> {
    return this.suggestions.forPerson(viewerId, userId, query);
  }
}
