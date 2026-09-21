import { shareablePreferences } from './taste.service';

/**
 * What of somebody's taste may reach anybody else.
 *
 * The filter runs before anything is built, so these are the whole of the
 * rule: every hidden group comes out empty for others, nothing is hidden from
 * the owner, and what was not switched off is untouched.
 */
const everything = {
  interests: ['tech_audio_devices'],
  interestCategories: ['technology'],
  giftCategories: ['electronics'],
  customInterests: ['Vinyl records'],
  favouriteColors: ['blue_navy'],
  clothingSize: 'xl',
  shoeSize: 'uk_9',
  fitPreference: 'relaxed',
  lifestyle: ['practical'],
  occasions: ['birthday'],
};

describe('what others may be shown, and shopped by', () => {
  it('everything, when nothing is switched off', () => {
    expect(shareablePreferences(everything, 'others')).toEqual(everything);
  });

  it('hidden interests take their categories with them', () => {
    const shared = shareablePreferences(
      { ...everything, shareInterests: false } as never,
      'others',
    );
    expect(shared.interests).toEqual([]);
    expect(shared.interestCategories).toEqual([]);
    expect(shared.giftCategories).toEqual([]);
    expect(shared.favouriteColors).toEqual(['blue_navy']);
  });

  it.each([
    ['shareCustomInterests', { customInterests: [] }],
    ['shareColours', { favouriteColors: [] }],
    ['shareSizes', { clothingSize: null, shoeSize: null, fitPreference: null }],
  ])('%s off empties only its own group', (flag, emptied) => {
    const shared = shareablePreferences({ ...everything, [flag]: false }, 'others');
    expect(shared).toEqual({ ...everything, ...emptied });
  });

  it('the owner always sees all of it', () => {
    const hidden = {
      ...everything,
      shareInterests: false,
      shareCustomInterests: false,
      shareColours: false,
      shareSizes: false,
    };
    const own = shareablePreferences(hidden, 'self');
    expect(own.interests).toEqual(everything.interests);
    expect(own.clothingSize).toBe('xl');
  });

  it('never carries the switches themselves onward', () => {
    const shared = shareablePreferences({ ...everything, shareColours: false } as never, 'others');
    expect(shared).not.toHaveProperty('shareColours');
  });
});
