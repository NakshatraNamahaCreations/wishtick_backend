import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { GiftLifecycleEvent } from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { Gift, type GiftDocument } from 'src/modules/gifting/schemas/gift.schema';
import { MediaService } from 'src/modules/media/media.service';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { UsersService } from 'src/modules/users/users.service';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import { THANK_YOU_SEND_JOB, thankYouJobId, type ThankYouSendJobData } from './notification.jobs';
import { NotificationService } from './notification.service';
import { NotificationType } from './notification.types';
import {
  THANK_YOU_KINDS_WITH_MEDIA,
  ThankYouKind,
  ThankYouNote,
  ThankYouStatus,
  type ThankYouNoteDocument,
} from './schemas/thank-you-note.schema';

@Injectable()
export class ThankYouService {
  private readonly logger = new Logger(ThankYouService.name);

  constructor(
    @InjectModel(ThankYouNote.name) private readonly noteModel: Model<ThankYouNoteDocument>,
    @InjectModel(Gift.name) private readonly giftModel: Model<GiftDocument>,
    @InjectModel(WishlistItem.name) private readonly itemModel: Model<WishlistItemDocument>,
    @InjectModel(Wishlist.name) private readonly wishlistModel: Model<WishlistDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectQueue(QUEUE.NOTIFICATIONS) private readonly queue: Queue,
    private readonly users: UsersService,
    private readonly media: MediaService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * On a fulfilled gift, draft a thank-you note and schedule it to auto-send
   * after the configured delay — unless the author has turned auto-send off, in
   * which case it stays a draft they can send by hand.
   */
  async onGiftFulfilled(e: GiftLifecycleEvent): Promise<void> {
    // One note per gift; a re-fired event is a no-op via the unique giftId index.
    if (await this.noteModel.exists({ giftId: new Types.ObjectId(e.giftId) })) return;

    const [gift, item, recipient, gifter] = await Promise.all([
      this.giftModel.findById(e.giftId).exec(),
      this.itemModel.findById(e.itemId).exec(),
      this.users.findById(e.recipientId),
      this.users.findById(e.gifterId),
    ]);
    if (!gift) return;

    const recipientName = recipient?.name?.trim() || 'A friend';
    const gifterName = gifter?.name?.trim() || 'a friend';
    const itemTitle = item?.title ?? 'your gift';

    // Optional event context, if the wishlist is tied to an event.
    let eventTitle: string | null = null;
    let eventDate: Date | null = null;
    const wishlist = await this.wishlistModel.findById(e.wishlistId).exec();
    if (wishlist?.eventId) {
      const event = await this.eventModel.findById(wishlist.eventId).exec();
      if (event) {
        eventTitle = event.title;
        eventDate = event.startsAt ?? null;
      }
    }

    const pref = await this.notifications.getOrCreatePreference(e.recipientId);
    const autoSend = pref.thankYouAutoSend;
    const delayMs =
      this.config.get('notifications.thankYouDelayHours', { infer: true }) * 3_600_000;
    const scheduledFor = new Date(Date.now() + delayMs);

    const note = await this.noteModel.create({
      giftId: new Types.ObjectId(e.giftId),
      recipientId: new Types.ObjectId(e.recipientId),
      gifterId: new Types.ObjectId(e.gifterId),
      context: { recipientName, gifterName, itemTitle, eventTitle, eventDate },
      subject: `Thank you for ${itemTitle}`,
      body: ThankYouService.defaultBody(gifterName, itemTitle, recipientName, eventTitle),
      status: autoSend ? ThankYouStatus.SCHEDULED : ThankYouStatus.DRAFT,
      scheduledFor: autoSend ? scheduledFor : null,
    });

    if (autoSend) {
      await this.queue.add(
        THANK_YOU_SEND_JOB,
        { noteId: note._id.toString() } satisfies ThankYouSendJobData,
        { delay: delayMs, jobId: thankYouJobId(note._id.toString()), removeOnComplete: true },
      );
    }
  }

  /** The delayed job: send it if it is still scheduled (not edited-away/skipped/sent). */
  async fireScheduled(noteId: string): Promise<void> {
    const note = await this.noteModel.findById(noteId).exec();
    if (!note || note.status !== ThankYouStatus.SCHEDULED) return;
    await this.deliver(note);
  }

  async get(noteId: string, userId: string): Promise<ThankYouNoteDocument> {
    const note = await this.loadOwn(noteId, userId);
    return note;
  }

  async list(userId: string): Promise<ThankYouNoteDocument[]> {
    return this.noteModel
      .find({ recipientId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();
  }

  /**
   * The compose screens (`2015:271`, `2015:382`, `2209:104`) all land here.
   *
   * A recorded photo/voice/video *attaches* to the note; it never replaces the
   * subject and body, because what reaches the gifter's inbox is an email and
   * no mail client plays a voice note. The attachment is what the in-app
   * preview and the arrival card render.
   */
  async edit(
    noteId: string,
    userId: string,
    input: { subject?: string; body?: string; kind?: ThankYouKind; mediaId?: string | null },
  ): Promise<ThankYouNoteDocument> {
    const note = await this.loadOwn(noteId, userId);
    this.assertUnsent(note);
    if (input.subject) note.subject = input.subject;
    if (input.body) note.body = input.body;
    if (input.kind !== undefined) await this.attachMedia(note, userId, input.kind, input.mediaId);
    note.editedAt = new Date();
    await note.save();
    return note;
  }

  /**
   * Points the note at an upload the caller owns, or clears it for a text note.
   *
   * Ownership is re-checked here rather than trusted from the client: a media
   * id is guessable, and without this anyone could attach someone else's
   * recording to their own note and have it rendered under their name.
   */
  private async attachMedia(
    note: ThankYouNoteDocument,
    userId: string,
    kind: ThankYouKind,
    mediaId?: string | null,
  ): Promise<void> {
    if (!THANK_YOU_KINDS_WITH_MEDIA.includes(kind)) {
      note.kind = kind;
      note.mediaId = null;
      note.mediaUrl = null;
      return;
    }
    if (!mediaId) {
      throw new AppException(
        ErrorCode.THANK_YOU_MEDIA_REQUIRED,
        `A ${kind} thank-you needs a recording`,
        400,
      );
    }
    const media = await this.media.getReadyOwned(userId, mediaId);
    if (media.purpose !== MediaPurpose.THANK_YOU) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'This media was not uploaded as a thank-you',
        400,
      );
    }
    ThankYouService.assertKindMatchesMedia(kind, media.contentType);
    note.kind = kind;
    note.mediaId = media._id;
    note.mediaUrl = media.url;
  }

  /**
   * A photo note must carry an image and a video note a video — the kind is
   * what the client picks a player for, so a mismatch is a broken screen.
   */
  private static assertKindMatchesMedia(kind: ThankYouKind, contentType: string | null): void {
    const family = (contentType ?? '').split('/')[0];
    const expected: Record<string, string> = {
      [ThankYouKind.PHOTO]: 'image',
      [ThankYouKind.AUDIO]: 'audio',
      [ThankYouKind.VIDEO]: 'video',
    };
    if (expected[kind] && family !== expected[kind]) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        `A ${kind} thank-you needs ${expected[kind]} media, not ${contentType ?? 'unknown'}`,
        400,
      );
    }
  }

  async sendNow(noteId: string, userId: string): Promise<ThankYouNoteDocument> {
    const note = await this.loadOwn(noteId, userId);
    this.assertUnsent(note);
    await this.deliver(note);
    return note;
  }

  async skip(noteId: string, userId: string): Promise<ThankYouNoteDocument> {
    const note = await this.loadOwn(noteId, userId);
    this.assertUnsent(note);
    note.status = ThankYouStatus.SKIPPED;
    await note.save();
    await this.cancelJob(noteId);
    return note;
  }

  private async deliver(note: ThankYouNoteDocument): Promise<void> {
    // Route through the pipeline so the gifter's suppression/consent still apply.
    await this.notifications.enqueue({
      userId: note.gifterId.toString(),
      type: NotificationType.THANK_YOU,
      refId: note._id.toString(),
      payload: {
        subject: note.subject,
        body: note.body,
        gifterName: note.context.gifterName,
        recipientName: note.context.recipientName,
        itemTitle: note.context.itemTitle,
        // Carried so the in-app card can play the recording without a second
        // fetch. The email template only ever renders subject and body.
        kind: note.kind,
        mediaUrl: note.mediaUrl,
      },
    });
    note.status = ThankYouStatus.SENT;
    note.sentAt = new Date();
    await note.save();
    await this.cancelJob(note._id.toString());
  }

  private async loadOwn(noteId: string, userId: string): Promise<ThankYouNoteDocument> {
    if (!Types.ObjectId.isValid(noteId)) {
      throw new AppException(ErrorCode.THANK_YOU_NOTE_NOT_FOUND, 'Thank-you note not found', 404);
    }
    const note = await this.noteModel.findById(noteId).exec();
    if (!note) {
      throw new AppException(ErrorCode.THANK_YOU_NOTE_NOT_FOUND, 'Thank-you note not found', 404);
    }
    if (note.recipientId.toString() !== userId) {
      throw new AppException(
        ErrorCode.NOT_THE_SENDER_OF_NOTE,
        'This thank-you note is not yours to manage',
        403,
      );
    }
    return note;
  }

  private assertUnsent(note: ThankYouNoteDocument): void {
    if (note.status === ThankYouStatus.SENT) {
      throw new AppException(
        ErrorCode.THANK_YOU_ALREADY_SENT,
        'This thank-you note has already been sent',
        409,
      );
    }
  }

  private async cancelJob(noteId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(thankYouJobId(noteId));
      await job?.remove();
    } catch (err) {
      // A surviving job re-validates state (status !== SCHEDULED) and no-ops.
      this.logger.debug(`Could not remove thank-you job for ${noteId}: ${String(err)}`);
    }
  }

  private static defaultBody(
    gifterName: string,
    itemTitle: string,
    recipientName: string,
    eventTitle: string | null,
  ): string {
    const occasion = eventTitle ? ` for ${eventTitle}` : '';
    return (
      `Dear ${gifterName},\n\n` +
      `Thank you so much for ${itemTitle}${occasion}. It truly means a lot, and I'm so grateful ` +
      `you thought of me.\n\nWith love,\n${recipientName}`
    );
  }
}
