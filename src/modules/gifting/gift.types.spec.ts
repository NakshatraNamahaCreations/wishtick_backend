import { GIFT_TRANSITIONS, GiftStatus } from './gift.types';

/**
 * The state machine as data, tested as data.
 *
 * GiftStatusService reads this table and nothing else decides a legal move, so
 * pinning the table pins the machine. These are cheap invariants that would
 * otherwise only fail deep inside an integration test.
 */
describe('GIFT_TRANSITIONS', () => {
  it('covers every status as a source', () => {
    for (const status of Object.values(GiftStatus)) {
      expect(GIFT_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('makes cancelled and completed terminal', () => {
    expect(GIFT_TRANSITIONS[GiftStatus.CANCELLED]).toEqual([]);
    expect(GIFT_TRANSITIONS[GiftStatus.COMPLETED]).toEqual([]);
  });

  it('allows the online path reserved → purchased → fulfilled → completed', () => {
    expect(GIFT_TRANSITIONS[GiftStatus.RESERVED]).toContain(GiftStatus.PURCHASED);
    expect(GIFT_TRANSITIONS[GiftStatus.PURCHASED]).toContain(GiftStatus.FULFILLED);
    expect(GIFT_TRANSITIONS[GiftStatus.FULFILLED]).toContain(GiftStatus.COMPLETED);
  });

  it('allows purchased → completed directly (offline gifts have no shipment)', () => {
    expect(GIFT_TRANSITIONS[GiftStatus.PURCHASED]).toContain(GiftStatus.COMPLETED);
  });

  it('allows cancellation from reserved and purchased, but not later', () => {
    expect(GIFT_TRANSITIONS[GiftStatus.RESERVED]).toContain(GiftStatus.CANCELLED);
    expect(GIFT_TRANSITIONS[GiftStatus.PURCHASED]).toContain(GiftStatus.CANCELLED);
    // Once fulfilled or completed, there is nothing to cancel — the gift landed.
    expect(GIFT_TRANSITIONS[GiftStatus.FULFILLED]).not.toContain(GiftStatus.CANCELLED);
  });

  it('never lets a gift move backwards', () => {
    const order = [
      GiftStatus.RESERVED,
      GiftStatus.PURCHASED,
      GiftStatus.FULFILLED,
      GiftStatus.COMPLETED,
    ];
    for (const [i, from] of order.entries()) {
      for (const to of GIFT_TRANSITIONS[from]) {
        if (to === GiftStatus.CANCELLED) continue; // cancel is sideways, not back
        expect(order.indexOf(to)).toBeGreaterThan(i);
      }
    }
  });
});
