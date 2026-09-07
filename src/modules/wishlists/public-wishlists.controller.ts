import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import type { Request } from 'express';
import { PublicWishlistQueryDto } from './dto/wishlist.dto';
import { PublicWishlistsService } from './public-wishlists.service';
import type { OpenGraphPreview, PublicWishlistView } from './wishlist.views';

/**
 * A slug is unguessable (~2^80), but this endpoint is unauthenticated, so the
 * bucket also bounds a passcode-guessing loop against a known link.
 */
const PUBLIC_SHARE_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('public')
@Controller('public/wishlists')
@Public()
// OptionalJwtAuthGuard rather than bare `@Public()`, for the same reason the
// invite surface uses it: a viewer who *is* signed in may be an accepted guest
// of the event this list is attached to, and resolving on the link alone
// refuses them a list the invitation just offered.
@UseGuards(OptionalJwtAuthGuard)
export class PublicWishlistsController {
  constructor(private readonly publicWishlists: PublicWishlistsService) {}

  @Get(':slug')
  @Throttle(PUBLIC_SHARE_THROTTLE)
  @ApiOperation({
    summary: 'Open a shared wishlist without an account',
    description:
      'Redacted: no owner contact details, no owner id, and no gifter identity — a claimed item ' +
      'reports only `isClaimed: true`. A private list is never openable by link, whatever the ' +
      'slug; an event-only one opens for a signed-in accepted guest of its event and nobody else.',
  })
  @ApiResponseDoc({ status: 404, description: 'SHARE_LINK_INVALID' })
  @ApiResponseDoc({ status: 401, description: 'SHARE_PASSCODE_REQUIRED' })
  @ApiResponseDoc({ status: 403, description: 'SHARE_PASSCODE_INVALID' })
  @ApiResponseDoc({ status: 410, description: 'SHARE_LINK_EXPIRED' })
  getBySlug(
    @Param('slug') slug: string,
    @Query() query: PublicWishlistQueryDto,
    @Req() req: Request & { user?: AuthenticatedUser },
  ): Promise<PublicWishlistView> {
    return this.publicWishlists.getBySlug(slug, query.passcode, req.user?.id);
  }

  @Get(':slug/preview')
  @Throttle(PUBLIC_SHARE_THROTTLE)
  @ApiOperation({
    summary: 'Open Graph metadata for a link preview',
    description:
      "Rendered by WhatsApp's servers into the chat before anyone opens the link, so it carries " +
      'even less than the public view.',
  })
  getPreview(
    @Param('slug') slug: string,
    @Query() query: PublicWishlistQueryDto,
  ): Promise<OpenGraphPreview> {
    return this.publicWishlists.getPreviewBySlug(slug, query.passcode);
  }
}
