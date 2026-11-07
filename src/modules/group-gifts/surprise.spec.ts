import { EventStatus } from 'src/modules/events/event.types';
import { GroupGiftStatus } from './group-gift.types';
import { surpriseIsOver, type SurpriseEvent } from './surprise';

/**
 * When the person a group gift is for may see it. One rule, read by the
 * gift's own screens and by its chat, so it is pinned here once.
 */
describe('surpriseIsOver', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');
  const party = (over: Partial<SurpriseEvent> = {}): SurpriseEvent => ({
    startsAt: new Date('2026-11-06T18:00:00.000Z'),
    endsAt: null,
    status: EventStatus.PUBLISHED,
    ...over,
  });
  const gift = (status = GroupGiftStatus.OPEN, eventId: unknown = 'ev') => ({ status, eventId });

  it('is never over for a gift on no event', () => {
    expect(surpriseIsOver(gift(GroupGiftStatus.OPEN, null), null, now)).toBe(false);
    expect(surpriseIsOver(gift(GroupGiftStatus.PURCHASED, null), null, now)).toBe(false);
  });

  it('is over once the gift has been delivered, event or not', () => {
    expect(surpriseIsOver(gift(GroupGiftStatus.FULFILLED, null), null, now)).toBe(true);
    expect(surpriseIsOver(gift(GroupGiftStatus.FULFILLED), party(), now)).toBe(true);
  });

  it('is over a day after a party with no end time started', () => {
    expect(surpriseIsOver(gift(), party(), now)).toBe(false);
    const dayLater = new Date('2026-11-07T18:00:00.000Z');
    expect(surpriseIsOver(gift(), party(), dayLater)).toBe(true);
  });

  it('is over once a party with an end time has ended', () => {
    const ended = party({ endsAt: new Date('2026-11-07T11:00:00.000Z') });
    expect(surpriseIsOver(gift(), ended, now)).toBe(true);
    const running = party({ endsAt: new Date('2026-11-07T13:00:00.000Z') });
    expect(surpriseIsOver(gift(), running, now)).toBe(false);
  });

  it('is over when the party was called off', () => {
    const cancelled = party({
      startsAt: new Date('2026-12-01T18:00:00.000Z'),
      status: EventStatus.CANCELLED,
    });
    expect(surpriseIsOver(gift(), cancelled, now)).toBe(true);
  });

  it('stays hidden when the event the gift names cannot be found', () => {
    expect(surpriseIsOver(gift(), null, now)).toBe(false);
  });
});
