import {
  SHELF_PRODUCT_OPENED,
  SHELF_VIEWED,
  shelfPerformance,
  shelfPropsOf,
} from './shelf-metrics';

describe('what a shelf event may carry', () => {
  it('keeps the four fields the comparison needs', () => {
    expect(
      shelfPropsOf(SHELF_PRODUCT_OPENED, {
        surface: 'discover',
        kind: 'wishmate_taste',
        personalised: true,
        position: 2,
      }),
    ).toEqual({ surface: 'discover', kind: 'wishmate_taste', personalised: true, position: 2 });
  });

  it('drops anything else, however it is named', () => {
    const clean = shelfPropsOf(SHELF_VIEWED, {
      surface: 'profile',
      kind: 'gift_suggestions',
      personalised: false,
      recipientUserId: 'u_priyal',
      userId: 'u_priyal',
      productId: 'p1',
      query: 'candles for mum',
    });
    expect(clean).toEqual({ surface: 'profile', kind: 'gift_suggestions', personalised: false });
  });

  it.each([
    ['an unknown surface', { surface: 'email', kind: 'premium', personalised: false }],
    ['an unknown kind', { surface: 'discover', kind: 'mystery', personalised: false }],
    ['no personalised flag', { surface: 'discover', kind: 'premium' }],
    ['nothing at all', undefined],
  ])('rejects %s', (_, props) => {
    expect(shelfPropsOf(SHELF_VIEWED, props)).toBeNull();
  });

  it.each([[-1], [51], [1.5], ['2']])('an open needs a real position, not %p', (position) => {
    expect(
      shelfPropsOf(SHELF_PRODUCT_OPENED, {
        surface: 'discover',
        kind: 'premium',
        personalised: false,
        position,
      }),
    ).toBeNull();
  });

  it('a view carries no position', () => {
    expect(
      shelfPropsOf(SHELF_VIEWED, {
        surface: 'invite',
        kind: 'invite',
        personalised: false,
        position: 3,
      }),
    ).not.toHaveProperty('position');
  });
});

describe('the comparison', () => {
  it('joins views and opens and ranks by open rate', () => {
    const rows = shelfPerformance(
      [
        { surface: 'discover', kind: 'person_occasion', personalised: 'false', n: 100 },
        { surface: 'discover', kind: 'wishmate_taste', personalised: 'true', n: 40 },
      ],
      [
        { surface: 'discover', kind: 'person_occasion', personalised: 'false', n: 5 },
        { surface: 'discover', kind: 'wishmate_taste', personalised: 'true', n: 6 },
      ],
    );
    expect(rows.map((r) => [r.kind, r.personalised, r.openRate])).toEqual([
      ['wishmate_taste', true, 0.15],
      ['person_occasion', false, 0.05],
    ]);
  });

  it('opens with no views have no rate rather than an infinite one', () => {
    const [row] = shelfPerformance(
      [],
      [{ surface: 'home', kind: 'premium', personalised: 'false', n: 2 }],
    );
    expect(row.openRate).toBeNull();
  });
});
