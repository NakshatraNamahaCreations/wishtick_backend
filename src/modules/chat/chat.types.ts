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
  /**
   * Somebody's profile, shared into the chat — drawn as a card with Send
   * Request and View Profile. Only the person's id is stored; their name and
   * photo are looked up whenever the message is shown, so the card is never
   * out of date.
   */
  PROFILE = 'profile',
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
  // The rest of the collection's life. Payload keys per kind are listed in
  // the group-gifting contract; the chat system listener is what writes them.
  /** `{userId, byUserId}` — accepted an invitation, or paid in on one. */
  MEMBER_ADDED = 'member_added',
  /** `{userId}` — said they were not interested after all. */
  MEMBER_LEFT = 'member_left',
  /** `{amountMinor, userId|null}` — null for an anonymous payment. */
  PAYMENT_SENT = 'payment_sent',
  /** `{userId|null, claimedMinor, receivedMinor, state}` — the host's answer. */
  PAYMENT_REVIEWED = 'payment_reviewed',
  /** `{label, amountMinor, targetAmountMinor}` */
  CHARGE_ADDED = 'charge_added',
  /** `{itemTitle, fromMinor, toMinor, targetAmountMinor}` */
  PRICE_UPDATED = 'price_updated',
  /** `{hostId, amountMinor}` — the host paid what was left. */
  SETTLED = 'settled',
  /** `{deadline}` */
  DEADLINE_EXTENDED = 'deadline_extended',
  /** `{shortMinor}` — the deadline passed short of the goal. */
  COLLECTION_CLOSED = 'collection_closed',
  /** `{reason}` */
  CANCELLED = 'cancelled',
  /** `{amountMinor, count}` — returns raised for the group. */
  REFUND_RAISED = 'refund_raised',
  /** `{amountMinor}` — the host asked for more. */
  TOP_UP_REQUESTED = 'top_up_requested',
  /** `{by}` — the recipient's thank-you. */
  THANK_YOU = 'thank_you',
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

/**
 * Force-disconnect signal: a user lost access to a wishlist, or left a group
 * gift, and must leave its chat.
 */
export const CHAT_FORCE_LEAVE = 'chat.force_leave';

export interface ChatForceLeave {
  chatType: ChatType;
  refId: string;
  userId: string;
  /** The chat itself — what the gateway's room is named by. */
  chatId: string;
}
