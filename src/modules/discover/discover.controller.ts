import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { DiscoverService } from './discover.service';
import type { DiscoverFeed, DiscoverSection } from './discover.types';

/**
 * The Discover tab (Figma `280:131`) — a personalised shelf per approaching
 * saved date, then price-band and premium shelves.
 */
@ApiTags('discover')
@Controller('discover')
@ApiBearerAuth()
export class DiscoverController {
  constructor(private readonly discover: DiscoverService) {}

  @Get('feed')
  @ApiOperation({
    summary: 'The Discover feed, in display order',
    description:
      'Sections are curated by occasion, not by the recipient — Wishtick knows when a ' +
      'friend’s birthday is, never what they like. Each section carries an exploreQuery ' +
      'that /products/search accepts verbatim for the "Explore More" grid. Sections whose ' +
      'search failed are omitted rather than returned empty.',
  })
  feed(@CurrentUser('id') userId: string): Promise<DiscoverFeed> {
    return this.discover.feed(userId);
  }

  @Get('occasions/:occasionKey')
  @ApiOperation({
    summary: 'One shelf of gifts for an occasion',
    description:
      "Backs Home's celebration grid. The occasion → category curation stays " +
      'server-side, so the grid only has to pass the key it got from ' +
      '/onboarding/options.',
  })
  @ApiResponseDoc({ status: 400, description: 'TAXONOMY_VALUE_INVALID — unknown occasion' })
  occasionShelf(@Param('occasionKey') occasionKey: string): Promise<DiscoverSection> {
    return this.discover.occasionShelf(occasionKey);
  }
}
