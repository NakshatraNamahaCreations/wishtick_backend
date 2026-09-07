export enum NotificationChannel {
  IN_APP = 'in_app',
  EMAIL = 'email',
  SMS = 'sms',
  /**
   * A device push. Unlike the others its address is a *set* of registered FCM
   * tokens rather than one string, so the dispatcher gives it its own branch.
   */
  PUSH = 'push',
}

/**
 * How a notification is treated by quiet hours, unsubscribe, and digesting.
 *
 *  - CRITICAL  — security/account. Bypasses quiet hours and cannot have its
 *                email fully unsubscribed (you cannot mute "your password
 *                changed").
 *  - NORMAL    — the default. Respects quiet hours (deferred, never dropped)
 *                and unsubscribe.
 *  - DIGEST    — low-signal. Its email rolls into a once-daily digest instead of
 *                sending immediately; in-app still lands right away.
 */
export enum NotificationPriority {
  CRITICAL = 'critical',
  NORMAL = 'normal',
  DIGEST = 'digest',
}

/** Categories a user can unsubscribe from, one row per group. */
export enum NotificationCategory {
  ACCOUNT = 'account',
  GIFTS = 'gifts',
  GROUP_GIFTS = 'group_gifts',
  EVENTS = 'events',
  SOCIAL = 'social',
  REELS = 'reels',
  MEMORIES = 'memories',
}

/** Every kind of notification the system can raise. */
export enum NotificationType {
  WELCOME = 'welcome',
  GIFT_RESERVED = 'gift_reserved',
  GIFT_PURCHASED = 'gift_purchased',
  GIFT_FULFILLED = 'gift_fulfilled',
  GROUP_GIFT_FUNDED = 'group_gift_funded',
  GROUP_GIFT_CONTRIBUTION = 'group_gift_contribution',
  GROUP_GIFT_JOINED = 'group_gift_joined',
  GROUP_GIFT_INVITE = 'group_gift_invite',
  GROUP_GIFT_PURCHASED = 'group_gift_purchased',
  GROUP_GIFT_FULFILLED = 'group_gift_fulfilled',
  EVENT_REMINDER = 'event_reminder',
  EVENT_WISHLIST_OFFERED = 'event_wishlist_offered',
  EVENT_WISHLIST_ANSWERED = 'event_wishlist_answered',
  ITEM_PRICE_DROP = 'item_price_drop',
  ITEM_OUT_OF_STOCK = 'item_out_of_stock',
  THANK_YOU = 'thank_you',
  ACCOUNT_SECURITY = 'account_security',
  REEL_RELEASED = 'reel_released',
  MEMORY_UNLOCKED = 'memory_unlocked',
  MEMORY_REPLY = 'memory_reply',
  CONTENT_REMOVED = 'content_removed',
}

export enum DeliveryStatus {
  /** Claimed in the ledger, channel job enqueued. */
  QUEUED = 'queued',
  SENT = 'sent',
  /** Held for quiet hours; will be retried after the window. */
  DEFERRED = 'deferred',
  /** Preference/unsubscribe/undeliverable said no. Terminal, not an error. */
  SUPPRESSED = 'suppressed',
  /** Collapsed by the dedupe key — an identical notification already went. */
  DEDUPED = 'deduped',
  /** Rolled into the daily digest instead of sending now. */
  DIGESTED = 'digested',
  FAILED = 'failed',
}

export interface NotificationSpec {
  /** Channels this type may use, before the user's preferences narrow them. */
  channels: NotificationChannel[];
  priority: NotificationPriority;
  category: NotificationCategory;
  /** The MJML/text template key under templates/. */
  template: string;
}

/**
 * THE registry. Everything the pipeline decides — which channels to try, whether
 * to defer in quiet hours, whether it digests, whether it can be unsubscribed —
 * is read from this one table, so adding a notification is adding a row, not
 * editing the dispatcher.
 */
export const NOTIFICATION_SPECS: Record<NotificationType, NotificationSpec> = {
  [NotificationType.WELCOME]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.ACCOUNT,
    template: 'welcome',
  },
  [NotificationType.GIFT_RESERVED]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.GIFTS,
    template: 'gift-reserved',
  },
  [NotificationType.GIFT_PURCHASED]: {
    channels: [NotificationChannel.IN_APP],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.GIFTS,
    template: 'gift-purchased',
  },
  [NotificationType.GIFT_FULFILLED]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.GIFTS,
    template: 'gift-fulfilled',
  },
  [NotificationType.GROUP_GIFT_FUNDED]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.GROUP_GIFTS,
    template: 'group-gift-funded',
  },
  [NotificationType.GROUP_GIFT_CONTRIBUTION]: {
    channels: [NotificationChannel.IN_APP],
    priority: NotificationPriority.DIGEST,
    category: NotificationCategory.GROUP_GIFTS,
    template: 'group-gift-contribution',
  },
  [NotificationType.GROUP_GIFT_INVITE]: {
    // Not DIGEST, unlike the rest of this category: an invitation is a
    // question waiting on an answer, and batching it into tomorrow's summary
    // is how a collection closes before the person asked has seen it.
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.GROUP_GIFTS,
    template: 'group-gift-invite',
  },
  [NotificationType.GROUP_GIFT_JOINED]: {
    channels: [NotificationChannel.IN_APP],
    priority: NotificationPriority.DIGEST,
    category: NotificationCategory.GROUP_GIFTS,
    template: 'group-gift-joined',
  },
  [NotificationType.GROUP_GIFT_PURCHASED]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.GROUP_GIFTS,
    template: 'group-gift-purchased',
  },
  [NotificationType.GROUP_GIFT_FULFILLED]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.GROUP_GIFTS,
    template: 'group-gift-fulfilled',
  },
  [NotificationType.EVENT_REMINDER]: {
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.EMAIL,
      NotificationChannel.SMS,
      NotificationChannel.PUSH,
    ],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.EVENTS,
    template: 'event-reminder',
  },
  [NotificationType.EVENT_WISHLIST_OFFERED]: {
    // Not DIGEST, for the reason GROUP_GIFT_INVITE is not: this is a question
    // waiting on the host's answer, and the guest cannot see their list on the
    // invitation until it is given. Rolling it into tomorrow's summary is how
    // a party happens with the list still pending.
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.EVENTS,
    template: 'event-wishlist-offered',
  },
  [NotificationType.EVENT_WISHLIST_ANSWERED]: {
    // The other half. Offering a list used to end in silence whichever way the
    // host decided.
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.EVENTS,
    template: 'event-wishlist-answered',
  },
  [NotificationType.ITEM_PRICE_DROP]: {
    channels: [NotificationChannel.IN_APP],
    priority: NotificationPriority.DIGEST,
    category: NotificationCategory.GIFTS,
    template: 'item-price-drop',
  },
  [NotificationType.ITEM_OUT_OF_STOCK]: {
    channels: [NotificationChannel.IN_APP],
    priority: NotificationPriority.DIGEST,
    category: NotificationCategory.GIFTS,
    template: 'item-out-of-stock',
  },
  [NotificationType.THANK_YOU]: {
    channels: [NotificationChannel.EMAIL],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.SOCIAL,
    template: 'thank-you',
  },
  [NotificationType.ACCOUNT_SECURITY]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.SMS],
    priority: NotificationPriority.CRITICAL,
    category: NotificationCategory.ACCOUNT,
    template: 'account-security',
  },
  [NotificationType.REEL_RELEASED]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.REELS,
    template: 'reel-released',
  },
  [NotificationType.MEMORY_UNLOCKED]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.MEMORIES,
    template: 'memory-unlocked',
  },
  [NotificationType.MEMORY_REPLY]: {
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
    priority: NotificationPriority.NORMAL,
    category: NotificationCategory.MEMORIES,
    template: 'memory-reply',
  },
  [NotificationType.CONTENT_REMOVED]: {
    // A moderation notice is account business and cannot be unsubscribed.
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    priority: NotificationPriority.CRITICAL,
    category: NotificationCategory.ACCOUNT,
    template: 'content-removed',
  },
};

/** Critical types bypass quiet hours and cannot have their email unsubscribed. */
export const isCritical = (type: NotificationType): boolean =>
  NOTIFICATION_SPECS[type].priority === NotificationPriority.CRITICAL;

/** A digest type's email is collapsed into the daily digest instead of sent now. */
export const isDigest = (type: NotificationType): boolean =>
  NOTIFICATION_SPECS[type].priority === NotificationPriority.DIGEST;
