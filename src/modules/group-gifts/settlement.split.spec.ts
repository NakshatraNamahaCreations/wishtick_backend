import { SettlementService } from './settlement.service';

/**
 * The split, on its own.
 *
 * This is the one piece of arithmetic in the settle-up flow that silently
 * loses money if it is wrong, and the loss is small enough to go unnoticed
 * forever — which is exactly why it gets its own test.
 */
describe('SettlementService.splitEvenly', () => {
  const split = (amountMinor: number, count: number): number[] =>
    SettlementService.splitEvenly(amountMinor, count);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('divides an exact amount evenly', () => {
    expect(split(60_000, 6)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it('never loses a paisa to rounding', () => {
    // The design's own example: ₹2,000 across 6. ₹333.33 each rounds to ₹333,
    // and six of those return ₹1,998 — leaving ₹2 the host still owes and
    // nobody is tracking.
    const shares = split(200_000, 6);
    expect(sum(shares)).toBe(200_000);
    expect(shares).toEqual([33_334, 33_334, 33_333, 33_333, 33_333, 33_333]);
  });

  it('puts the remainder on the earliest contributors, not at random', () => {
    const shares = split(100, 3);
    expect(sum(shares)).toBe(100);
    // Someone has to absorb the extra paise; being deterministic about who
    // means two runs of the same split never disagree.
    expect(shares).toEqual([34, 33, 33]);
  });

  it('gives everything to a single contributor', () => {
    expect(split(777, 1)).toEqual([777]);
  });

  it('survives more people than paise', () => {
    const shares = split(2, 5);
    expect(sum(shares)).toBe(2);
    // Three people are owed nothing; the caller drops zero-value rows rather
    // than raising a settlement for ₹0.
    expect(shares).toEqual([1, 1, 0, 0, 0]);
  });

  it('returns nothing for nobody rather than dividing by zero', () => {
    expect(split(1_000, 0)).toEqual([]);
  });

  it('holds for arbitrary amounts and group sizes', () => {
    for (let amount = 1; amount <= 500; amount += 7) {
      for (let people = 1; people <= 9; people++) {
        const shares = split(amount, people);
        expect(sum(shares)).toBe(amount);
        // No share may exceed another by more than one paisa, or the "split
        // equally" label on `4093:444` would be a lie.
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      }
    }
  });
});
