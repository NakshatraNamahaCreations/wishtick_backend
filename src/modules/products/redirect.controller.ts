import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import { ClickTrackingService } from './click-tracking.service';

const REDIRECT_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

/**
 * Outbound affiliate redirect.
 *
 * Serves two callers at once, which is why the guards look odd:
 *  - an anonymous visitor arriving from a public share link, who has no token;
 *  - a signed-in user — often the wishlist's own owner — who does.
 *
 * `@Public()` alone would skip authentication entirely and leave `request.user`
 * empty, so the owner of a PRIVATE wishlist clicking their own item would be
 * anonymous to the access policy and get a 404 on their own link.
 * OptionalJwtAuthGuard reads the token when there is one and shrugs when there
 * is not. Either way the target wishlist is authorized through
 * AccessPolicyService, so a private item's link stays private: "no token
 * required" never means "no check".
 */
@ApiExcludeController()
@Controller('r')
@Public()
@UseGuards(OptionalJwtAuthGuard)
export class RedirectController {
  constructor(private readonly clicks: ClickTrackingService) {}

  /**
   * A click straight off the catalogue, before anything is saved.
   *
   * Declared ahead of `:itemId` so `/r/p/...` is not swallowed by it — an
   * ObjectId-shaped check would not save us, because Nest matches on order,
   * not on shape.
   *
   * `?offer=N` picks one seller out of the product's list; without it the
   * product's own destination is used.
   */
  @Get('p/:provider/:externalId')
  @Throttle(REDIRECT_THROTTLE)
  async redirectToProduct(
    @Param('provider') provider: string,
    @Param('externalId') externalId: string,
    @Query('offer') offer: string | undefined,
    @Req() req: Request & { user?: AuthenticatedUser },
    @Res() res: Response,
  ): Promise<void> {
    const parsed = offer === undefined ? undefined : Number.parseInt(offer, 10);

    const destination = await this.clicks.resolveProductRedirect(provider, externalId, {
      userId: req.user?.id,
      referer: req.get('referer') ?? undefined,
      userAgent: req.get('user-agent') ?? undefined,
      // A non-numeric `?offer=` falls through to the product link rather than
      // 400ing: this URL is opened by a browser, and an error page in place of
      // the shop is a worse answer than the right shop's front door.
      offerIndex: parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined,
    });

    RedirectController.send(res, destination);
  }

  @Get(':itemId')
  @Throttle(REDIRECT_THROTTLE)
  async redirect(
    @Param('itemId') itemId: string,
    @Req() req: Request & { user?: AuthenticatedUser },
    @Res() res: Response,
  ): Promise<void> {
    const destination = await this.clicks.resolveRedirect(itemId, {
      // Set by OptionalJwtAuthGuard when a token was supplied; undefined for an
      // anonymous click from a public share link. Both are expected.
      userId: req.user?.id,
      referer: req.get('referer') ?? undefined,
      userAgent: req.get('user-agent') ?? undefined,
    });

    RedirectController.send(res, destination);
  }

  private static send(res: Response, destination: string): void {
    // 302, not 301: a permanent redirect would be cached by the browser and
    // every later click would skip us entirely — no tracking row, no payout
    // evidence, and no way to change the destination.
    res.setHeader('Cache-Control', 'no-store');
    // The destination is a merchant URL; do not leak our path in the referrer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, destination);
  }
}
