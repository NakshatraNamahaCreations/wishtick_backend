import { STORE_URL_PATTERN, updateStatusFor } from './app-version.types';

describe('updateStatusFor', () => {
  it('offers nothing when no policy has been set', () => {
    expect(updateStatusFor(1, { latestVersionCode: 0, minVersionCode: 0 })).toBe('ok');
  });

  it('offers the newer build to anyone below it', () => {
    const policy = { latestVersionCode: 5, minVersionCode: 0 };
    expect(updateStatusFor(4, policy)).toBe('optional');
    expect(updateStatusFor(1, policy)).toBe('optional');
    expect(updateStatusFor(5, policy)).toBe('ok');
  });

  it('a build newer than the store (in testing) is left alone', () => {
    expect(updateStatusFor(6, { latestVersionCode: 5, minVersionCode: 5 })).toBe('ok');
  });

  it('forces only the builds below the minimum', () => {
    // 1.0.2 (build 3) is forced; later releases are offered, not forced.
    const policy = { latestVersionCode: 5, minVersionCode: 3 };
    expect(updateStatusFor(2, policy)).toBe('required');
    expect(updateStatusFor(3, policy)).toBe('optional');
    expect(updateStatusFor(4, policy)).toBe('optional');
    expect(updateStatusFor(5, policy)).toBe('ok');
  });
});

describe('STORE_URL_PATTERN', () => {
  it('takes the store listings', () => {
    expect(
      STORE_URL_PATTERN.test('https://play.google.com/store/apps/details?id=com.wishtick.wishtick'),
    ).toBe(true);
    expect(STORE_URL_PATTERN.test('https://apps.apple.com/in/app/wishtick/id123')).toBe(true);
  });

  it('refuses anywhere else', () => {
    expect(STORE_URL_PATTERN.test('https://evil.example.com/wishtick.apk')).toBe(false);
    expect(STORE_URL_PATTERN.test('http://play.google.com/store/apps/details?id=x')).toBe(false);
  });
});
