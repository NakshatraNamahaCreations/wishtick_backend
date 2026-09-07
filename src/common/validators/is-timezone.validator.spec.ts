import { isValidTimezone } from './is-timezone.validator';

describe('isValidTimezone', () => {
  /**
   * The regression this guards.
   *
   * An earlier version validated against `Intl.supportedValuesOf('timeZone')`.
   * That list is one ICU build's set of canonical names, and on this runtime it
   * omits Asia/Kolkata, Europe/Kyiv, and Asia/Ho_Chi_Minh while including their
   * legacy aliases. Browsers report the modern spelling, so an allowlist built
   * from that list 400s onboarding for every user in India — the product's
   * primary market — and the exact set changes with the bundled ICU version.
   */
  it.each([
    'Asia/Kolkata',
    'Asia/Calcutta',
    'Europe/Kyiv',
    'Europe/Kiev',
    'Asia/Ho_Chi_Minh',
    'Asia/Saigon',
    'America/New_York',
    'Pacific/Kiritimati',
    'UTC',
  ])('accepts %s', (tz) => {
    expect(isValidTimezone(tz)).toBe(true);
  });

  it('accepts modern names this ICU build omits from supportedValuesOf', () => {
    // Pins the exact discrepancy: valid to use, absent from the list.
    const listed = Intl.supportedValuesOf('timeZone');
    const modernButUnlisted = ['Asia/Kolkata', 'Europe/Kyiv'].filter((tz) => !listed.includes(tz));

    // If a future ICU lists them, this assertion is simply vacuous — the
    // it.each above still guarantees they are accepted.
    for (const tz of modernButUnlisted) {
      expect(isValidTimezone(tz)).toBe(true);
    }
  });

  it.each(['Mars/Olympus_Mons', 'Not/A_Zone', 'Asia', '', '   '])('rejects %s', (tz) => {
    expect(isValidTimezone(tz)).toBe(false);
  });

  it.each([null, undefined, 42, {}, []])('rejects the non-string %p', (value) => {
    expect(isValidTimezone(value)).toBe(false);
  });
});
