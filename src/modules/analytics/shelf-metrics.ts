/**
 * Measuring gift shelves: how often each kind is seen, and how often a
 * product on it is opened.
 *
 * What this exists to answer is one question — do shelves ranked by
 * somebody's taste get opened more than plain occasion shelves? — so the only
 * things an event may carry are the ones that question needs: where the shelf
 * was, what kind it was, whether it was personalised, and which position was
 * tapped.
 *
 * Deliberately *not* who it was for. A shelf event with a recipient on it
 * would be a log of who shops for whom, kept for the sake of a click-through
 * rate that does not need it. The client is asked not to send one, and this
 * is what makes sure: anything outside the shape below is dropped on the way
 * in, not stored and ignored.
 */

export const SHELF_VIEWED = 'shelf_viewed';
export const SHELF_PRODUCT_OPENED = 'shelf_product_opened';

/** Where a shelf can appear. */
export const SHELF_SURFACES = [
  'profile',
  'discover',
  'invite',
  'explore',
  'home',
  // "Gift ideas for Suma" under Suma's wishlist, where the list is filled.
  'wishlist',
] as const;

/**
 * What a shelf can be. Discover's section kinds, plus the two shelves that
 * live outside the feed: a WishMate's gift ideas and a guest's invitation.
 */
export const SHELF_KINDS = [
  'gift_suggestions',
  'wishmate_taste',
  'person_occasion',
  'price_band',
  'premium',
  'invite',
] as const;

/** Products past this position were never on a shelf; a larger number is noise. */
const MAX_POSITION = 50;

export interface ShelfProps {
  surface: (typeof SHELF_SURFACES)[number];
  kind: (typeof SHELF_KINDS)[number];
  personalised: boolean;
  /** Zero-based, and only on an open. */
  position?: number;
}

export const isShelfEvent = (name: string): boolean =>
  name === SHELF_VIEWED || name === SHELF_PRODUCT_OPENED;

/**
 * The props a shelf event may keep, or null to drop the event.
 *
 * Rebuilt rather than filtered, so a field added by a future client — a user
 * id, a product id, a search term — cannot ride through on the back of the
 * ones that are allowed.
 */
export function shelfPropsOf(name: string, raw: unknown): ShelfProps | null {
  if (!raw || typeof raw !== 'object') return null;
  const props = raw as Record<string, unknown>;

  const surface = SHELF_SURFACES.find((s) => s === props.surface);
  const kind = SHELF_KINDS.find((k) => k === props.kind);
  if (!surface || !kind || typeof props.personalised !== 'boolean') return null;

  const clean: ShelfProps = { surface, kind, personalised: props.personalised };
  if (name === SHELF_PRODUCT_OPENED) {
    const position = props.position;
    if (
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0 ||
      position > MAX_POSITION
    ) {
      return null;
    }
    clean.position = position;
  }
  return clean;
}

/** One row of the comparison the admin dashboard shows. */
export interface ShelfPerformanceRow {
  surface: string;
  kind: string;
  personalised: boolean;
  views: number;
  opens: number;
  /** Opens per view, rounded to four places — null with nothing viewed. */
  openRate: number | null;
}

/** Joins the two rolled-up counts into rows, best-performing first. */
export function shelfPerformance(
  views: { surface: string; kind: string; personalised: string; n: number }[],
  opens: { surface: string; kind: string; personalised: string; n: number }[],
): ShelfPerformanceRow[] {
  const key = (r: { surface: string; kind: string; personalised: string }) =>
    `${r.surface}|${r.kind}|${r.personalised}`;
  const rows = new Map<string, ShelfPerformanceRow>();
  const row = (r: { surface: string; kind: string; personalised: string }) => {
    const k = key(r);
    let existing = rows.get(k);
    if (!existing) {
      existing = {
        surface: r.surface,
        kind: r.kind,
        personalised: r.personalised === 'true',
        views: 0,
        opens: 0,
        openRate: null,
      };
      rows.set(k, existing);
    }
    return existing;
  };
  for (const v of views) row(v).views += v.n;
  for (const o of opens) row(o).opens += o.n;
  for (const r of rows.values()) {
    r.openRate = r.views > 0 ? Math.round((r.opens / r.views) * 10_000) / 10_000 : null;
  }
  return [...rows.values()].sort(
    (a, b) => (b.openRate ?? -1) - (a.openRate ?? -1) || b.views - a.views,
  );
}
