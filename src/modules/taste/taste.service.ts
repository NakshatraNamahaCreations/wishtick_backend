import { Injectable } from '@nestjs/common';
import { ProfileService } from '../profile/profile.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { WishmateRelationship } from '../wishmates/wishmates.views';
import { buildTasteProfile, type TastePreferences } from './taste-profile.builder';
import { buildLexicon, type TasteLexicon } from './taste.lexicon';
import { TaxonomyKind } from '../taxonomy/taxonomy.types';
import type { TasteProfile } from './taste.types';
import type { TasteSummaryView } from './taste.views';

/**
 * Who a taste is being worked out for.
 *
 * `self` is the person looking at their own; `others` is everyone else a
 * taste can reach — a WishMate's card, the suggestions they ask for, the
 * feed shelf, the prewarm that plans those shelves. The default is `others`,
 * so a caller that forgets to say gets the careful answer.
 */
export type TasteAudience = 'self' | 'others';

/** The owner's sharing switches, as stored. Absent reads as shared. */
interface SharingSwitches {
  shareInterests?: boolean;
  shareCustomInterests?: boolean;
  shareColours?: boolean;
  shareSizes?: boolean;
}

/**
 * What of [preferences] may be used for [audience].
 *
 * For the owner, everything. For anybody else, each hidden group is removed
 * outright — not blanked on the card and kept for ranking, because ranking
 * speaks: "Likes Photography" under a suggestion, a size-matched item first.
 * Removed here, before anything is built, there is nothing downstream to leak.
 */
export function shareablePreferences(
  preferences: TastePreferences,
  audience: TasteAudience,
): TastePreferences {
  // Field by field rather than a spread: what arrives is usually a Mongoose
  // subdocument, and spreading one copies its internals, not its values.
  const p = preferences as TastePreferences & SharingSwitches;
  const all = audience === 'self';
  const interests = all || p.shareInterests !== false;
  const custom = all || p.shareCustomInterests !== false;
  const colours = all || p.shareColours !== false;
  const sizes = all || p.shareSizes !== false;
  return {
    interests: interests ? (p.interests ?? []) : [],
    interestCategories: interests ? (p.interestCategories ?? []) : [],
    giftCategories: interests ? (p.giftCategories ?? []) : [],
    customInterests: custom ? (p.customInterests ?? []) : [],
    favouriteColors: colours ? (p.favouriteColors ?? []) : [],
    clothingSize: sizes ? (p.clothingSize ?? null) : null,
    shoeSize: sizes ? (p.shoeSize ?? null) : null,
    fitPreference: sizes ? (p.fitPreference ?? null) : null,
    // Never shown to anybody and never part of what a WishMate can read back,
    // so not behind a switch: lifestyle only nudges a price band.
    lifestyle: p.lifestyle ?? [],
    occasions: p.occasions ?? [],
  };
}

/** How many of each kind a summary shows before it stops being readable. */
const MAX_INTERESTS = 8;
const MAX_CUSTOM = 4;
const MAX_COLOURS = 6;

/**
 * What somebody likes, for the two questions that get asked about it: "what
 * should we suggest for them?" and "what may this person read about them?".
 *
 * Deliberately knows nothing about products, affiliates or searching — that is
 * `SuggestionsModule`, which depends on this. And it takes the viewer's
 * relationship as an argument rather than looking it up, so `WishmatesModule`
 * can embed a summary without this module importing it back.
 */
@Injectable()
export class TasteService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  private async lexicon(): Promise<TasteLexicon> {
    return buildLexicon(await this.taxonomy.getOptions());
  }

  /** The stored preferences, whatever shape an older document is in. */
  private async preferencesOf(userId: string): Promise<TastePreferences> {
    const profile = await this.profiles.getOrCreate(userId);
    return profile.preferences ?? {};
  }

  /**
   * What to search with, and what to rank by, for one person.
   *
   * [occasionKey] and [relation] are for a recipient who is *not* an account —
   * a saved date carries a name, a relation and an occasion, and that is still
   * enough to pick a sensible shelf.
   */
  async profileFor(
    userId: string | null,
    opts: {
      occasionKey?: string | null;
      relation?: string | null;
      minPriceMinor?: number | null;
      maxPriceMinor?: number | null;
      /** Who is asking. Anybody but the owner sees only what is shared. */
      audience?: TasteAudience;
    } = {},
  ): Promise<TasteProfile> {
    const { audience = 'others', ...rest } = opts;
    const lexicon = await this.lexicon();
    const profile = userId ? await this.profiles.getOrCreate(userId) : null;
    const preferences = profile ? shareablePreferences(profile.preferences ?? {}, audience) : {};
    // Gender shapes the search and the order, and nothing else: it is never
    // a reason, never on the taste card, and never in a query handed back to
    // the app — so a WishMate is not told it, only shown gifts that suit.
    return buildTasteProfile(
      { userId, preferences, gender: profile?.gender ?? null, ...rest },
      lexicon,
    );
  }

  /**
   * The same thing, for preferences that are not a particular person's.
   *
   * What the prewarm needs: "what would somebody who picked *this* be shown?",
   * asked of the shapes many accounts share rather than of any one account.
   * No user id goes in and none comes out, so nothing built here can be traced
   * back to whoever happened to pick that combination.
   */
  async profileForPreferences(preferences: TastePreferences): Promise<TasteProfile> {
    // Planned the way other people's shelves for this person are planned, so
    // a hidden interest is never warmed on anybody's behalf either.
    return buildTasteProfile(
      { userId: null, preferences: shareablePreferences(preferences, 'others') },
      await this.lexicon(),
    );
  }

  /**
   * What [viewer] may read about [targetId]'s taste, or null.
   *
   * Null for every relationship but WishMates and self — and null, not an
   * empty summary, because a caller who can tell "withheld" from "they have
   * not said" has learned something they were not told.
   */
  async summaryFor(
    targetId: string,
    opts: { relationship: WishmateRelationship; displayName?: string | null },
  ): Promise<TasteSummaryView | null> {
    const { relationship } = opts;
    const isSelf = relationship === WishmateRelationship.SELF;
    if (!isSelf && relationship !== WishmateRelationship.WISHMATES) return null;

    const [lexicon, stored] = await Promise.all([this.lexicon(), this.preferencesOf(targetId)]);
    // A hidden group comes back empty, exactly like one never filled in —
    // "withheld" must read the same as "not said", or the card itself says
    // that something is being kept back.
    const preferences = shareablePreferences(stored, isSelf ? 'self' : 'others');
    const taste = buildTasteProfile({ userId: targetId, preferences }, lexicon);

    const interests = (preferences.interests ?? [])
      .map((key) => {
        const label = lexicon.label(TaxonomyKind.INTEREST, key);
        return label ? { key, label } : null;
      })
      .filter((chip): chip is { key: string; label: string } => chip !== null)
      .slice(0, MAX_INTERESTS);

    const colours = taste.colours
      .slice(0, MAX_COLOURS)
      .map((colour) => ({ key: colour.key, label: colour.label, hex: colour.hex }));

    const customInterests = (preferences.customInterests ?? [])
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .slice(0, MAX_CUSTOM);

    // Shown by default; the owner can turn them off and keep the rest. Absent
    // rather than blanked for a viewer who was refused them.
    const sharesSizes = (stored as { shareSizes?: boolean }).shareSizes ?? true;
    const sizes =
      isSelf || sharesSizes
        ? {
            clothing: taste.sizes.clothing,
            shoe: taste.sizes.shoe?.label ?? null,
            fit: taste.sizes.fit,
          }
        : null;

    const empty =
      interests.length === 0 &&
      customInterests.length === 0 &&
      colours.length === 0 &&
      (sizes === null || (!sizes.clothing && !sizes.shoe && !sizes.fit));

    const name = (opts.displayName ?? '').trim();
    return {
      title: isSelf ? 'What you like' : name ? `What ${name} likes` : 'What they like',
      note: empty ? this.emptyNote(isSelf, name) : null,
      interests,
      customInterests,
      colours,
      sizes,
      completeness: Math.round(taste.completeness * 100),
      isSelf,
    };
  }

  private emptyNote(isSelf: boolean, name: string): string {
    if (isSelf) {
      return (
        'You have not added anything yet. What you add here is what your ' +
        'WishMates see when they are looking for a gift for you.'
      );
    }
    const who = name || 'They';
    const verb = name ? 'has' : 'have';
    return `${who} ${verb} not added their likes yet — suggestions go by the occasion instead.`;
  }
}
