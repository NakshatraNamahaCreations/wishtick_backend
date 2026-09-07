import type { PublicIdentity } from 'src/modules/wishmates/wishmates.views';
import type { ChatDocument } from './schemas/chat.schema';
import type { MessageDocument } from './schemas/message.schema';

/** How much of a message body reaches a chat-list row. */
const PREVIEW_MAX_CHARS = 140;

export interface ReactionView {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface MessageView {
  id: string;
  chatId: string;
  senderId: string | null;
  kind: string;
  body: string;
  attachments: { mediaId: string; url: string | null; contentType: string | null }[];
  replyToId: string | null;
  reactions: ReactionView[];
  editedAt: Date | null;
  deletedAt: Date | null;
  systemType: string | null;
  systemPayload: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * The newest message in a thread, as a chat-list row draws it (`4177:179`).
 *
 * A trimmed [MessageView] rather than the whole thing: a list of two hundred
 * threads should not carry two hundred reaction arrays and attachment
 * manifests to render one line of grey text. [body] is truncated server-side
 * so one pasted essay cannot inflate the whole payload.
 */
export interface MessagePreviewView {
  id: string;
  senderId: string | null;
  kind: string;
  /** Empty for a deleted message, and for one that is only attachments. */
  body: string;
  hasAttachments: boolean;
  createdAt: Date;
}

export interface ChatView {
  id: string;
  type: string;
  refId: string;
  lastMessageAt: Date | null;
  unreadCount: number;
  whoCanPost: string;
  participantCount: number;
  /**
   * The person on the other side of a DIRECT thread. Null for every other
   * type, which have a wishlist or a group gift as their subject instead.
   *
   * A direct chat's [refId] is a one-way hash of the pair, so it addresses the
   * thread but names nobody — without this the chat list could not draw a
   * single row.
   */
  counterpart: PublicIdentity | null;
  /** The newest message the caller is allowed to see, or null for an empty thread. */
  lastMessage: MessagePreviewView | null;
}

/**
 * Projects a message for the wire. A soft-deleted message keeps its envelope
 * (so replies to it don't dangle) but its body and attachments are stripped —
 * "this message was deleted" is all a client should render.
 */
export function toMessageView(m: MessageDocument): MessageView {
  const deleted = m.deletedAt !== null;
  return {
    id: m._id.toString(),
    chatId: m.chatId.toString(),
    senderId: m.senderId ? m.senderId.toString() : null,
    kind: m.kind,
    body: deleted ? '' : m.body,
    attachments: deleted
      ? []
      : m.attachments.map((a) => ({
          mediaId: a.mediaId.toString(),
          url: a.url,
          contentType: a.contentType,
        })),
    replyToId: m.replyToId ? m.replyToId.toString() : null,
    reactions: m.reactions.map((r) => ({
      emoji: r.emoji,
      count: r.userIds.length,
      userIds: r.userIds.map((id) => id.toString()),
    })),
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    systemType: m.systemType,
    systemPayload: m.systemPayload,
    createdAt: m.createdAt,
  };
}

/**
 * Projects the newest message for a list row, applying the same stripping
 * [toMessageView] does — a deleted message keeps its place in the timeline but
 * surrenders its text, here as much as in the thread itself.
 */
export function toMessagePreviewView(m: MessageDocument): MessagePreviewView {
  const deleted = m.deletedAt !== null;
  const body = deleted ? '' : m.body;
  return {
    id: m._id.toString(),
    senderId: m.senderId ? m.senderId.toString() : null,
    kind: m.kind,
    body: body.length > PREVIEW_MAX_CHARS ? `${body.slice(0, PREVIEW_MAX_CHARS)}…` : body,
    hasAttachments: !deleted && m.attachments.length > 0,
    createdAt: m.createdAt,
  };
}

export function toChatView(
  chat: ChatDocument,
  unreadCount: number,
  extras: {
    counterpart?: PublicIdentity | null;
    lastMessage?: MessagePreviewView | null;
  } = {},
): ChatView {
  return {
    id: chat._id.toString(),
    type: chat.type,
    refId: chat.refId.toString(),
    lastMessageAt: chat.lastMessageAt,
    unreadCount,
    whoCanPost: chat.settings.whoCanPost,
    participantCount: chat.participantIds.length,
    counterpart: extras.counterpart ?? null,
    lastMessage: extras.lastMessage ?? null,
  };
}
