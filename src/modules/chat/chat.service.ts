import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { USER_UNBLOCKED, type UserUnblockedEvent } from 'src/common/events/domain-events';
import { AppException } from 'src/common/errors/app.exception';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  CHAT_MESSAGE_POSTED,
  CONTENT_FLAGGED,
  type ChatMessagePostedEvent,
  type ContentFlaggedEvent,
} from 'src/common/events/domain-events';
import { CacheService } from 'src/infra/redis/cache.service';
import { GroupGiftVisibility } from 'src/modules/group-gifts/group-gift.types';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import { AccessPolicyService } from 'src/modules/wishlists/access/access-policy.service';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
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
    // Read-only, for a wishlist chat's title — see [titlesOf].
    @InjectModel(Wishlist.name) private readonly wishlistModel: Model<WishlistDocument>,
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
    // WishMates — or someone the other person blocked while they were, who is
    // not told and whose side carries on (see [WishmatesService.canMessage]).
    if (!(await this.wishmates.canMessage(viewerId, otherId))) {
      // History survives an unfriending, and a block — so a thread the two
      // already have still opens, to be read. Nothing can be sent in it
      // (posting and reacting check again), and no *new* thread is started
      // without a connection.
      const existing = await this.chatModel
        .findOne({
          type: ChatType.DIRECT,
          refId: ChatService.directRefId(viewerId, otherId),
          participantIds: new Types.ObjectId(viewerId),
        })
        .exec();
      if (existing) return existing;
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
      // the clearest way of saying you no longer want to be reached. A block
      // is the exception on one side only: the person blocked is not told,
      // and can still write — see [postMessage] for where that goes.
      if (opts.forPost) {
        const other = chat.participantIds.find((id) => id.toString() !== userId);
        if (other && !(await this.wishmates.canMessage(userId, other.toString()))) {
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
    const sharedUserId = dto.sharedUserId ?? null;
    if (!body && !hasAttachments && !sharedUserId) {
      throw new AppException(ErrorCode.MESSAGE_EMPTY, 'A message needs text or an attachment', 400);
    }
    if (sharedUserId) await this.assertShareable(userId, sharedUserId, hasAttachments);
    await this.assertNotRateLimited(userId);

    // Anti-spoiler: a surprise-flagged message in a wishlist chat is hidden from
    // the owner (never from the sender themselves).
    const hideFromUserIds: Types.ObjectId[] = [];
    // `ownerId` is non-null for a wishlist chat, which the type guard above
    // already narrows to — the check keeps that true for the compiler too.
    if (dto.surprise && chat.type === ChatType.WISHLIST && ownerId && ownerId !== userId) {
      hideFromUserIds.push(new Types.ObjectId(ownerId));
    }
    // Written to someone who blocked the sender: kept, and kept from them —
    // no delivery, no notification, no unread — until they unblock, when
    // [releaseHeldMessages] hands it over. The sender sees it sent, as ever.
    const recipient = await this.blockerOf(chat, userId);
    if (recipient) hideFromUserIds.push(recipient);

    const [message] = await this.messageModel.create([
      {
        chatId: chat._id,
        senderId: new Types.ObjectId(userId),
        kind: sharedUserId
          ? MessageKind.PROFILE
          : hasAttachments
            ? MessageKind.ATTACHMENT
            : MessageKind.TEXT,
        body,
        sharedUserId: sharedUserId ? new Types.ObjectId(sharedUserId) : null,
        attachments: (dto.attachmentMediaIds ?? []).map((id) => ({
          mediaId: new Types.ObjectId(id),
          url: null,
          contentType: null,
        })),
        replyToId: dto.replyToId ? new Types.ObjectId(dto.replyToId) : null,
        hideFromUserIds,
      },
    ]);

    const view = await this.viewOf(message);
    await this.afterNewMessage(chat, message, userId, view);
    // A shared profile with no note says what it is on the lock screen,
    // rather than arriving as an empty notification.
    this.announceMessage(
      chat,
      message,
      userId,
      sharedUserId && !body ? ChatService.sharedProfileLine(view.sharedProfile) : undefined,
    );
    this.moderationScan(message);
    return view;
  }

  /** "Shared a profile: Priyal Sharma" — a shared profile's line on its own. */
  static sharedProfileLine(person: PublicIdentity | null): string {
    const name =
      person?.displayName?.trim() || (person?.username ? `@${person.username}` : 'someone');
    return `Shared a profile: ${name}`;
  }

  /**
   * Whether [sharedUserId]'s profile can be shared by [userId]: any account
   * the sender could open — so not one that does not exist, and not one
   * either of them has blocked. Both answer as a missing account, exactly as
   * opening that profile would, so the share cannot be used to probe ids.
   */
  private async assertShareable(
    userId: string,
    sharedUserId: string,
    hasAttachments: boolean,
  ): Promise<void> {
    if (hasAttachments) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'A shared profile cannot carry attachments',
        400,
      );
    }
    await this.wishmates.relationshipWithExisting(userId, sharedUserId);
    if (await this.wishmates.blockedEitherWay(userId, sharedUserId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found.', 404);
    }
  }

  /** [toMessageView], with the shared person filled in. */
  private async viewOf(message: MessageDocument): Promise<MessageView> {
    const [view] = await this.withSharedProfiles([toMessageView(message)]);
    return view;
  }

  /**
   * Fills in [MessageView.sharedProfile] for every shared-profile message in
   * [views], in one lookup.
   *
   * With a [viewerId] — a history read, which is per reader — a person the
   * reader has blocked, or who has blocked them, is left out: the card says
   * the profile is not available rather than showing who it was. A live
   * broadcast goes to everyone in the chat at once and has no single reader;
   * there the app asks for the profile before offering anything, and the
   * same 404 answers it.
   */
  private async withSharedProfiles(
    views: MessageView[],
    viewerId?: string,
  ): Promise<MessageView[]> {
    const ids = [...new Set(views.flatMap((v) => (v.sharedUserId ? [v.sharedUserId] : [])))];
    if (ids.length === 0) return views;

    const [identities, blocked] = await Promise.all([
      this.wishmates.identitiesOf(ids),
      viewerId ? this.wishmates.blockedIdsEitherWay(viewerId) : Promise.resolve([]),
    ]);
    const byUser = new Map(identities.map((i) => [i.userId, i]));
    const hidden = new Set(blocked.map((id) => id.toString()));

    return views.map((v) => {
      if (!v.sharedUserId || hidden.has(v.sharedUserId)) return v;
      return {
        ...v,
        // An account with no profile row yet still has an id worth a card.
        sharedProfile: byUser.get(v.sharedUserId) ?? {
          userId: v.sharedUserId,
          username: null,
          displayName: null,
          photoUrl: null,
          avatarKey: null,
          online: false,
          lastSeenAt: null,
        },
      };
    });
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
    const view = await this.viewOf(message);
    this.broadcast(
      message.chatId.toString(),
      WS_EVENT.MESSAGE_UPDATED,
      view,
      this.hideList(message),
    );
    return view;
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
    // Must be able to see the chat to react in it — and, in a direct chat,
    // able to post in it: a reaction reaches the other person as much as a
    // message does, so once either has blocked the other (or they are no
    // longer WishMates) there are none, though the history stays readable.
    const { chat } = await this.authorize(message.chatId.toString(), userId);
    if (chat.type === ChatType.DIRECT) {
      await this.authorize(message.chatId.toString(), userId, { forPost: true });
      // A message can wait out a block; a reaction lands on a message the
      // blocker can already see, so it cannot — refused like any other
      // reaction across a closed thread.
      const other = chat.participantIds.find((id) => id.toString() !== userId);
      if (other && (await this.wishmates.blockedEitherWay(userId, other.toString()))) {
        throw new AppException(
          ErrorCode.NOT_WISHMATES,
          'You can only message your WishMates.',
          403,
        );
      }
    }

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
    const view = await this.viewOf(message);
    this.broadcast(
      message.chatId.toString(),
      WS_EVENT.REACTION_CHANGED,
      view,
      this.hideList(message),
    );
    return view;
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
      // The newest message this reader can *see*. Counting a hidden one would
      // mark it read — a message held across a block would show its sender
      // as read, and arrive already read when the block lifts.
      const latest = await this.messageModel
        .findOne({ chatId: chat._id, hideFromUserIds: { $ne: new Types.ObjectId(userId) } })
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

  /**
   * Deletes the conversation from this user's side: their history starts
   * after the newest message, and a direct thread leaves their chat list
   * until somebody writes in it again. Nothing is deleted — the other person
   * still has the whole thread.
   *
   * Also marks it read, so a cleared thread cannot keep an unread badge for
   * messages its reader can no longer open.
   */
  async clearForUser(chatId: string, userId: string): Promise<{ clearedUpTo: string | null }> {
    const { chat } = await this.authorize(chatId, userId);
    // Up to what this reader has seen: a message still held from them across
    // a block was never theirs to delete, and arrives when the block lifts.
    const latest = await this.messageModel
      .findOne({ chatId: chat._id, hideFromUserIds: { $ne: new Types.ObjectId(userId) } })
      .sort({ _id: -1 })
      .select('_id')
      .exec();
    const upTo = latest?._id ?? null;
    await this.receiptModel
      .updateOne(
        { chatId: chat._id, userId: new Types.ObjectId(userId) },
        { $set: { clearedUpTo: upTo, lastReadMessageId: upTo, lastReadAt: new Date() } },
        { upsert: true },
      )
      .exec();
    return { clearedUpTo: upTo?.toString() ?? null };
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
    const idRange: Record<string, Types.ObjectId> = {};
    if (query.before) {
      if (!Types.ObjectId.isValid(query.before)) {
        throw new AppException(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', 400);
      }
      idRange.$lt = new Types.ObjectId(query.before);
    }
    // A conversation this user deleted starts again after the cut.
    const cleared = (await this.clearedCutoffs([new Types.ObjectId(chatId)], userId)).get(chatId);
    if (cleared) idRange.$gt = cleared;
    if (Object.keys(idRange).length > 0) filter._id = idRange;

    const rows = await this.messageModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .exec();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: await this.withSharedProfiles(page.map(toMessageView), userId),
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
    const [previews, counterparts, cleared, titles] = await Promise.all([
      this.lastMessagesOf(chats, userId),
      this.counterpartsOf(chats, userId),
      this.clearedCutoffs(
        chats.map((c) => c._id),
        userId,
      ),
      this.titlesOf(chats),
    ]);

    // A direct thread its reader deleted stays off their list until somebody
    // writes in it again. Only direct ones: a wishlist or group-gift chat is
    // reached through its wishlist or gift, and clearing it empties it rather
    // than making it vanish.
    const visible = chats.filter(
      (chat) =>
        chat.type !== ChatType.DIRECT ||
        !cleared.has(chat._id.toString()) ||
        previews.has(chat._id.toString()),
    );

    return Promise.all(
      visible.map(async (chat) =>
        toChatView(chat, await this.unreadCount(chat._id, userId), {
          counterpart: counterparts.get(chat._id.toString()) ?? null,
          lastMessage: previews.get(chat._id.toString()) ?? null,
          title: titles.get(chat._id.toString()) ?? null,
        }),
      ),
    );
  }

  /** One chat's full view. The single-row path; [listChats] batches instead. */
  private async decorate(chat: ChatDocument, userId: string): Promise<ChatView> {
    const [unread, previews, counterparts, titles] = await Promise.all([
      this.unreadCount(chat._id, userId),
      this.lastMessagesOf([chat], userId),
      this.counterpartsOf([chat], userId),
      this.titlesOf([chat]),
    ]);
    return toChatView(chat, unread, {
      counterpart: counterparts.get(chat._id.toString()) ?? null,
      lastMessage: previews.get(chat._id.toString()) ?? null,
      title: titles.get(chat._id.toString()) ?? null,
    });
  }

  /**
   * Each wishlist or group-gift chat's title — its wishlist's or gift's — in
   * two lookups for the whole page, so a list of group chats can name every
   * row. Direct chats are skipped; their counterpart names them.
   */
  private async titlesOf(chats: ChatDocument[]): Promise<Map<string, string>> {
    const of = (type: ChatType) => chats.filter((c) => c.type === type);
    const wishlistChats = of(ChatType.WISHLIST);
    const giftChats = of(ChatType.GROUP_GIFT);
    const [wishlists, gifts] = await Promise.all([
      wishlistChats.length === 0
        ? []
        : this.wishlistModel
            .find({ _id: { $in: wishlistChats.map((c) => c.refId) } })
            .select('title')
            .lean()
            .exec(),
      giftChats.length === 0
        ? []
        : this.groupGiftModel
            .find({ _id: { $in: giftChats.map((c) => c.refId) } })
            .select('title')
            .lean()
            .exec(),
    ]);
    const byRef = new Map<string, string>();
    for (const doc of [...wishlists, ...gifts]) byRef.set(doc._id.toString(), doc.title);

    const titles = new Map<string, string>();
    for (const chat of [...wishlistChats, ...giftChats]) {
      const title = byRef.get(chat.refId.toString());
      if (title) titles.set(chat._id.toString(), title);
    }
    return titles;
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
    const [rows, cleared] = await Promise.all([
      this.messageModel
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
        .exec(),
      this.clearedCutoffs(
        chats.map((c) => c._id),
        userId,
      ),
    ]);

    // The newest message is the preview, so if even that one was cleared,
    // everything was — the thread has nothing left to show this reader.
    const kept = rows.filter((row) => {
      const cut = cleared.get(row._id.toString());
      return !cut || row.doc._id.toString() > cut.toString();
    });

    return new Map(
      kept.map((row) => [
        row._id.toString(),
        toMessagePreviewView(this.messageModel.hydrate(row.doc)),
      ]),
    );
  }

  /** Where each chat this user deleted was cut, keyed by chat id. */
  private async clearedCutoffs(
    chatIds: Types.ObjectId[],
    userId: string,
  ): Promise<Map<string, Types.ObjectId>> {
    const receipts = await this.receiptModel
      .find({
        chatId: { $in: chatIds },
        userId: new Types.ObjectId(userId),
        clearedUpTo: { $ne: null },
      })
      .select('chatId clearedUpTo')
      .exec();
    const cutoffs = new Map<string, Types.ObjectId>();
    for (const r of receipts) {
      if (r.clearedUpTo) cutoffs.set(r.chatId.toString(), r.clearedUpTo);
    }
    return cutoffs;
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

    const [identities, blocked] = await Promise.all([
      this.wishmates.identitiesOf([...new Set(wanted.values())]),
      this.wishmates.blockedIdsEitherWay(userId),
    ]);
    // Across a block, either way, nobody's comings and goings are shown —
    // the same rule the Blocked users list keeps.
    const unseen = new Set(blocked.map((id) => id.toString()));
    const byUser = new Map(
      identities.map((i) => [
        i.userId,
        unseen.has(i.userId) ? { ...i, online: false, lastSeenAt: null } : i,
      ]),
    );

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

  // ── Across a block ───────────────────────────────────────────────────────────

  /**
   * The other person in a direct chat, if they have blocked [senderId] — the
   * one a new message from [senderId] must be held from. Null otherwise, and
   * for every other kind of chat.
   */
  private async blockerOf(chat: ChatDocument, senderId: string): Promise<Types.ObjectId | null> {
    if (chat.type !== ChatType.DIRECT) return null;
    const other = chat.participantIds.find((id) => id.toString() !== senderId);
    if (!other) return null;
    return (await this.wishmates.hasBlocked(other.toString(), senderId)) ? other : null;
  }

  /**
   * A block was lifted: everything the blocked person wrote to the blocker
   * while it stood reaches them now, as unread.
   *
   * Only their direct thread, and only messages hidden from the blocker —
   * which, in a direct chat, nothing but a block ever does (the anti-spoiler
   * hide is for wishlist chats alone). No notifications for the backlog: it
   * is there when they open the chat, which is where they just were.
   */
  @OnEvent(USER_UNBLOCKED)
  async releaseHeldMessages(event: UserUnblockedEvent): Promise<void> {
    const chat = await this.chatModel
      .findOne({
        type: ChatType.DIRECT,
        refId: ChatService.directRefId(event.blockerId, event.blockedId),
      })
      .exec();
    if (!chat) return;
    const blocker = new Types.ObjectId(event.blockerId);
    await this.messageModel
      .updateMany(
        {
          chatId: chat._id,
          senderId: new Types.ObjectId(event.blockedId),
          hideFromUserIds: blocker,
        },
        { $pull: { hideFromUserIds: blocker } },
      )
      .exec();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async afterNewMessage(
    chat: ChatDocument,
    message: MessageDocument,
    senderId: string,
    view: MessageView = toMessageView(message),
  ): Promise<void> {
    await this.addParticipant(chat._id, senderId);
    await this.touchChat(chat._id, message.createdAt);
    this.broadcast(
      chat._id.toString(),
      WS_EVENT.MESSAGE_NEW,
      view,
      message.hideFromUserIds.map((id) => id.toString()),
    );
  }

  /**
   * Tells the people who are not watching that somebody wrote.
   *
   * Only for messages a person typed. A system note ("goal reached!") is
   * already announced by whatever caused it, and posting it here would
   * notify twice for one thing.
   *
   * The audience is the engaged set minus the sender minus anyone the message
   * is hidden from — the anti-spoiler holds for notifications too, or the
   * surprise is given away by the lock screen rather than the chat.
   */
  private announceMessage(
    chat: ChatDocument,
    message: MessageDocument,
    senderId: string,
    /** What the notification says, when the message's own text will not do. */
    previewBody?: string,
  ): void {
    const hidden = new Set(this.hideList(message));
    const recipientIds = chat.participantIds
      .map((id) => id.toString())
      .filter((id) => id !== senderId && !hidden.has(id));
    if (recipientIds.length === 0) return;

    this.emitter.emit(CHAT_MESSAGE_POSTED, {
      chatId: chat._id.toString(),
      messageId: message._id.toString(),
      senderId,
      recipientIds,
      body: previewBody ?? message.body,
      direct: chat.type === ChatType.DIRECT,
      chatType: chat.type,
      chatRefId: chat.refId.toString(),
    } satisfies ChatMessagePostedEvent);
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
