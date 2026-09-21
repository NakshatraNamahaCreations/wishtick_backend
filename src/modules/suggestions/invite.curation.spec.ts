import { EventType } from '../events/event.types';
import { OCCASION_CATEGORIES } from '../discover/discover.curation';
import { inviteShelfTitle, occasionForEventType } from './invite.curation';

describe('what an invitation says about the gift', () => {
  it('every event type is accounted for, and each occasion is one the curation knows', () => {
    for (const type of Object.values(EventType)) {
      const occasion = occasionForEventType(type);
      if (occasion !== null) expect(OCCASION_CATEGORIES).toHaveProperty(occasion);
    }
  });

  it('a generic party suggests nothing on its own', () => {
    expect(occasionForEventType(EventType.GENERIC)).toBeNull();
    expect(occasionForEventType('something_new')).toBeNull();
  });

  it('names the person when the invitation does, and nobody when it does not', () => {
    expect(inviteShelfTitle('Siya')).toBe('Gift ideas for Siya');
    expect(inviteShelfTitle('  ')).toBe('Gift ideas for the celebration');
    expect(inviteShelfTitle(null)).toBe('Gift ideas for the celebration');
  });
});
