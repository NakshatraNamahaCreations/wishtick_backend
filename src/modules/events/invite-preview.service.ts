import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import type { InviteTemplateChoiceDto } from './dto/event.dto';
import { InviteCardRenderer, type CardContent } from './invite-card.renderer';
import {
  findTemplate,
  findVariant,
  type ColorVariant,
  type InviteTemplate,
} from './invite-templates.data';
import { Event, type EventDocument } from './schemas/event.schema';

export interface InvitePreview {
  templateId: string;
  colorVariant: string;
  /** The palette, so a client can render the same card natively. */
  palette: ColorVariant;
  /** Slot values after defaults and truncation — what will actually be drawn. */
  resolved: CardContent;
  /** The rasterized card. Regenerated when the design or the copy changes. */
  imageUrl: string | null;
}

@Injectable()
export class InvitePreviewService {
  private readonly logger = new Logger(InvitePreviewService.name);

  constructor(
    @InjectModel(Event.name) private readonly events: Model<EventDocument>,
    @Inject(STORAGE) private readonly storage: IStorageProvider,
    private readonly renderer: InviteCardRenderer,
  ) {}

  /**
   * Builds the preview a host sees before sharing, and renders the card.
   *
   * Server-validated on purpose: the client may not invent slots or palettes,
   * because the same spec drives the PNG that WhatsApp will show. If the client
   * rendered its own preview from arbitrary values, what the host approves and
   * what their guests receive would be two different pictures.
   */
  async build(event: EventDocument, override?: InviteTemplateChoiceDto): Promise<InvitePreview> {
    const choice = override ?? event.inviteTemplate;
    if (!choice) {
      throw new AppException(
        ErrorCode.INVITE_TEMPLATE_UNKNOWN,
        'Choose an invite template first',
        400,
      );
    }

    const template = findTemplate(choice.templateId);
    if (!template) {
      throw new AppException(
        ErrorCode.INVITE_TEMPLATE_UNKNOWN,
        `Unknown invite template: ${choice.templateId}`,
        400,
      );
    }
    const variant = findVariant(template, choice.colorVariant);
    if (!variant) {
      throw new AppException(
        ErrorCode.INVITE_TEMPLATE_UNKNOWN,
        `Unknown colour variant: ${choice.colorVariant}`,
        400,
      );
    }

    const resolved = InvitePreviewService.resolveSlots(template, event, choice.fields ?? {});
    const imageUrl = await this.renderAndStore(event, template, variant, resolved);

    return {
      templateId: template.id,
      colorVariant: variant.key,
      palette: variant,
      resolved,
      imageUrl,
    };
  }

  /**
   * Renders the card and stores it, keyed by a hash of its content.
   *
   * Content-addressed so re-previewing the same design is free and each distinct
   * design gets its own immutable URL — which matters because unfurlers cache
   * an og:image aggressively, and reusing one URL for changed artwork would
   * leave WhatsApp showing the old card indefinitely.
   */
  private async renderAndStore(
    event: EventDocument,
    template: InviteTemplate,
    variant: ColorVariant,
    content: CardContent,
  ): Promise<string | null> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ t: template.id, v: variant.key, c: content }))
      .digest('hex')
      .slice(0, 16);

    const storageKey = `events/${event._id.toString()}/invite-${fingerprint}.png`;

    try {
      const existing = await this.storage.head(storageKey);
      if (existing.exists) return this.storage.getPublicUrl(storageKey);

      const png = this.renderer.render(template, variant, content);
      await this.storage.putObject(storageKey, png, 'image/png');
      return this.storage.getPublicUrl(storageKey);
    } catch (err) {
      // A missing share card is a degraded preview, not a failed request: the
      // host still gets the palette and the resolved copy, and the link still
      // works — it just unfurls without artwork.
      this.logger.error(
        `Failed to render invite card for event ${event._id.toString()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Persists the rendered card onto the event, so the OG tag can point at it. */
  async refreshEventCard(event: EventDocument): Promise<string | null> {
    if (!event.inviteTemplate) return null;
    const preview = await this.build(event);
    if (preview.imageUrl && preview.imageUrl !== event.ogImageUrl) {
      await this.events.updateOne({ _id: event._id }, { $set: { ogImageUrl: preview.imageUrl } });
    }
    return preview.imageUrl;
  }

  /**
   * Fills the template's slots from host copy, falling back to event data.
   *
   * Unknown keys are ignored rather than rejected: a client that has cached an
   * older template list should still get a card, not a 400.
   */
  private static resolveSlots(
    template: InviteTemplate,
    event: EventDocument,
    fields: Record<string, string>,
  ): CardContent {
    const get = (key: string, fallback: string | null): string | null => {
      const slot = template.slots.find((s) => s.key === key);
      const raw = fields[key];
      if (typeof raw === 'string' && raw.trim()) {
        return slot ? raw.trim().slice(0, slot.maxLength) : raw.trim().slice(0, 160);
      }
      return fallback;
    };

    return {
      headline: get('headline', event.title) ?? event.title,
      subtitle: get('subtitle', null),
      hostLine: get('hostLine', null),
      // Falls back to the event's own venue (Sprint 7 put one on the event).
      // Before that field existed the only place a location could come from was
      // this slot, which is why an invite could show a time and no place.
      venue: get('venue', event.venue),
      note: get('note', null),
      // Always rendered in the event's own timezone — the card says when the
      // party is, not when the server thinks it is.
      dateLine: InvitePreviewService.formatDate(event.startsAt, event.timezone),
    };
  }

  private static formatDate(startsAt: Date, timezone: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
      }).format(startsAt);
    } catch {
      return startsAt.toISOString().slice(0, 16).replace('T', ' ');
    }
  }
}
