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

  it('returns nothing for nobody rather than dividing by zero, twice over', () => {
    expect(SettlementService.proportionalRefunds('host', new Map(), 500)).toEqual({
      members: [],
      hostKeptMinor: 0,
    });
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

/**
 * A split-equally gift's refunds: what each person paid above the share, the
 * host's part kept by the host.
 */
describe('SettlementService.equalRefunds', () => {
  const refunds = (paid: [string, number][], targetMinor: number, surplus: number) =>
    SettlementService.equalRefunds({
      hostId: 'host',
      others: paid.map(([id]) => id).filter((id) => id !== 'host'),
      paid: new Map(paid),
      targetMinor,
      surplus,
    });

  it('gives each person back what they paid over the new share', () => {
    // ₹3,000 among three after a ₹600 drop: shares ₹1,000, ₹200 over each.
    expect(
      refunds(
        [
          ['host', 1_200_00],
          ['a', 1_200_00],
          ['b', 1_200_00],
        ],
        3_000_00,
        600_00,
      ),
    ).toEqual({
      members: [
        { contributorId: 'a', amountMinor: 200_00 },
        { contributorId: 'b', amountMinor: 200_00 },
      ],
      hostKeptMinor: 200_00,
    });
  });

  it('never refunds the host to themselves', () => {
    const out = refunds(
      [
        ['host', 2_000_00],
        ['a', 1_000_00],
      ],
      2_000_00,
      1_000_00,
    );
    expect(out.members.map((m) => m.contributorId)).not.toContain('host');
  });

  it('shares a short surplus in proportion, not first come first served', () => {
    // a is ₹300 over, b ₹100 over, but only ₹200 is extra — somebody else still
    // owes. Three quarters to a, a quarter to b.
    expect(
      refunds(
        [
          ['host', 1_000_00],
          ['a', 1_300_00],
          ['b', 1_100_00],
          ['c', 800_00],
        ],
        4_000_00,
        200_00,
      ).members,
    ).toEqual([
      { contributorId: 'a', amountMinor: 150_00 },
      { contributorId: 'b', amountMinor: 50_00 },
    ]);
  });
});

/**
 * A price drop on a give-what-you-like gift: the extra goes back in
 * proportion to what each person put in, so nobody gets back more than they
 * gave, and the host keeps their own part.
 */
describe('SettlementService.proportionalRefunds', () => {
  const refunds = (paid: [string, number][], surplus: number) =>
    SettlementService.proportionalRefunds('host', new Map(paid), surplus);

  it('shares the extra by what each gave', () => {
    // ₹3,000 and ₹1,000 in, ₹400 extra: ₹300 and ₹100 back.
    expect(
      refunds(
        [
          ['a', 3_000_00],
          ['b', 1_000_00],
        ],
        400_00,
      ),
    ).toEqual({
      members: [
        { contributorId: 'a', amountMinor: 300_00 },
        { contributorId: 'b', amountMinor: 100_00 },
      ],
      hostKeptMinor: 0,
    });
  });

  it('the host keeps their own part rather than refunding themselves', () => {
    const out = refunds(
      [
        ['host', 1_000_00],
        ['a', 1_000_00],
      ],
      200_00,
    );
    expect(out.members).toEqual([{ contributorId: 'a', amountMinor: 100_00 }]);
    expect(out.hostKeptMinor).toBe(100_00);
  });

  it('never loses or invents a paisa', () => {
    const out = refunds(
      [
        ['a', 333],
        ['b', 333],
        ['c', 334],
      ],
      100,
    );
    const total = out.members.reduce((s, m) => s + m.amountMinor, 0) + out.hostKeptMinor;
    expect(total).toBe(100);
  });
});
