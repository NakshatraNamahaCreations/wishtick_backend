/**
 * The 12 dashboard sections from the scope. The keys are the contract clients
 * build against, so they are fixed now even though most of the data arrives in
 * later sprints.
 */
export enum DashboardSection {
  MY_EVENTS = 'myEvents',
  INVITED_EVENTS = 'invitedEvents',
  GIFTS_GIVEN = 'giftsGiven',
  GIFTS_RECEIVED = 'giftsReceived',
  GIFTS_ON_HOLD = 'giftsOnHold',
  MY_WISHLISTS = 'myWishlists',
  EVENTS_AND_INVITES = 'eventsAndInvites',
  WISHLIST_CHATS = 'wishlistChats',
  GROUP_GIFT_CHATS = 'groupGiftChats',
  NOTIFICATIONS = 'notifications',
  REELS = 'reels',
  PROFILE_SETTINGS = 'profileSettings',
}

export interface SectionSummary {
  /** Total items in the section. */
  count: number;
  /** Items needing attention — unread chats, pending invites, unseen notifications. */
  badge: number;
  /**
   * False until the sprint that owns this section ships. Clients should render
   * the section as coming-soon rather than as an empty state, so "no data yet"
   * and "not built yet" stay distinguishable.
   */
  available: boolean;
}

export interface DashboardSummary {
  sections: Record<DashboardSection, SectionSummary>;
  profile: {
    displayName: string | null;
    photoUrl: string | null;
    onboardingCompleted: boolean;
    /** 0–100. Nudges users toward the data that makes gifting suggestions work. */
    completeness: number;
    missingFields: string[];
  };
  generatedAt: Date;
}
