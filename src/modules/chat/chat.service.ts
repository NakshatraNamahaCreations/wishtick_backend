import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { AppException } from 'src/common/errors/app.exception';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CONTENT_FLAGGED, type ContentFlaggedEvent } from 'src/common/events/domain-events';
import { CacheService } from 'src/infra/redis/cache.service';
import { GroupGiftVisibility } from 'src/modules/group-gifts/group-gift.types';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import { AccessPolicyService } from 'src/modules/wishlists/access/access-policy.service';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import {
  CHAT_BROADCAST,
  CHAT_FORCE_LEAVE,
  ChatType,
  MessageKind,
  SystemMessageType,
  WS_EVENT,
  type ChatBroadcast,
  type ChatForceLeave,
} from './chat.types';
import type { PublicIdentity } from 'src/modules/wishmates/wishmates.views';
import {
  toChatView,
  toMessagePreviewView,
  toMessageView,
  type ChatView,
  type MessagePreviewView,
  type MessageView,
} from './chat.views';
import type { EditMessageDto, PostMessageDto } from './dto/chat.dto';
import { Chat, type ChatDocument } from './schemas/chat.schema';
import { Message, type MessageDocument } from './schemas/message.schema';
import { ReadReceipt, type ReadReceiptDocument } from './schemas/read-receipt.schema';

/** Per-user message rate limit: a burst guard, not a hard quota. */
const RATE_WINDOW_SECONDS = 10;
const RATE_MAX_MESSAGES = 20;

/** A tiny illustrative denylist. Real moderation is Sprint 11; this is the hook. */
const FLAGGED_WORDS = ['badword'];

interface AuthorizedChat {
  chat: ChatDocument;
  /**
   * The wishlist owner / group-gift recipient — the person a surprise is kept
   * from. Null for a direct chat, which has no owner and nothing to mask.
   */
  ownerId: string | null;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectModel(Chat.name) private readonly chatModel: Model<ChatDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(ReadReceipt.name) private readonly receiptModel: Model<ReadReceiptDocument>,
    // Read-only, for group-gift chat authorization. The chat module does NOT
    // import the group-gift module (that would be a cycle) — it reads the doc.
    @InjectModel(GroupGift.name) private readonly groupGiftModel: Model<GroupGiftDocument>,
    private readonly wishlists: WishlistsService,
    private readonly access: AccessPolicyService,
    private readonly cache: CacheService,
    private readonly emitter: EventEmitter2,
    private readonly wishmates: WishmatesService,
  ) {}

  // ── Provisioning ────────────────────────────────────────────────────────────

  /**
   * The one-to-one thread between two WishMates, created on first open.
   *
   * Gated on an accepted link rather than on knowing someone's id: a direct
   * message is the one channel that reaches a person with no wishlist, event
   * or gift between you, so connection *is* the permission. Without this a
   * guessed user id would open a channel to a stranger.
   */
  async openDirect(viewerId: string, otherId: string): Promise<ChatDocument> {
    if (viewerId === otherId) {
      throw new AppException(ErrorCode.CHAT_NOT_FOUND, 'Chat not found', 404);
    }
    if (!(await this.wishmates.areWishmates(viewerId, otherId))) {
      throw new AppException(ErrorCode.NOT_WISHMATES, 'You can only message your WishMates.', 403);
    }
    return this.getOrCreate(ChatType.DIRECT, ChatService.directRefId(viewerId, otherId), [
      new Types.ObjectId(viewerId),
      new Types.ObjectId(otherId),
    ]);
  }

  /**
   * A stable id for a pair, in either order.
   *
   * Sorted before hashing so (a,b) and (b,a) land on the same row — otherwise
   * each side would open its own thread and neither would see the other's
   * messages. Truncated to 24 hex characters because that is what an ObjectId
   * is; this is an addressing scheme, not a security boundary.
   */
  static directRefId(a: string, b: string): Types.ObjectId {
    const pair = [a, b].sort().join(':');
    return new Types.ObjectId(createHash('sha256').update(pair).digest('hex').slice(0, 24));
  }

  /** Get-or-create a chat for a (type, refId). The unique index makes it safe. */
  async getOrCreate(
    type: ChatType,
    refId: Types.ObjectId,
    seed: Types.ObjectId[] = [],
  ): Promise<ChatDocument> {
    const existing = await this.chatModel.findOne({ type, refId }).exec();
    if (existing) return existing;
    try {
      return await this.chatModel.create({ type, refId, participantIds: seed });
    } catch (err) {
      if (ChatService.isDuplicateKey(err)) {
        const raced = await this.chatModel.findOne({ type, refId }).exec();
        if (raced) return raced;
      }
      throw err;
    }
  }

  /**
   * Resolves a wishlist's chat, creating it on first access — the lazy
   * counterpart to a group gift's eager provisioning. Lazy avoids a
   * wishlists → chat module cycle: chat depends on wishlists (for the policy),
   * never the reverse.
   */
  async resolveWishlistChat(wishlistId: string, userId: string): Promise<ChatView> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    if (!wishlist.chatEnabled) {
      throw new AppException(ErrorCode.CHAT_DISABLED, 'Chat is disabled for this wishlist', 403);
    }
    await this.access.assertCanView(wishlist, { userId });
    const chat = await this.getOrCreate(ChatType.WISHLIST, wishlist._id, [
      new Types.ObjectId(userId),
    ]);
    await this.addParticipant(chat._id, userId);
    return this.decorate(chat, userId);
  }

  /** A single chat's view (with the caller's unread count), authorization applied. */
  async getChat(chatId: string, userId: string): Promise<ChatView> {
    const { chat } = await this.authorize(chatId, userId);
    return this.decorate(chat, userId);
  }

  /** Provisions the group-gift chat and posts the opening system note. */
  async provisionForGroupGift(groupGiftId: string, initiatorId: string): Promise<ChatDocument> {
    const chat = await this.getOrCreate(ChatType.GROUP_GIFT, new Types.ObjectId(groupGiftId), [
      new Types.ObjectId(initiatorId),
    ]);
    await this.postSystemMessage(
      chat._id,
      SystemMessageType.GROUP_GIFT_STARTED,
      { groupGiftId, initiatorId },
      `gg_started:${groupGiftId}`,
    );
    return chat;
  }

  // ── Authorization (the chokepoint) ──────────────────────────────────────────

  /**
   * The one place chat access is decided. A wishlist chat defers to
   * AccessPolicyService (canView to read, canComment to post); a group-gift chat
   * defers to the gift's participation, with the recipient excluded whenever the
   * gift is a surprise — the same masking the group-gift endpoint applies.
   */
  async authorize(
    chatId: string,
    userId: string,
    opts: { forPost?: boolean } = {},
  ): Promise<AuthorizedChat> {
    const chat = await this.loadChat(chatId);

    if (chat.type === ChatType.DIRECT) {
      const isParticipant = chat.participantIds.some((id) => id.toString() === userId);
      if (!isParticipant) throw new AppException(ErrorCode.CHAT_NOT_FOUND, 'Chat not found', 404);

      // History survives an unfriending — deleting a conversation because a
      // link was removed destroys something both people wrote. Posting does
      // not: reaching someone requires a live connection, and removing one is
      // the clearest way of saying you no longer want to be reached.
      if (opts.forPost) {
        const other = chat.participantIds.find((id) => id.toString() !== userId);
        if (other && !(await this.wishmates.areWishmates(userId, other.toString()))) {
          throw new AppException(
            ErrorCode.NOT_WISHMATES,
            'You can only message your WishMates.',
            403,
          );
        }
      }
      // A direct chat has no owner; nothing in it is a surprise to mask.
      return { chat, ownerId: null };
    }

    if (chat.type === ChatType.WISHLIST) {
      const wishlist = await this.wishlists.findOrFail(chat.refId.toString());
      if (!wishlist.chatEnabled) {
        throw new AppException(ErrorCode.CHAT_DISABLED, 'Chat is disabled for this wishlist', 403);
      }
      if (opts.forPost) await this.access.assertCanComment(wishlist, { userId });
      else await this.access.assertCanView(wishlist, { userId });
      return { chat, ownerId: wishlist.ownerId.toString() };
    }

    // group_gift
    const gg = await this.groupGiftModel.findById(chat.refId).exec();
    if (!gg) throw new AppException(ErrorCode.CHAT_NOT_FOUND, 'Chat not found', 404);
    const hidden = gg.visibility === GroupGiftVisibility.HIDDEN_FROM_OWNER;
    // The recipient must never discover a surprise through its chat.
    if (gg.recipientId.toString() === userId && hidden) {
      throw new AppException(ErrorCode.CHAT_NOT_FOUND, 'Chat not found', 404);
    }
    const isMember =
      gg.initiatorId.toString() === userId ||
      gg.participantIds.some((id) => id.toString() === userId);
    if (opts.forPost) {
      if (!isMember) {
        throw new AppException(
          ErrorCode.CANNOT_POST_IN_CHAT,
          'Only participants can post in this group gift',
          403,
        );
      }
    } else if (!isMember) {
      // A non-member may read a visible group gift's chat if they can see the list.
      if (hidden) throw new AppException(ErrorCode.CHAT_NOT_FOUND, 'Chat not found', 404);
      const wishlist = await this.wishlists.findOrFail(gg.wishlistId.toString());
      await this.access.assertCanView(wishlist, { userId });
    }
    return { chat, ownerId: gg.recipientId.toString() };
  }

  // ── Posting ─────────────────────────────────────────────────────────────────

  async postMessage(chatId: string, userId: string, dto: PostMessageDto): Promise<MessageView> {
    const { chat, ownerId } = await this.authorize(chatId, userId, { forPost: true });

    const body = (dto.body ?? '').trim();
    const hasAttachments = (dto.attachmentMediaIds?.length ?? 0) > 0;
    if (!body && !hasAttachments) {
      throw new AppException(ErrorCode.MESSAGE_EMPTY, 'A message needs text or an attachment', 400);
    }
    await this.assertNotRateLimited(userId);

    // Anti-spoiler: a surprise-flagged message in a wishlist chat is hidden from
    // the owner (never from the sender themselves).
    const hideFromUserIds: Types.ObjectId[] = [];
    // `ownerId` is non-null for a wishlist chat, which the type guard above
    // already narrows to — the check keeps that true for the compiler too.
    if (dto.surprise && chat.type === ChatType.WISHLIST && ownerId && ownerId !== userId) {
      hideFromUserIds.push(new Types.ObjectId(ownerId));
    }

    const [message] = await this.messageModel.create([
      {
        chatId: chat._id,
        senderId: new Types.ObjectId(userId),
        kind: hasAttachments ? MessageKind.ATTACHMENT : MessageKind.TEXT,
        body,
        attachments: (dto.attachmentMediaIds ?? []).map((id) => ({
          mediaId: new Types.ObjectId(id),
          url: null,
          contentType: null,
        })),
        replyToId: dto.replyToId ? new Types.ObjectId(dto.replyToId) : null,
        hideFromUserIds,
      },
    ]);

    await this.afterNewMessage(chat, message, userId);
    this.moderationScan(message);
    return toMessageView(message);
  }

  /**
   * Posts a system message, exactly once.
   *
   * The unique `dedupeKey` is the whole guarantee: a redelivered or retried
   * domain event inserts the same key and the index rejects the duplicate, so
   * the second attempt is a silent no-op — no double "goal reached!" note.
   */
  async postSystemMessage(
    chatId: Types.ObjectId,
    systemType: SystemMessageType,
    payload: Record<string, unknown>,
    dedupeKey: string,
    hideFromUserIds: Types.ObjectId[] = [],
  ): Promise<void> {
    let message: MessageDocument;
    try {
      [message] = await this.messageModel.create([
        {
          chatId,
          senderId: null,
          kind: MessageKind.SYSTEM,
          body: '',
          systemType,
          systemPayload: payload,
          dedupeKey,
          hideFromUserIds,
        },
      ]);
    } catch (err) {
      if (ChatService.isDuplicateKey(err)) {
        this.logger.debug(`System message ${dedupeKey} already posted; skipping`);
        return;
      }
      throw err;
    }
    await this.touchChat(chatId, message.createdAt);
    this.broadcast(
      chatId.toString(),
      WS_EVENT.MESSAGE_NEW,
      toMessageView(message),
      hideFromUserIds.map((id) => id.toString()),
    );
  }

  // ── Edit / delete / react ───────────────────────────────────────────────────

  async editMessage(messageId: string, userId: string, dto: EditMessageDto): Promise<MessageView> {
    const message = await this.loadOwnMessage(messageId, userId);
    if (message.kind === MessageKind.SYSTEM) {
      throw new AppException(ErrorCode.NOT_THE_SENDER, 'System messages cannot be edited', 403);
    }
    message.body = dto.body.trim();
    message.editedAt = new Date();
    await message.save();
    this.broadcast(
      message.chatId.toString(),
      WS_EVENT.MESSAGE_UPDATED,
      toMessageView(message),
      this.hideList(message),
    );
    return toMessageView(message);
  }

  async deleteMessage(messageId: string, userId: string): Promise<MessageView> {
    const message = await this.loadOwnMessage(messageId, userId);
    message.deletedAt = new Date();
    await message.save();
    this.broadcast(
      message.chatId.toString(),
      WS_EVENT.MESSAGE_DELETED,
      toMessageView(message),
      this.hideList(message),
    );
    return toMessageView(message);
  }

  async react(messageId: string, userId: string, emoji: string): Promise<MessageView> {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new AppException(ErrorCode.MESSAGE_NOT_FOUND, 'Message not found', 404);
    }
    const message = await this.messageModel.findById(messageId).exec();
    if (!message || message.deletedAt) {
      throw new AppException(ErrorCode.MESSAGE_NOT_FOUND, 'Message not found', 404);
    }
    // Must be able to see the chat to react in it.
    await this.authorize(message.chatId.toString(), userId);

    const uid = new Types.ObjectId(userId);
    const entry = message.reactions.find((r) => r.emoji === emoji);
    if (!entry) {
      message.reactions.push({ emoji, userIds: [uid] });
    } else {
      const i = entry.userIds.findIndex((id) => id.toString() === userId);
      if (i >= 0) entry.userIds.splice(i, 1);
      else entry.userIds.push(uid);
    }
    // Drop an emoji nobody reacts with anymore.
    message.reactions = message.reactions.filter((r) => r.userIds.length > 0);
    await message.save();
    this.broadcast(
      message.chatId.toString(),
      WS_EVENT.REACTION_CHANGED,
      toMessageView(message),
      this.hideList(message),
    );
    return toMessageView(message);
  }

  // ── Read receipts ───────────────────────────────────────────────────────────

  async markRead(
    chatId: string,
    userId: string,
    messageId?: string,
  ): Promise<{ unreadCount: number }> {
    const { chat } = await this.authorize(chatId, userId);
    let upTo: Types.ObjectId | null;
    if (messageId) {
      if (!Types.ObjectId.isValid(messageId)) {
        throw new AppException(ErrorCode.MESSAGE_NOT_FOUND, 'Message not found', 404);
      }
      upTo = new Types.ObjectId(messageId);
    } else {
      const latest = await this.messageModel
        .findOne({ chatId: chat._id })
        .sort({ _id: -1 })
        .select('_id')
        .exec();
      upTo = latest?._id ?? null;
    }

    await this.receiptModel
      .updateOne(
        { chatId: chat._id, userId: new Types.ObjectId(userId) },
        { $set: { lastReadMessageId: upTo, lastReadAt: new Date() } },
        { upsert: true },
      )
      .exec();
    this.broadcast(chat._id.toString(), WS_EVENT.READ, {
      userId,
      lastReadMessageId: upTo?.toString() ?? null,
    });
    return { unreadCount: await this.unreadCount(chat._id, userId) };
  }

  // ── Reading ─────────────────────────────────────────────────────────────────

  async listMessages(
    chatId: string,
    userId: string,
    query: { before?: string; limit?: number },
  ): Promise<{ items: MessageView[]; nextCursor: string | null }> {
    await this.authorize(chatId, userId);
    const limit = query.limit ?? 30;

    const filter: Record<string, unknown> = {
      chatId: new Types.ObjectId(chatId),
      // The anti-spoiler at the read path: a message hiding this user is invisible.
      hideFromUserIds: { $ne: new Types.ObjectId(userId) },
    };
    if (query.before) {
      if (!Types.ObjectId.isValid(query.before)) {
        throw new AppException(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', 400);
      }
      filter._id = { $lt: new Types.ObjectId(query.before) };
    }

    const rows = await this.messageModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .exec();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(toMessageView),
      nextCursor: hasMore ? page[page.length - 1]._id.toString() : null,
    };
  }

  async listChats(userId: string, type?: ChatType): Promise<ChatView[]> {
    const filter: Record<string, unknown> = { participantIds: new Types.ObjectId(userId) };
    if (type) filter.type = type;
    const chats = await this.chatModel.find(filter).sort({ lastMessageAt: -1 }).limit(200).exec();
    if (chats.length === 0) return [];

    // Both decorations are batched across the whole page: the chat list is the
    // one screen that asks for every thread at once, and a per-row lookup would
    // make it two hundred round trips for two hundred names.
    const [previews, counterparts] = await Promise.all([
      this.lastMessagesOf(chats, userId),
      this.counterpartsOf(chats, userId),
    ]);

    return Promise.all(
      chats.map(async (chat) =>
        toChatView(chat, await this.unreadCount(chat._id, userId), {
          counterpart: counterparts.get(chat._id.toString()) ?? null,
          lastMessage: previews.get(chat._id.toString()) ?? null,
        }),
      ),
    );
  }

  /** One chat's full view. The single-row path; [listChats] batches instead. */
  private async decorate(chat: ChatDocument, userId: string): Promise<ChatView> {
    const [unread, previews, counterparts] = await Promise.all([
      this.unreadCount(chat._id, userId),
      this.lastMessagesOf([chat], userId),
      this.counterpartsOf([chat], userId),
    ]);
    return toChatView(chat, unread, {
      counterpart: counterparts.get(chat._id.toString()) ?? null,
      lastMessage: previews.get(chat._id.toString()) ?? null,
    });
  }

  /**
   * The newest visible message per chat, in one round trip.
   *
   * Carries the same `hideFromUserIds` exclusion the read path uses: a surprise
   * message the recipient cannot open in the thread must not reach them as a
   * preview either, which would be a worse leak — the spoiler would arrive
   * unprompted, on a list screen, instead of being merely absent.
   */
  private async lastMessagesOf(
    chats: ChatDocument[],
    userId: string,
  ): Promise<Map<string, MessagePreviewView>> {
    const rows = await this.messageModel
      .aggregate<{ _id: Types.ObjectId; doc: MessageDocument }>([
        {
          $match: {
            chatId: { $in: chats.map((c) => c._id) },
            hideFromUserIds: { $ne: new Types.ObjectId(userId) },
          },
        },
        // `_id` descending is newest-first: an ObjectId leads with its
        // timestamp, which is what the history cursor already relies on.
        { $sort: { _id: -1 } },
        { $group: { _id: '$chatId', doc: { $first: '$$ROOT' } } },
      ])
      .exec();

    return new Map(
      rows.map((row) => [
        row._id.toString(),
        toMessagePreviewView(this.messageModel.hydrate(row.doc)),
      ]),
    );
  }

  /**
   * The other participant of each DIRECT chat, in one round trip. Non-direct
   * chats are skipped — a wishlist thread's subject is the wishlist.
   */
  private async counterpartsOf(
    chats: ChatDocument[],
    userId: string,
  ): Promise<Map<string, PublicIdentity>> {
    const wanted = new Map<string, string>();
    for (const chat of chats) {
      if (chat.type !== ChatType.DIRECT) continue;
      const other = chat.participantIds.find((id) => id.toString() !== userId);
      if (other) wanted.set(chat._id.toString(), other.toString());
    }
    if (wanted.size === 0) return new Map();

    const identities = await this.wishmates.identitiesOf([...new Set(wanted.values())]);
    const byUser = new Map(identities.map((i) => [i.userId, i]));

    const result = new Map<string, PublicIdentity>();
    for (const [chatId, otherId] of wanted) {
      // An account that signed up and filled nothing in has no profile row, and
      // still has real conversations. The row is drawn from its id with the
      // names left empty rather than dropped — a chat list with an unnamed row
      // is recoverable; one with a row belonging to nobody is not.
      result.set(
        chatId,
        byUser.get(otherId) ?? {
          userId: otherId,
          username: null,
          displayName: null,
          photoUrl: null,
          avatarKey: null,
          online: false,
          lastSeenAt: null,
        },
      );
    }
    return result;
  }

  /**
   * The two dashboard chat sections: how many chats of each type the user is in,
   * and how many of those carry unread messages (the badge). Kept here because
   * the unread rule (exclude own + hidden + deleted, after the read receipt) is
   * this service's business, not the dashboard's.
   */
  async sectionCounts(userId: string): Promise<Record<ChatType, { count: number; badge: number }>> {
    const result: Record<ChatType, { count: number; badge: number }> = {
      [ChatType.WISHLIST]: { count: 0, badge: 0 },
      [ChatType.GROUP_GIFT]: { count: 0, badge: 0 },
      [ChatType.DIRECT]: { count: 0, badge: 0 },
    };
    const chats = await this.chatModel.find({ participantIds: new Types.ObjectId(userId) }).exec();
    for (const chat of chats) {
      const bucket = result[chat.type];
      bucket.count += 1;
      if ((await this.unreadCount(chat._id, userId)) > 0) bucket.badge += 1;
    }
    return result;
  }

  /** Adds a user to the chat's engaged-members set (join / first post). Idempotent. */
  async addParticipant(chatId: Types.ObjectId, userId: string): Promise<void> {
    await this.chatModel
      .updateOne({ _id: chatId }, { $addToSet: { participantIds: new Types.ObjectId(userId) } })
      .exec();
  }

  /**
   * A user lost access to a wishlist — signal the gateway to evict them from its
   * chat and drop them from the members set, so they get no further messages.
   * (REST history re-checks access, so old messages are also out of reach.)
   */
  async revokeWishlistChatAccess(wishlistId: string, userId: string): Promise<void> {
    const chat = await this.chatModel
      .findOne({ type: ChatType.WISHLIST, refId: new Types.ObjectId(wishlistId) })
      .exec();
    if (!chat) return;
    await this.chatModel
      .updateOne({ _id: chat._id }, { $pull: { participantIds: new Types.ObjectId(userId) } })
      .exec();
    this.emitter.emit(CHAT_FORCE_LEAVE, {
      chatType: ChatType.WISHLIST,
      refId: wishlistId,
      userId,
      chatId: chat._id.toString(),
    } satisfies ChatForceLeave & { chatId: string });
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async afterNewMessage(
    chat: ChatDocument,
    message: MessageDocument,
    senderId: string,
  ): Promise<void> {
    await this.addParticipant(chat._id, senderId);
    await this.touchChat(chat._id, message.createdAt);
    this.broadcast(
      chat._id.toString(),
      WS_EVENT.MESSAGE_NEW,
      toMessageView(message),
      message.hideFromUserIds.map((id) => id.toString()),
    );
  }

  private async touchChat(chatId: Types.ObjectId, at: Date): Promise<void> {
    await this.chatModel.updateOne({ _id: chatId }, { $set: { lastMessageAt: at } }).exec();
  }

  private broadcast(
    chatId: string,
    event: string,
    payload: unknown,
    hideFromUserIds: string[] = [],
  ): void {
    this.emitter.emit(CHAT_BROADCAST, {
      chatId,
      event,
      payload,
      hideFromUserIds,
    } satisfies ChatBroadcast);
  }

  private hideList(message: MessageDocument): string[] {
    return message.hideFromUserIds.map((id) => id.toString());
  }

  private async unreadCount(chatId: Types.ObjectId, userId: string): Promise<number> {
    const receipt = await this.receiptModel
      .findOne({ chatId, userId: new Types.ObjectId(userId) })
      .exec();
    const filter: Record<string, unknown> = {
      chatId,
      // Don't count your own messages or anything hidden from you.
      senderId: { $ne: new Types.ObjectId(userId) },
      hideFromUserIds: { $ne: new Types.ObjectId(userId) },
      deletedAt: null,
    };
    if (receipt?.lastReadMessageId) filter._id = { $gt: receipt.lastReadMessageId };
    return this.messageModel.countDocuments(filter).exec();
  }

  private async loadChat(chatId: string): Promise<ChatDocument> {
    if (!Types.ObjectId.isValid(chatId)) {
      throw new AppException(ErrorCode.CHAT_NOT_FOUND, 'Chat not found', 404);
    }
    const chat = await this.chatModel.findById(chatId).exec();
    if (!chat) throw new AppException(ErrorCode.CHAT_NOT_FOUND, 'Chat not found', 404);
    return chat;
  }

  private async loadOwnMessage(messageId: string, userId: string): Promise<MessageDocument> {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new AppException(ErrorCode.MESSAGE_NOT_FOUND, 'Message not found', 404);
    }
    const message = await this.messageModel.findById(messageId).exec();
    if (!message || message.deletedAt) {
      throw new AppException(ErrorCode.MESSAGE_NOT_FOUND, 'Message not found', 404);
    }
    if (!message.senderId || message.senderId.toString() !== userId) {
      throw new AppException(
        ErrorCode.NOT_THE_SENDER,
        'You can only change your own messages',
        403,
      );
    }
    return message;
  }

  private async assertNotRateLimited(userId: string): Promise<void> {
    const key = `chat:rate:${userId}`;
    const count = await this.cache.client.incr(key);
    if (count === 1) await this.cache.client.expire(key, RATE_WINDOW_SECONDS);
    if (count > RATE_MAX_MESSAGES) {
      throw new AppException(
        ErrorCode.CHAT_RATE_LIMITED,
        'You are sending messages too quickly. Please slow down.',
        429,
      );
    }
  }

  /** The moderation hook: flags, never blocks. Sprint 11's queue consumes it. */
  private moderationScan(message: MessageDocument): void {
    const lower = message.body.toLowerCase();
    if (FLAGGED_WORDS.some((w) => lower.includes(w))) {
      this.emitter.emit(CONTENT_FLAGGED, {
        targetType: 'message',
        targetId: message._id.toString(),
        reason: 'auto-flagged: profanity',
        senderId: message.senderId?.toString() ?? null,
      } satisfies ContentFlaggedEvent);
    }
  }

  private static isDuplicateKey(err: unknown): boolean {
    return (err as { code?: number })?.code === 11000;
  }
}
