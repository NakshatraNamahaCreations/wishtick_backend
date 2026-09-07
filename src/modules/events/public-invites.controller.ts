import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import type { OpenGraphPreview } from 'src/modules/wishlists/wishlist.views';
import { RsvpDto } from './dto/event.dto';
import type { PublicInviteView } from './event.views';
import { PublicInvitesService } from './public-invites.service';

/**
 * The token is unguessable (32 bytes), but these endpoints are unauthenticated,
 * so the bucket bounds anyone hammering them.
 */
const PUBLIC_INVITE_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

/**
 * The invitee-facing surface. No account required — the token *is* the
 * authorization, because requiring a signup to answer a party invitation is
 * the fastest way to collect no RSVPs at all.
 *
 * OptionalJwtAuthGuard rather than bare `@Public()`: a guest who *is* signed in
 * gets their account attached to the invite, which is what later makes an
 * EVENT_ONLY wishlist resolve for them. Without it their token would work but
 * the linked wishlist would stay invisible — see the redirect controller for
 * the same trap.
 */
@ApiTags('public')
@Controller('public/invites')
@Public()
@UseGuards(OptionalJwtAuthGuard)
export class PublicInvitesController {
  constructor(private readonly invites: PublicInvitesService) {}

  @Get(':token')
  @Throttle(PUBLIC_INVITE_THROTTLE)
  @ApiOperation({
    summary: 'Open an invite',
    description:
      'Redacted: host first name only, and each linked wishlist is resolved through ' +
      'AccessPolicyService, so an event-only list appears only once you have RSVP’d.',
  })
  @ApiResponseDoc({ status: 404, description: 'INVITE_TOKEN_INVALID' })
  getByToken(
    @Param('token') token: string,
    @Req() req: Request & { user?: AuthenticatedUser },
  ): Promise<PublicInviteView> {
    return this.invites.getByToken(token, req.user?.id);
  }

  @Post(':token/rsvp')
  @HttpCode(HttpStatus.OK)
  @Throttle(PUBLIC_INVITE_THROTTLE)
  @ApiOperation({
    summary: 'RSVP, with or without an account',
    description: 'Idempotent — a guest changing their mind is expected.',
  })
  @ApiResponseDoc({ status: 409, description: 'EVENT_CANCELLED / EVENT_NOT_PUBLISHED' })
  rsvp(
    @Param('token') token: string,
    @Body() dto: RsvpDto,
    @Req() req: Request & { user?: AuthenticatedUser },
  ): Promise<PublicInviteView> {
    return this.invites.rsvp(token, dto, req.user?.id);
  }
}

@ApiTags('public')
@Controller('public/events')
@Public()
export class PublicEventsController {
  constructor(private readonly invites: PublicInvitesService) {}

  @Get(':slug/preview')
  @Throttle(PUBLIC_INVITE_THROTTLE)
  @ApiOperation({
    summary: 'Open Graph metadata for an event share link',
    description:
      "Unfurled by WhatsApp's servers into a chat before anyone opens the link, so it carries " +
      'only the title, the rendered card, and the host’s first name. Drafts are never shareable.',
  })
  @ApiResponseDoc({ status: 404, description: 'EVENT_NOT_FOUND' })
  getPreview(@Param('slug') slug: string): Promise<OpenGraphPreview> {
    return this.invites.getEventPreview(slug);
  }
}
