import { GROUP_GIFT_TRANSITIONS, GroupGiftStatus } from './group-gift.types';

/**
 * The funding state machine as data, tested as data — the same treatment as
 * GIFT_TRANSITIONS. GroupGiftService reads this table and nothing else decides a
 * legal move, so pinning the table pins the machine.
 */
describe('GROUP_GIFT_TRANSITIONS', () => {
  it('covers every status as a source', () => {
    for (const status of Object.values(GroupGiftStatus)) {
      expect(GROUP_GIFT_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('makes cancelled and fulfilled terminal', () => {
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.CANCELLED]).toEqual([]);
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.FULFILLED]).toEqual([]);
  });

  it('allows the happy path open → funded → purchased → fulfilled', () => {
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.OPEN]).toContain(GroupGiftStatus.FUNDED);
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.FUNDED]).toContain(GroupGiftStatus.PURCHASED);
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.PURCHASED]).toContain(GroupGiftStatus.FULFILLED);
  });

  it('lets a cancellation with money pass through refunding to cancelled', () => {
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.OPEN]).toContain(GroupGiftStatus.REFUNDING);
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.FUNDED]).toContain(GroupGiftStatus.REFUNDING);
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.REFUNDING]).toContain(GroupGiftStatus.CANCELLED);
  });

  it('cannot cancel once purchased or fulfilled — the money is already spent', () => {
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.PURCHASED]).not.toContain(
      GroupGiftStatus.CANCELLED,
    );
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.FULFILLED]).not.toContain(
      GroupGiftStatus.CANCELLED,
    );
  });

  it('never accepts contributions after open — only OPEN funds forward, not the reverse', () => {
    // No status transitions *back* to OPEN except a failed purchase (purchasing).
    for (const from of Object.values(GroupGiftStatus)) {
      if (from === GroupGiftStatus.PURCHASING) continue;
      expect(GROUP_GIFT_TRANSITIONS[from]).not.toContain(GroupGiftStatus.OPEN);
    }
    expect(GROUP_GIFT_TRANSITIONS[GroupGiftStatus.PURCHASING]).toContain(GroupGiftStatus.FUNDED);
  });
});
