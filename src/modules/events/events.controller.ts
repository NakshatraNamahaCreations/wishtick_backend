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
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import {
  BulkDeleteEventsDto,
  BulkInviteDto,
  CreateEventDto,
  ExportGuestListQueryDto,
  InviteByPhoneDto,
  ListTemplatesQueryDto,
  PreviewInviteDto,
  SubmitEventWishlistDto,
  UpdateEventDto,
} from './dto/event.dto';
import { EventWishlistsService, type EventWishlistSubmissionView } from './event-wishlists.service';
import { EventsService } from './events.service';
import type { EventView, InvitedEventView, InviteView } from './event.views';
import { InvitePreviewService, type InvitePreview } from './invite-preview.service';
import { InvitesService, type BulkInviteResult } from './invites.service';
import { GuestListExportService, GuestListFormat } from './guest-list-export.service';
import { templatesForType, type InviteTemplate } from './invite-templates.data';
import { InviteNotificationsService } from './invite-notifications.service';
import type { EventInviteDocument } from './schemas/event-invite.schema';
import type { EventDocument } from './schemas/event.schema';

/** Each invite is a real email or SMS with a real cost. */
const INVITE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
/** Rendering a card is CPU work; a loop would be a cheap way to burn a core. */
const PREVIEW_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@ApiTags('events')
@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly eventWishlists: EventWishlistsService,
    private readonly invites: InvitesService,
    private readonly previews: InvitePreviewService,
    private readonly notifications: InviteNotificationsService,
    private readonly guestListExport: GuestListExportService,
  ) {}

  // ── Templates ─────────────────────────────────────────────────────────────

  @Get('invite-templates')
  @Public()
  @ApiOperation({
    summary: 'Invite designs and their colour variants',
    description: 'Public so a client can render the picker before an event exists.',
  })
  listTemplates(@Query() query: ListTemplatesQueryDto): { templates: InviteTemplate[] } {
    const templates = templatesForType(query.eventType);
    return { templates };
  }

  // ── Events ────────────────────────────────────────────────────────────────

  @Post('events')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create an event (starts as a draft)' })
  @ApiResponseDoc({ status: 403, description: 'WISHLIST_NOT_LINKABLE — you must own the wishlist' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateEventDto): Promise<EventView> {
    return this.events.create(userId, dto);
  }

  @Post('events/by-slug/:slug/join')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Join a public event from its share link',
    description:
      'Mints this user’s own invite and returns its token, which the invite screen and the RSVP ' +
      'endpoints already run on. Idempotent — a link tapped twice, forwarded, or reopened after ' +
      'an install lands on the same invite rather than stacking up rows. Authenticated, unlike ' +
      'the token endpoints: a public link names nobody, so identity comes from the session.',
  })
  @ApiResponseDoc({
    status: 404,
    description:
      'EVENT_NOT_FOUND — unknown slug, a draft, cancelled, or an invite the host revoked. ' +
      'Deliberately indistinguishable: the slug is public and a stranger learns nothing beyond ' +
      '“not for you”.',
  })
  @ApiResponseDoc({
    status: 403,
    description:
      'EVENT_INVITE_REQUIRED — the event is private and the caller is not on its guest list. ' +
      'Named rather than folded into the 404 because a host now sends this link to phone ' +
      'numbers, and somebody who was sent it needs to be told why it will not open. A private ' +
      'event opens only for a *verified* number the host invited.',
  })
  @ApiResponseDoc({ status: 400, description: 'CANNOT_INVITE_HOST — you are hosting this one' })
  async joinBySlug(
    @CurrentUser('id') userId: string,
    @Param('slug') slug: string,
  ): Promise<{ token: string }> {
    const invite = await this.invites.joinBySlug(slug, userId);
    return { token: invite.token };
  }

  @Get('events/mine')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Events you host, with RSVP counts' })
  listMine(@CurrentUser('id') userId: string): Promise<EventView[]> {
    return this.events.listMine(userId);
  }

  @Get('events/invited')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Events you've been invited to" })
  async listInvited(@CurrentUser('id') userId: string): Promise<InvitedEventView[]> {
    const invites = await this.invites.listInvitesForUser(userId);
    const found: Array<{ invite: EventInviteDocument; event: EventDocument }> = [];

    for (const invite of invites) {
      const event = await this.events.findOrFail(invite.eventId.toString()).catch(() => null);
      if (event) found.push({ invite, event });
    }

    // Who is hosting, in one lookup for the whole list rather than one per row.
    const hosts = await this.invites.hostNamesFor(found.map((f) => f.event.hostId.toString()));

    return found.map(({ invite, event }) => ({
      id: event._id.toString(),
      title: event.title,
      type: event.type,
      startsAt: event.startsAt,
      timezone: event.timezone,
      coverUrl: event.coverUrl,
      // The same invitation the guest's invite page shows. Left out, the list
      // drew a blank tile for every event made in the app — they carry a card
      // and no cover.
      inviteMediaUrl: event.inviteMediaUrl,
      hostName: hosts.get(event.hostId.toString()) ?? null,
      myRsvp: invite.rsvp,
      // Their own token, so the app can deep-link them into the invite.
      inviteToken: invite.token,
    }));
  }

  @Get('events/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One event you host' })
  @ApiResponseDoc({ status: 404, description: 'EVENT_NOT_FOUND — 404, never 403, for non-hosts' })
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<EventView> {
    return this.events.getOne(id, userId);
  }

  @Patch('events/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update an event',
    description: 'Moving startsAt reschedules every reminder for a published event.',
  })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
  ): Promise<EventView> {
    return this.events.update(id, userId, dto);
  }

  @Post('events/:id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Publish an event',
    description: 'Enables invites and schedules the T-7d / T-1d / T-2h reminders.',
  })
  @ApiResponseDoc({ status: 409, description: 'EVENT_ALREADY_PUBLISHED' })
  @ApiResponseDoc({ status: 400, description: 'EVENT_DATE_IN_PAST' })
  async publish(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<EventView> {
    const view = await this.events.publish(id, userId);
    // Render the share card once the event is real, so the first WhatsApp share
    // already unfurls with artwork.
    const event = await this.events.findOwnedOrFail(id, userId);
    await this.previews.refreshEventCard(event).catch(() => undefined);
    return view;
  }

  @Post('events/bulk-delete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete events permanently (multi-select)',
    description:
      'Unlike cancel, the rows are removed — any invite link for them stops ' +
      'resolving. Ids the caller does not host are skipped, not rejected.',
  })
  bulkDelete(
    @CurrentUser('id') userId: string,
    @Body() dto: BulkDeleteEventsDto,
  ): Promise<{ deleted: number }> {
    return this.events.deleteMany(dto.ids, userId);
  }

  @Delete('events/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cancel an event',
    description: 'Kept, not deleted — invitees hold links. Cancels every reminder.',
  })
  cancel(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<EventView> {
    return this.events.cancel(id, userId);
  }

  @Post('events/:id/invite/preview')
  @HttpCode(HttpStatus.OK)
  @Throttle(PREVIEW_THROTTLE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Preview the invite card',
    description: 'Server-validated. Renders the same PNG guests will see unfurled.',
  })
  @ApiResponseDoc({ status: 400, description: 'INVITE_TEMPLATE_UNKNOWN' })
  async preview(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: PreviewInviteDto,
  ): Promise<InvitePreview> {
    const event = await this.events.findOwnedOrFail(id, userId);
    return this.previews.build(event, dto.inviteTemplate);
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  @Get('events/:id/invites')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The guest list (host only)' })
  listInvites(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<InviteView[]> {
    return this.invites.list(id, userId);
  }

  @Get('events/:id/invites/export')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Download the guest list (host only)',
    description:
      'PDF, Excel or CSV, as offered by "Download Guest List" (`4096:206`). All three are ' +
      'built from one projection, so the columns cannot drift between formats.',
  })
  @ApiQuery({ name: 'format', enum: GuestListFormat, required: false })
  async exportInvites(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ExportGuestListQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { event, invites } = await this.invites.listForExport(id, userId);
    const file = await this.guestListExport.render(
      event,
      invites,
      query.format ?? GuestListFormat.PDF,
    );
    res.set({
      'Content-Type': file.contentType,
      // `attachment` so a browser saves it rather than trying to render a
      // spreadsheet inline; the quoted filename survives spaces.
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': String(file.buffer.length),
    });
    return new StreamableFile(file.buffer);
  }

  @Post('events/:id/invites')
  @HttpCode(HttpStatus.OK)
  @Throttle(INVITE_THROTTLE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Invite people',
    description:
      'Bulk. Duplicates are collapsed rather than rejected — a contact list routinely repeats ' +
      'someone, and failing 50 invites over one repeat helps nobody.',
  })
  @ApiResponseDoc({ status: 409, description: 'EVENT_NOT_PUBLISHED / INVITE_LIMIT_REACHED' })
  invite(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: BulkInviteDto,
  ): Promise<BulkInviteResult> {
    return this.invites.inviteMany(id, userId, dto);
  }

  @Post('events/:id/invites/by-phone')
  @HttpCode(HttpStatus.OK)
  @Throttle(INVITE_THROTTLE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Invite people by phone number, from the host’s contacts',
    description:
      'For the friends who are not on Wishtick yet, which on day one is most of them. Each ' +
      'number becomes a guest-list row addressed to the number itself; it binds to an account ' +
      'the first time somebody with that number, verified, opens the event link. A number that ' +
      'already has an account is bound immediately, so the guest list names them at once. ' +
      'Duplicates are collapsed rather than rejected.',
  })
  @ApiResponseDoc({ status: 409, description: 'EVENT_NOT_PUBLISHED / INVITE_LIMIT_REACHED' })
  inviteByPhone(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: InviteByPhoneDto,
  ): Promise<BulkInviteResult> {
    return this.invites.inviteByPhone(id, userId, dto.phones);
  }

  @Delete('events/:id/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke an invite',
    description: 'The token stops working immediately, as does any event-only wishlist access.',
  })
  async revoke(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    await this.invites.revoke(id, inviteId, userId);
  }

  @Get('events/:id/invites/:inviteId/link')
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get one invitee's personal link, to share by hand",
    description:
      'For sharing an invitation outside the app. Fetched one at a time and never included in ' +
      'the guest list, because the token is that guest’s credential.',
  })
  @ApiResponseDoc({ status: 404, description: 'INVITE_NOT_FOUND' })
  async inviteLink(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ): Promise<{ url: string }> {
    const token = await this.invites.getTokenForHost(id, inviteId, userId);
    return { url: this.notifications.inviteUrl(token) };
  }

  // ── Guests offering their own wishlists ───────────────────────────────

  @Post('events/:id/wishlist-requests')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Offer one of your wishlists to an event you are going to',
    description:
      'Accepted invitees only. The host has to approve it before it appears on the ' +
      'invitation, and a wishlist may belong to one event at a time.',
  })
  @ApiResponseDoc({ status: 404, description: 'EVENT_NOT_FOUND / WISHLIST_NOT_FOUND' })
  @ApiResponseDoc({ status: 409, description: 'Already offered, or already on an event' })
  submitWishlist(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SubmitEventWishlistDto,
  ): Promise<EventWishlistSubmissionView> {
    return this.eventWishlists.submit(id, userId, dto.wishlistId);
  }

  @Get('events/:id/wishlist-requests')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Wishlists guests have offered to this event (host only)' })
  wishlistRequests(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<EventWishlistSubmissionView[]> {
    return this.eventWishlists.listForHost(id, userId);
  }

  @Get('event-wishlist-requests/mine')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Wishlists you have offered, and whether they were taken' })
  myWishlistRequests(@CurrentUser('id') userId: string): Promise<EventWishlistSubmissionView[]> {
    return this.eventWishlists.listMine(userId);
  }

  @Post('events/:id/wishlist-requests/:requestId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Show a guest’s wishlist on this event',
    description:
      'Links the list to the event and, if it was private, lifts it to EVENT_ONLY so the ' +
      'event’s accepted guests can actually open it.',
  })
  approveWishlist(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ): Promise<EventWishlistSubmissionView> {
    return this.eventWishlists.respond(id, requestId, userId, true);
  }

  @Post('events/:id/wishlist-requests/:requestId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Turn down a guest’s wishlist' })
  rejectWishlist(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ): Promise<EventWishlistSubmissionView> {
    return this.eventWishlists.respond(id, requestId, userId, false);
  }

  @Delete('events/:id/wishlist-requests/:requestId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Take a wishlist back off the event',
    description:
      'Either side may: the host curates the event, and the owner must not be trapped into ' +
      'showing a list they have changed their mind about. The list’s visibility is put back ' +
      'where approval found it.',
  })
  removeWishlist(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ): Promise<EventWishlistSubmissionView> {
    return this.eventWishlists.remove(id, requestId, userId);
  }
}
