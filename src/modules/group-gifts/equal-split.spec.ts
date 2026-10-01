import { equalSplit, hostShareOf } from './equal-split';

/**
 * ₹1,000 among five, host included: ₹200 each, and the host already counted
 * as paid — the example the rules were given in.
 */
const TARGET = 100_000;
const people = (...paid: number[]) => paid.map((paidMinor, i) => ({ userId: `u${i}`, paidMinor }));
const owes = (split: ReturnType<typeof equalSplit>) => split.others.map((m) => m.owesMinor);

describe('an equal split', () => {
  it('shares the total five ways, with the host paid from the start', () => {
    const split = equalSplit({
      targetMinor: TARGET,
      hostId: 'host',
      hostPaidMinor: hostShareOf(TARGET, 5),
      others: people(0, 0, 0, 0),
    });

    expect(split.memberCount).toBe(5);
    expect(split.baseShareMinor).toBe(20_000);
    expect(split.host.paidMinor).toBe(20_000);
    expect(split.host.owesMinor).toBe(0);
    expect(owes(split)).toEqual([20_000, 20_000, 20_000, 20_000]);
  });

  it('shares what is left again when somebody pays more', () => {
    // ₹400 from one: ₹400 left for three, ₹133.34 each.
    const split = equalSplit({
      targetMinor: TARGET,
      hostId: 'host',
      hostPaidMinor: 20_000,
      others: people(40_000, 0, 0, 0),
    });

    expect(owes(split)).toEqual([0, 13_334, 13_334, 13_334]);
  });

  it('keeps asking somebody who paid less for the rest', () => {
    const split = equalSplit({
      targetMinor: TARGET,
      hostId: 'host',
      hostPaidMinor: 20_000,
      others: people(10_000, 0, 0, 0),
    });

    // Still ₹200 each; ₹100 of it already in from the first.
    expect(owes(split)).toEqual([10_000, 20_000, 20_000, 20_000]);
  });

  it('counts somebody as done once the others have come down to what they paid', () => {
    // ₹400 and ₹150 in: ₹133.34 each would leave the ₹150 overpaid, so it is
    // done too, and the last two share ₹250 — ₹125 each.
    const split = equalSplit({
      targetMinor: TARGET,
      hostId: 'host',
      hostPaidMinor: 20_000,
      others: people(40_000, 15_000, 0, 0),
    });

    expect(owes(split)).toEqual([0, 0, 12_500, 12_500]);
  });

  it('asks nobody for anything once the total is in', () => {
    const split = equalSplit({
      targetMinor: TARGET,
      hostId: 'host',
      hostPaidMinor: 20_000,
      others: people(20_000, 20_000, 20_000, 20_000),
    });

    expect(owes(split)).toEqual([0, 0, 0, 0]);
  });

  it('gives the host the paise that do not divide', () => {
    // ₹1,000 among three: ₹333.33 each, the odd paisa the host's.
    expect(hostShareOf(TARGET, 3)).toBe(33_334);
  });

  it('has no split, and nothing for the host, with nobody else in it', () => {
    expect(hostShareOf(TARGET, 1)).toBe(0);
  });
});
