import { formatEventMoment } from './zoned';

describe('formatEventMoment', () => {
  // 13:30 UTC is 7:00 PM in Kolkata and 9:30 AM in New York.
  const at = new Date('2026-10-24T13:30:00Z');

  it('reads on the wall clock of the event, not the server', () => {
    expect(formatEventMoment(at, 'Asia/Kolkata')).toBe('Sat, 24 Oct · 7:00 PM');
    expect(formatEventMoment(at, 'America/New_York')).toBe('Sat, 24 Oct · 9:30 AM');
  });

  it('crosses midnight into the next day where the zone does', () => {
    expect(formatEventMoment(new Date('2026-10-24T20:00:00Z'), 'Asia/Kolkata')).toBe(
      'Sun, 25 Oct · 1:30 AM',
    );
  });

  it('falls back to UTC rather than throwing on a zone it does not know', () => {
    expect(formatEventMoment(at, 'Not/AZone')).toBe('Sat, 24 Oct · 1:30 PM');
  });
});
