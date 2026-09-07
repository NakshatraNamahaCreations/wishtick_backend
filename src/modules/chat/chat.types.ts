export enum ChatType {
  /** Attached to a wishlist; everyone with access can talk. */
  WISHLIST = 'wishlist',
  /** Attached to a group gift; its participants coordinate the surprise. */
  GROUP_GIFT = 'group_gift',
  /**
   * One-to-one between two WishMates (`4177:6`).
   *
   * Unlike the other two this hangs off no entity, so its `refId` is derived
   * from the pair itself — see [ChatService.directRefId]. That keeps the
   * unique `(type, refId)` index doing the same job it does everywhere else:
   * two people can only ever have one direct thread.
   */
  DIRECT = 'direct',
}

export enum MessageKind {
  TEXT = 'text',
  /** Posted by the server from a domain event, rendered from `systemPayload`. */
  SYSTEM = 'system',
  ATTACHMENT = 'attachment',
}

/** Who may post in a chat. `moderators` is for a locked-down announcement chat. */
export enum WhoCanPost {
  PARTICIPANTS = 'participants',
  MODERATORS = 'moderators',
}

/**
 * The structured kinds of system message. Clients localize from the `type` +
 * `systemPayload` rather than parsing an English string, so the copy can change
 * without breaking anyone.
 */
export enum SystemMessageType {
  GROUP_GIFT_STARTED = 'group_gift_started',
  USER_JOINED = 'user_joined',
  CONTRIBUTION_RECEIVED = 'contribution_received',
  GOAL_REACHED = 'goal_reached',
  GIFT_PURCHASED = 'gift_purchased',
  GIFT_FULFILLED = 'gift_fulfilled',
}

/**
 * Socket.IO event names. Client→server verbs are plain; server→client
 * notifications are namespaced with `:` so a client can pattern-match them.
 */
export const WS_EVENT = {
  // client → server
  JOIN: 'join_chat',
  LEAVE: 'leave_chat',
  TYPING: 'typing',
  // server → client
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  REACTION_CHANGED: 'reaction:changed',
  READ: 'read',
  PRESENCE: 'presence',
  ERROR: 'error',
} as const;

/** The Socket.IO namespace the gateway serves. */
export const CHAT_NAMESPACE = '/chat';

/** Room helpers — chat rooms fan out messages; per-user rooms let us exclude one viewer. */
export const chatRoom = (chatId: string): string => `chat:${chatId}`;
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * Internal event that decouples "a chat thing happened" from "broadcast it".
 *
 * ChatService emits this after any mutation (from REST *or* a socket), and the
 * gateway's listener fans it out to the chat room — minus any `hideFromUserIds`
 * personal rooms, which is how the anti-spoiler is enforced on the socket path.
 * One broadcast path for both transports means neither can drift from the other.
 */
export const CHAT_BROADCAST = 'chat.broadcast';

export interface ChatBroadcast {
  chatId: string;
  /** A WS_EVENT server→client name. */
  event: string;
  payload: unknown;
  /** User ids whose personal rooms are excluded from this emit (surprise gifts). */
  hideFromUserIds?: string[];
}

/** Force-disconnect signal: a user lost access to a wishlist and must leave its chat. */
export const CHAT_FORCE_LEAVE = 'chat.force_leave';

export interface ChatForceLeave {
  chatType: ChatType;
  refId: string;
  userId: string;
}
