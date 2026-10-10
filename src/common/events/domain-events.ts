/**
 * Internal domain events, published on the EventEmitter.
 *
 * They live in `common` so a publisher and a subscriber never have to import
 * each other's module. AuthService emits USER_REGISTERED without knowing that
 * events and wishlists listen for it — which is what lets those modules link
 * their pending invites on signup without auth depending on them (auth is
 * upstream of both, and a direct call would be a cycle).
 */
export const USER_REGISTERED = 'user.registered';

/**
 * Someone used the app: a sign-in, or a session refreshed while the app was
 * open. Emitted on every one — the analytics listener keeps the first per
 * person per day, which is what "active" means in the numbers.
 */
export const USER_ACTIVE = 'user.active';

export interface UserActiveEvent {
  userId: string;
}

/**
 * A shared wishlist link was opened by somebody other than its owner — the
 * one sign the server ever gets that a list was shared, since sharing itself
 * happens in the phone's share sheet.
 */
export const WISHLIST_LINK_OPENED = 'wishlist.link_opened';

export interface WishlistLinkOpenedEvent {
  wishlistId: string;
  ownerId: string;
  /** Null for somebody not signed in. */
  viewerUserId: string | null;
}

export interface UserRegisteredEvent {
  userId: string;
  email?: string;
  phone?: string;
  /** Acquisition source captured at signup (whatsapp|invite|referral|...). */
  source?: string;
}

/**
 * A group gift reached its target. Emitted the moment `collectedAmount` crosses
 * `targetAmount`, once, from inside the same critical section that recorded the
 * contribution that tipped it over. Sprint 8 (chat) posts a system message and
 * Sprint 9 (notifications) fans out to the participants — both subscribe here
 * rather than coupling to the gifting module.
 */
/**
 * A member of an evenly split group gift still owes part of their share.
 *
 * Emitted once a day per person who owes, until they have paid. [day] is in
 * the notification's reference, so each day is a fresh reminder and not a
 * repeat of yesterday's that the dedupe would drop.
 */
export const GROUP_GIFT_SHARE_REMINDER_DUE = 'group_gift.share_reminder_due';

export interface GroupGiftShareReminderDueEvent {
  groupGiftId: string;
  userId: string;
  title: string;
  owesMinor: number;
  shareMinor: number;
  paidMinor: number;
  currency: string;
  /** YYYY-MM-DD, UTC — which day's reminder this is. */
  day: string;
  /**
   * Still only invited — not yet in the group. They cannot open the group
   * itself, so their reminder leads to the invitation instead.
   */
  invited: boolean;
}

/**
 * The host called a group gift off. Every member is told, with the host's
 * reason when they gave one; whoever had paid is told their money is counted
 * as refunded. The recipient is never among them — it was a surprise.
 */
export const GROUP_GIFT_CANCELLED = 'group_gift.cancelled';

export interface GroupGiftCancelledEvent {
  groupGiftId: string;
  title: string;
  hostId: string;
  reason: string | null;
  currency: string;
  /**
   * Everybody but the host, with what each had paid in (0 if nothing) and
   * what they said they sent that the host had not confirmed yet.
   */
  members: { userId: string; refundedMinor: number; pendingMinor: number }[];
}

export const GROUP_GIFT_FUNDED = 'group_gift.funded';

export interface GroupGiftFundedEvent {
  groupGiftId: string;
  itemId: string;
  wishlistId: string;
  initiatorId: string;
  targetAmountMinor: number;
  collectedAmountMinor: number;
  currency: string;
  contributorCount: number;
}

/**
 * A confirmed contribution landed on a group gift. Carries no PII beyond the
 * contributor id (subscribers redact for anonymous ones); Sprint 8 renders it as
 * a "someone chipped in" system message.
 */
export const GROUP_GIFT_CONTRIBUTION_RECEIVED = 'group_gift.contribution_received';

export interface GroupGiftContributionReceivedEvent {
  groupGiftId: string;
  contributionId: string;
  contributorId: string;
  amountMinor: number;
  anonymous: boolean;
  collectedAmountMinor: number;
  targetAmountMinor: number;
  /**
   * The host confirming a member's payment, rather than money arriving on its
   * own. The host has nothing to be told about it — they just did it.
   */
  reviewed?: boolean;
}

/**
 * A member says they sent their money. It counts for nothing until the host
 * confirms it, so the host is asked to.
 */
export const GROUP_GIFT_PAYMENT_CLAIMED = 'group_gift.payment_claimed';

export interface GroupGiftPaymentClaimedEvent {
  groupGiftId: string;
  contributionId: string;
  contributorId: string;
  hostId: string;
  title: string;
  amountMinor: number;
  currency: string;
}

/** The host said what arrived from a member's payment. The member is told. */
export const GROUP_GIFT_PAYMENT_REVIEWED = 'group_gift.payment_reviewed';

export interface GroupGiftPaymentReviewedEvent {
  groupGiftId: string;
  contributionId: string;
  contributorId: string;
  hostId: string;
  title: string;
  claimedMinor: number;
  receivedMinor: number;
  currency: string;
  /** ISO time of this review — each review is its own notification. */
  reviewedAt: string;
}

/** A member says they did pay, against what the host recorded. */
export const GROUP_GIFT_PAYMENT_DISPUTED = 'group_gift.payment_disputed';

export interface GroupGiftPaymentDisputedEvent {
  groupGiftId: string;
  contributionId: string;
  contributorId: string;
  hostId: string;
  title: string;
  claimedMinor: number;
  receivedMinor: number;
  paymentRef: string | null;
  note: string | null;
  currency: string;
  disputedAt: string;
}

/** Once a day, to a host with payments still waiting for them to confirm. */
export const GROUP_GIFT_CONFIRM_REMINDER_DUE = 'group_gift.confirm_reminder_due';

export interface GroupGiftConfirmReminderDueEvent {
  groupGiftId: string;
  hostId: string;
  title: string;
  count: number;
  totalMinor: number;
  currency: string;
  /** YYYY-MM-DD, UTC. */
  day: string;
}

/**
 * The nightly reconciler found `collectedAmount` disagreeing with the sum of
 * confirmed contributions. This should never fire; when it does it is a data
 * bug, so it is loud on purpose.
 */
export const GROUP_GIFT_DRIFT_DETECTED = 'group_gift.drift_detected';

export interface GroupGiftDriftDetectedEvent {
  groupGiftId: string;
  cachedAmountMinor: number;
  summedAmountMinor: number;
  driftMinor: number;
}

/** Someone joined a group gift as a member. The chat posts a "user joined" note. */
export const GROUP_GIFT_JOINED = 'group_gift.joined';
export const GROUP_GIFT_INVITED = 'group_gift.invited';

/** A WishMate was asked to chip in. */
export interface GroupGiftInvitedEvent {
  groupGiftId: string;
  invitedUserId: string;
  invitedById: string;
  /**
   * Their share of an equal split, so the notification can say it. Null for
   * a custom-amount gift, or a split that could not be worked out.
   */
  shareMinor?: number | null;
}

export interface GroupGiftJoinedEvent {
  groupGiftId: string;
  userId: string;
}

/** A funded group gift was purchased by its initiator. */
export const GROUP_GIFT_PURCHASED = 'group_gift.purchased';

export interface GroupGiftPurchasedEvent {
  groupGiftId: string;
  itemId: string;
  initiatorId: string;
}

/** A group gift was delivered. Terminal success. */
export const GROUP_GIFT_FULFILLED = 'group_gift.fulfilled';

export interface GroupGiftFulfilledEvent {
  groupGiftId: string;
  itemId: string;
}

/**
 * A participant lost access to a wishlist. The chat gateway force-disconnects
 * them from the wishlist's chat so they cannot receive further messages, and the
 * REST history re-checks access so they cannot read past ones.
 */
/**
 * Somebody asked to be a WishMate, or said yes to being asked.
 *
 * The whole module was silent before these: a request reached the addressee's
 * WishLink screen and nowhere else, so the only way to learn about one was to
 * go looking for it.
 */
export const WISHMATE_REQUESTED = 'wishmate.requested';
export const WISHMATE_ACCEPTED = 'wishmate.accepted';

export interface WishmateRequestedEvent {
  linkId: string;
  requesterId: string;
  addresseeId: string;
  /**
   * When this particular ask happened, in epoch ms.
   *
   * Part of the notification's dedupe key, and it has to be: a declined link
   * is *re-opened* rather than replaced (see `WishmatesService.request`), so
   * the link id alone repeats. Keyed on that, a second ask months after a
   * decline would be deduped against the first and silently never arrive.
   */
  askedAt: number;
}

export interface WishmateAcceptedEvent {
  linkId: string;
  /** The one who said yes — whose profile the notification opens. */
  accepterId: string;
  /** The one who asked, and who is told. */
  requesterId: string;
}

/**
 * Somebody wrote in a conversation.
 *
 * Chat delivery was websocket-only, which means it reached exactly the people
 * who already had the conversation open — everybody else learned nothing, and
 * a message sent to somebody with the app closed was never announced at all.
 *
 * Carries the audience rather than the chat, because who should be told is a
 * chat concern (participants, minus the sender, minus anyone the message is
 * hidden from) and working it out twice would let the two answers drift.
 */
export const CHAT_MESSAGE_POSTED = 'chat.message_posted';

export interface ChatMessagePostedEvent {
  chatId: string;
  messageId: string;
  senderId: string;
  /** Who to tell. Already excludes the sender and any hidden-from viewer. */
  recipientIds: string[];
  /** The text, for the preview. Empty for an attachment-only message. */
  body: string;
  /** True for a direct message, which reads differently from a group. */
  direct: boolean;
}

export const WISHLIST_PARTICIPANT_REVOKED = 'wishlist.participant_revoked';

export interface WishlistParticipantRevokedEvent {
  wishlistId: string;
  userId: string;
}

/**
 * Single-gift lifecycle. Emitted post-commit from GiftingService so Sprint 9
 * notifications can email the right party — the gifter on reserve, the recipient
 * on fulfil (which also kicks off the thank-you note). Each carries every id a
 * subscriber needs so it never has to read back into the gifting module.
 */
export interface GiftLifecycleEvent {
  giftId: string;
  itemId: string;
  gifterId: string;
  recipientId: string;
  wishlistId: string;
}

export const GIFT_RESERVED = 'gift.reserved';
export const GIFT_PURCHASED = 'gift.purchased';
export const GIFT_FULFILLED = 'gift.fulfilled';

/**
 * The gifter withdrew a gift: "I didn't buy it after all".
 *
 * Emitted only from the gifter's own cancel, which is the one path that can
 * withdraw a gift that was already bought and therefore the only one with an
 * order behind it. Releasing a reservation and letting a hold lapse both end
 * a gift too, but neither ever had an order to close.
 *
 * Nobody is notified: the gifter is the one who did it, and telling the person
 * the gift was for would spoil a surprise they were never told about.
 */
export const GIFT_CANCELLED = 'gift.cancelled';

/**
 * A time-locked reel finished compiling and is now released to its recipient.
 * Emitted after the collection flips to `released`; Sprint 9 notifications email
 * and in-app the recipient, closing the birthday loop.
 */
export const REEL_RELEASED = 'reel.released';

export interface ReelReleasedEvent {
  reelId: string;
  recipientId: string;
  wishCount: number;
  reelMediaUrl: string | null;
}

/**
 * A time-locked memory capsule opened (`2078:357`). Emitted after the capsule
 * flips to `unlocked`, whether by the scheduled job or by the host opening it
 * early.
 *
 * The audience is the host, the contributors, and the recipient. The recipient
 * was once left out, because a capsule could be addressed to a typed name with
 * no account behind it; `recipientUserId` is a required WishMate now, and the
 * person a memory was made for is the last one who should have to find out it
 * opened by chance — not least because replying is now something they can do.
 */
export const MEMORY_UNLOCKED = 'memory.unlocked';

export interface MemoryUnlockedEvent {
  capsuleId: string;
  hostId: string;
  contributorIds: string[];
  /** Null only for a capsule made before recipients had to be accounts. */
  recipientId: string | null;
  title: string;
  wishCount: number;
}

/**
 * The recipient of an opened capsule replied to the people who filled it.
 *
 * Emitted once per send, with every addressee — the notification listener fans
 * it out. One event rather than one per recipient because the author performed
 * one action, and a partial fan-out is then visible as a partial failure of one
 * job rather than as several unrelated ones.
 */
export const MEMORY_REPLY_SENT = 'memory.reply_sent';

export interface MemoryReplySentEvent {
  replyId: string;
  authorId: string;
  authorName: string;
  recipientIds: string[];
  /** For the deep link — the reply is read on a capsule's own screen. */
  capsuleId: string;
  capsuleTitle: string;
}

/**
 * The person a memory was for loved one of its wishes. Its writer is told —
 * once: the notification ledger keys on the wish, so taking the love back and
 * giving it again does not tell them twice.
 */
export const MEMORY_WISH_LOVED = 'memory.wish_loved';

export interface MemoryWishLovedEvent {
  capsuleId: string;
  wishId: string;
  /** Who wrote the wish, and is told. */
  contributorId: string;
  /** Who loved it: the person the memory was for. */
  lovedByName: string;
  capsuleTitle: string;
}

/**
 * A user was suspended or force-logged-out by an admin. Their access is already
 * revoked at the guard layer (status + tokensInvalidBefore); the chat gateway
 * additionally drops their live sockets so a websocket cannot outlive the ban.
 */
export const USER_FORCE_DISCONNECT = 'user.force_disconnect';

export interface UserForceDisconnectEvent {
  userId: string;
  reason: string;
}

/**
 * A user reported content, or an auto-flag hook raised it. Promoted here from the
 * chat module's old bare string so the moderation listener and chat share a type.
 */
export const CONTENT_FLAGGED = 'content.flagged';

export interface ContentFlaggedEvent {
  targetType: string;
  targetId: string;
  reason: string;
  senderId: string | null;
}

/**
 * A guest offered one of their own wishlists to an event they are going to.
 *
 * The host has to answer it before the list shows on the invitation, and the
 * queue lives at the foot of one event's page — so without this the offer sat
 * there unseen and the guest was never told why nothing happened.
 */
export const EVENT_WISHLIST_OFFERED = 'event.wishlist_offered';

/**
 * Carries the resolved names rather than ids alone, so the notification
 * listener needs no Event or Wishlist model of its own: the service that
 * emits this has already loaded both.
 */
export interface EventWishlistOfferedEvent {
  eventId: string;
  submissionId: string;
  /** The host, who has to answer it. */
  hostId: string;
  guestName: string;
  eventTitle: string;
  wishlistTitle: string;
}

/**
 * A run of the affiliate reconciliation finished with rows to look at.
 *
 * Carries no rows: what a sale means for a gift is the gifting module's
 * business, and the products module must not learn about gifts in order to
 * say that new sales have landed.
 */
export const AFFILIATE_CONVERSIONS_SYNCED = 'affiliate.conversions_synced';

export interface AffiliateConversionsSyncedEvent {
  network: string;
  transactions: number;
}

/**
 * A reported sale was matched to a gift somebody is holding.
 *
 * The affiliate network is the only party besides the gifter that can say a
 * purchase happened, and it says so hours later — so this is emitted from the
 * reconciliation, not from anything a person did.
 */
export const AFFILIATE_SALE_MATCHED = 'affiliate.sale_matched';

export interface AffiliateSaleMatchedEvent {
  giftId: string;
  network: string;
  /** The network's transaction id — what `Gift.orderRef` now carries. */
  externalId: string;
  /** The merchant's own order number, when it gave one. */
  orderId: string | null;
  saleAmountMinor: number | null;
  currency: string;
  /** The network's status, verbatim. */
  status: string | null;
  /**
   * Whether the network has validated the sale, as opposed to merely seeing
   * it. A pending sale is enough to say a gift was bought; only a validated
   * one is enough to say the money is real.
   */
  confirmed: boolean;
}

/**
 * A host put somebody with an account on an event's guest list.
 *
 * Inviting used to write the row and stop there: the email and SMS that once
 * carried an invitation were removed on the understanding that a WishMate is
 * "told in the app", and nothing in the app ever told them. The invitation
 * reached the guest's Invites tab and nowhere else.
 *
 * Only for an invite that names an account. A number with nobody behind it
 * has nobody to tell; the host's share link is how that person arrives.
 */
export const EVENT_INVITED = 'event.invited';

export interface EventInvitedEvent {
  eventId: string;
  inviteId: string;
  /**
   * The guest's own invitation token — what the app opens. Sent only to the
   * person it belongs to, who holds it already on their Invites tab.
   */
  inviteToken: string;
  hostId: string;
  invitedUserId: string;
  eventTitle: string;
}

/**
 * Somebody opened a private event's share link without being on its guest
 * list, and asked the host to let them in.
 *
 * The host has to answer before they can come, and nothing else would tell
 * them the ask exists — so it is announced rather than left in a queue.
 */
export const EVENT_JOIN_REQUESTED = 'event.join_requested';

export interface EventJoinRequestedEvent {
  eventId: string;
  requestId: string;
  hostId: string;
  requesterName: string | null;
  eventTitle: string;
}

/**
 * The host let somebody in who asked to join.
 *
 * A decline is deliberately not announced: the asker finds out only if they
 * open the link again, which is kinder than a notification that says no.
 */
export const EVENT_JOIN_ACCEPTED = 'event.join_accepted';

export interface EventJoinAcceptedEvent {
  eventId: string;
  requestId: string;
  requesterId: string;
  /** Their invitation token now — what the notification opens. */
  inviteToken: string;
  eventTitle: string;
}

/** The host approved or declined a guest's offered wishlist. */
export const EVENT_WISHLIST_ANSWERED = 'event.wishlist_answered';

export interface EventWishlistAnsweredEvent {
  eventId: string;
  submissionId: string;
  /** Whoever offered the list, and has been waiting to hear. */
  guestId: string;
  eventTitle: string;
  wishlistTitle: string;
  approved: boolean;
}

/**
 * A guest answered — or changed their answer to — an invitation.
 *
 * The host used to find out only by opening the guest list: nothing told them
 * a reply had come in, which is the one thing a host planning food and seats
 * is waiting to hear. Emitted only when the answer actually changes, so a
 * guest reopening their invite link and tapping the same button again does
 * not buzz the host a second time.
 */
export const EVENT_RSVP_CHANGED = 'event.rsvp_changed';

export interface EventRsvpChangedEvent {
  eventId: string;
  inviteId: string;
  hostId: string;
  /** Null for a guest who answered from a link without an account. */
  guestUserId: string | null;
  eventTitle: string;
  response: 'yes' | 'no' | 'maybe';
  plusOnes: number;
  /** When they answered — part of the dedupe key, so a changed mind is news. */
  respondedAt: Date;
}

/** Someone the host's event news should reach: an account, and its own invite. */
export interface EventGuestRecipient {
  userId: string;
  /** The guest's own invitation token — what their app opens the event by. */
  inviteToken: string;
}

/**
 * The host called the event off.
 *
 * Cancelling used to quietly drop the pending reminders and say nothing, so a
 * guest learned the party was off by turning up to it. Recipients are the
 * guests who might have come — anyone who had already declined has no plans
 * to undo.
 */
export const EVENT_CALLED_OFF = 'event.called_off';

export interface EventCalledOffEvent {
  eventId: string;
  hostId: string;
  eventTitle: string;
  /** When it would have been, so the message names which party is off. */
  startsAt: Date;
  timezone: string;
  recipients: EventGuestRecipient[];
}

/**
 * The host moved a published event, or changed where it is.
 *
 * Moving it used to reschedule the reminders and nothing else: the first a
 * guest heard of a new date was a reminder counting down to it, and a new
 * venue was never announced at all.
 */
export const EVENT_DETAILS_CHANGED = 'event.details_changed';

export type EventDetailChange = 'time' | 'venue';

export interface EventDetailsChangedEvent {
  eventId: string;
  hostId: string;
  eventTitle: string;
  /** What moved, in the order a guest would want to hear it. */
  changes: EventDetailChange[];
  /** The new start, and the new venue — the values after the change. */
  startsAt: Date;
  timezone: string;
  venue: string | null;
  /** When the change was saved: two edits in one evening are two notices. */
  changedAt: Date;
  recipients: EventGuestRecipient[];
}

/**
 * A recipient showed some of their memories to some of their WishMates.
 *
 * Carries only the people newly given access — sharing the same memories
 * with the same person twice is not news to them.
 */
export const MEMORY_SHARED = 'memory.shared';

export interface MemorySharedEvent {
  /** The recipient who shared. */
  ownerId: string;
  /** Per viewer, the memories they can now watch. */
  grants: { viewerId: string; capsuleIds: string[] }[];
  /** Titles by capsule id, for the notification's words. */
  titles: Record<string, string>;
  sharedAt: Date;
}
