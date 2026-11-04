/**
 * Where on Home a banner is shown. Each is its own carousel, managed from the
 * admin panel: the owner's two ad slots on the redesigned Home screen.
 */
export enum BannerPlacement {
  /** "Exclusive Offers" — wide picture banners, the picture is the message. */
  EXCLUSIVE_OFFERS = 'exclusive_offers',
  /** "Special Offers for You" — smaller wide picture cards, the next one peeking in. */
  SPECIAL_OFFERS = 'special_offers',
}

/** A banner's picture: WebP, made small by the panel before it is sent. */
export const BANNER_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** The most banners one carousel shows; the rest wait their turn. */
export const BANNERS_PER_PLACEMENT = 10;

/**
 * Where a banner leads when tapped: a web page (`https://…`), or a screen in
 * the app named by its path (`/discover/occasions/birthday`).
 */
export const BANNER_LINK_PATTERN = /^(https:\/\/[^\s]+|\/[A-Za-z0-9\-._~/%?=&]*)$/;

/** One banner, as the app draws it. */
export interface HomeBannerView {
  id: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  linkUrl: string | null;
}

/** What the app asks for once: both carousels, live banners only. */
export interface HomeBannersView {
  exclusiveOffers: HomeBannerView[];
  specialOffers: HomeBannerView[];
}

/** One banner, as the panel edits it — everything, including what is not live. */
export interface AdminBannerView extends HomeBannerView {
  position: number;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Whether the app shows it right now: switched on and inside its dates. */
  live: boolean;
  createdAt: Date;
  updatedAt: Date;
}
