import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import { SuggestionsService } from './suggestions.service';
import type { InviteSuggestionsView } from './suggestions.views';

/**
 * The token is unguessable, but this is unauthenticated, so the bucket bounds
 * anyone hammering it — the same limit the rest of the public invite surface
 * uses, and it matters more here because each miss can reach a paid search.
 */
const PUBLIC_INVITE_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

/**
 * "What could I bring?", for somebody holding an invitation.
 *
 * Lives here rather than beside the other public invite routes because it is a
 * shelf of products, and events knows nothing about products. It reads the
 * invitation through the same narrow lookup profile screens use for shared
 * events, and takes nothing from the caller but the token.
 *
 * [OptionalJwtAuthGuard] to match the invite controller: a signed-in guest is
 * still just a guest here, and is shown the same shelf as everybody else. Who
 * they are changes nothing, which is the point — the celebrant's own taste is
 * for their WishMates, and an invitation does not make anyone one.
 */
@ApiTags('public')
@Controller('public/invites')
@Public()
@UseGuards(OptionalJwtAuthGuard)
export class PublicInviteSuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get(':token/gift-suggestions')
  @Throttle(PUBLIC_INVITE_THROTTLE)
  @ApiOperation({
    summary: 'Gift ideas for the celebration behind an invite token',
    description:
      'Curated from the invitation — the kind of event, and who the host said it is for. ' +
      'Never from the celebrant’s own taste, and never carrying a user id: a guest is not ' +
      'a WishMate. `personalised` is always false. An unavailable search returns an empty ' +
      'shelf rather than an error.',
  })
  @ApiResponseDoc({ status: 404, description: 'INVITE_TOKEN_INVALID' })
  forInvite(@Param('token') token: string): Promise<InviteSuggestionsView> {
    return this.suggestions.forInvite(token);
  }
}
