import { RELEASE_NOTES_MAX, PlayStoreClient } from './play-store.client';

describe('PlayStoreClient.versionName', () => {
  it('reads Play\'s own release name, "3 (1.0.2)"', () => {
    expect(PlayStoreClient.versionName('3 (1.0.2)')).toBe('1.0.2');
  });

  it('takes a release renamed to the bare version', () => {
    expect(PlayStoreClient.versionName('1.0.2')).toBe('1.0.2');
  });

  it('gives up on anything else', () => {
    expect(PlayStoreClient.versionName('Diwali release')).toBeNull();
    expect(PlayStoreClient.versionName(undefined)).toBeNull();
  });
});

describe('PlayStoreClient.notes', () => {
  it('prefers US English, then Indian English', () => {
    expect(
      PlayStoreClient.notes([
        { language: 'hi-IN', text: 'नया' },
        { language: 'en-IN', text: 'India' },
        { language: 'en-US', text: 'US' },
      ]),
    ).toBe('US');
    expect(
      PlayStoreClient.notes([
        { language: 'hi-IN', text: 'नया' },
        { language: 'en-IN', text: 'India' },
      ]),
    ).toBe('India');
  });

  it('falls back to any language, and to none', () => {
    expect(PlayStoreClient.notes([{ language: 'hi-IN', text: 'नया' }])).toBe('नया');
    expect(PlayStoreClient.notes([{ language: 'en-US', text: '  ' }])).toBeNull();
    expect(PlayStoreClient.notes(undefined)).toBeNull();
  });

  it("is cut to Play's own limit", () => {
    expect(PlayStoreClient.notes([{ language: 'en-US', text: 'x'.repeat(900) }])).toHaveLength(
      RELEASE_NOTES_MAX,
    );
  });
});
