import type { NormalizedProduct } from '../products/product.types';
import { EMPTY_TASTE, type TasteProfile } from '../taste/taste.types';
import {
  budgetSignal,
  colourSearchWord,
  GENDERED_SHELVES,
  genderSearchPhrase,
  MAX_PER_MERCHANT,
  qualitySignal,
  rankForTaste,
  searchableColour,
  typedIsGendered,
  typedSaysGender,
  type RetrievedRow,
} from './suggestion.scoring';

/**
 * Ranking a shelf for one person, over what a Google Shopping row actually
 * carries: a title, a price, sometimes a rating, a merchant. No colour, no
 * size, no brand. Every rule below is about not pretending otherwise.
 */

let nextId = 0;
function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  nextId += 1;
  return {
    provider: 'fixture',
    externalId: `p_${nextId}`,
    title: 'A plain gift',
    description: null,
    imageUrls: [],
    productUrl: 'https://example.com',
    affiliateUrl: null,
    amountMinor: 150_000,
    listPriceMinor: null,
    currency: 'INR',
    merchant: `Shop ${nextId}`,
    category: 'home',
    inStock: true,
    rating: null,
    reviewCount: null,
    deliveryNote: null,
    brand: null,
    features: [],
    offers: [],
    affiliateMeta: {},
    ...overrides,
  };
}

const row = (p: NormalizedProduct, foundIn = [0]): RetrievedRow => ({ product: p, foundIn });

function taste(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return {
    ...EMPTY_TASTE,
    budget: { minMinor: null, maxMinor: 200_000, source: 'default' },
    ...overrides,
  };
}

const likes = (...terms: string[]): Partial<TasteProfile> => ({
  tokens: terms.map((term) => ({
    term,
    weight: 1,
    source: 'interest' as const,
    key: `k_${term}`,
    label: term[0].toUpperCase() + term.slice(1),
  })),
});

const rankedTitles = (rows: RetrievedRow[], profile: TasteProfile, limit = 20) =>
  rankForTaste(rows, profile, { limit }).map((s) => s.product.title);

describe('matching an interest', () => {
  it('ranks a title that names it above one that does not', () => {
    const ranked = rankedTitles(
      [row(product({ title: 'Ceramic Vase' })), row(product({ title: 'Running Shoes' }))],
      taste(likes('shoes')),
    );

    expect(ranked[0]).toBe('Running Shoes');
  });

  it('matches whole words only', () => {
    // `art` must not find "Cartridge"; `tea` must not find "Steam Iron".
    const [cartridge] = rankForTaste(
      [row(product({ title: 'Ink Cartridge Pack' }))],
      taste(likes('art')),
      { limit: 1 },
    );
    const [iron] = rankForTaste([row(product({ title: 'Steam Iron' }))], taste(likes('tea')), {
      limit: 1,
    });

    expect(cartridge.signals.interest).toBe(0);
    expect(iron.signals.interest).toBe(0);
  });

  it('matches a singular interest against a plural title', () => {
    const [scored] = rankForTaste(
      [row(product({ title: 'Leather Wallets for Men' }))],
      taste(likes('wallet')),
      { limit: 1 },
    );

    expect(scored.signals.interest).toBeGreaterThan(0);
  });

  it('matches a phrase only as a phrase', () => {
    const [together] = rankForTaste(
      [row(product({ title: 'Smart Home Speaker' }))],
      taste(likes('smart home')),
      { limit: 1 },
    );
    const [apart] = rankForTaste(
      [row(product({ title: 'Smart Watch for Home' }))],
      taste(likes('smart home')),
      { limit: 1 },
    );

    expect(together.signals.interest).toBeGreaterThan(0);
    expect(apart.signals.interest).toBe(0);
  });

  it('says which interest it matched', () => {
    const [scored] = rankForTaste(
      [row(product({ title: 'Trail Running Shoes' }))],
      taste(likes('shoes')),
      { limit: 1 },
    );

    expect(scored.reasons).toContain('Likes Shoes');
  });

  it('saturates, so five weak matches do not beat one strong one by five', () => {
    const [many] = rankForTaste(
      [row(product({ title: 'a b c d e' }))],
      taste(likes('a', 'b', 'c', 'd', 'e')),
      { limit: 1 },
    );

    expect(many.signals.interest).toBeLessThan(1);
  });
});

describe('colour', () => {
  const plum = {
    colours: [
      { key: 'purple_plum', word: 'plum', groupWord: 'purple', hex: '#5B1A6E', label: 'Plum' },
    ],
  };
  const rose = {
    colours: [{ key: 'red_rose', word: 'rose', groupWord: 'red', hex: '#E0115F', label: 'Rose' }],
  };
  const mint = {
    colours: [
      { key: 'green_mint', word: 'mint', groupWord: 'green', hex: '#98FF98', label: 'Mint' },
    ],
  };
  const navy = {
    colours: [{ key: 'blue_navy', word: 'navy', groupWord: 'blue', hex: '#1B2A5B', label: 'Navy' }],
  };

  const colourOf = (title: string, profile: Partial<TasteProfile>) =>
    rankForTaste([row(product({ title }))], taste(profile), { limit: 1 })[0].signals.colour;

  it('fires on a colour word that cannot mean anything else', () => {
    expect(colourOf('Navy Blue Backpack', navy)).toBeGreaterThan(0);
  });

  it('does not fire on a colour that is also a product', () => {
    // The palette is full of these, and every one of them is a real listing.
    expect(colourOf('Rose Gold Watch', rose)).toBe(0);
    expect(colourOf('Mint Condition Vinyl', mint)).toBe(0);
    expect(colourOf('Plum Jam Gift Box', plum)).toBe(0);
  });

  it('does fire on that same word when the title says it is a colour', () => {
    expect(colourOf('Plum Colour Handbag', plum)).toBeGreaterThan(0);
  });

  it('fires on the colour family, which is never ambiguous', () => {
    expect(colourOf('Purple Silk Scarf', plum)).toBeGreaterThan(0);
  });

  it('is a bonus, never a penalty', () => {
    // A title that names no colour says nothing about the product's colour.
    const [withColour, without] = rankForTaste(
      [
        row(product({ title: 'Purple Silk Scarf', externalId: 'a' })),
        row(product({ title: 'Silk Scarf', externalId: 'b' })),
      ],
      taste(plum),
      { limit: 2 },
    );

    expect(without.score).toBeGreaterThan(0);
    expect(withColour.score).toBeGreaterThan(without.score);
  });
});

describe('size', () => {
  const sizeOf = (title: string, sizes: TasteProfile['sizes']) =>
    rankForTaste([row(product({ title }))], taste({ sizes }), { limit: 1 })[0].signals.size;
  const reasonsFor = (title: string, sizes: TasteProfile['sizes']) =>
    rankForTaste([row(product({ title }))], taste({ sizes }), { limit: 1 })[0].reasons;
  const none = { clothing: null, shoe: null, fit: null };

  it('never matches a bare S, M or L', () => {
    expect(sizeOf('L-Shaped Study Desk', { ...none, clothing: 'L' })).toBe(0);
    expect(sizeOf('M 2 SSD Drive', { ...none, clothing: 'M' })).toBe(0);
  });

  it('matches S, M or L after the word "size"', () => {
    expect(sizeOf('Cotton Tee Size M', { ...none, clothing: 'M' })).toBe(1);
  });

  it('matches an unambiguous size on its own', () => {
    expect(sizeOf('Oversized XL Hoodie', { ...none, clothing: 'XL' })).toBe(1);
  });

  it('matches a shoe size with its system', () => {
    expect(sizeOf('Running Shoes UK 9', { ...none, shoe: { system: 'uk', label: 'UK 9' } })).toBe(
      1,
    );
    // The same number in another system is a different shoe.
    expect(sizeOf('Running Shoes US 9', { ...none, shoe: { system: 'uk', label: 'UK 9' } })).toBe(
      0,
    );
  });

  it('matches a fit as a word', () => {
    expect(sizeOf('Relaxed Fit Chinos', { ...none, fit: 'Relaxed' })).toBe(1);
  });

  it('says what it matched, naming the size rather than claiming a fit', () => {
    // "Their size (XL)" is about the listing's words. "In their size" would be
    // a claim about the product, which a title of a seller's whole size run
    // does not support.
    expect(reasonsFor('Oversized XL Hoodie', { ...none, clothing: 'XL' })).toContain(
      'Their size (XL)',
    );
    expect(reasonsFor('Relaxed Fit Chinos', { ...none, fit: 'Relaxed' })).toContain(
      'Their fit (Relaxed)',
    );
    expect(
      reasonsFor('Running Shoes UK 9', { ...none, shoe: { system: 'UK', label: '9' } }),
    ).toContain('Their shoe size (UK 9)');
  });

  it('says nothing when nothing matched', () => {
    expect(reasonsFor('Cotton Tee', { ...none, clothing: 'XL' })).toEqual([]);
  });
});

describe('a colour worth searching with', () => {
  const plum = { key: 'purple_plum', word: 'plum', groupWord: 'purple', hex: null, label: 'Plum' };
  const teal = { key: 'green_teal', word: 'teal', groupWord: null, hex: null, label: 'Teal' };
  const rose = { key: 'red_rose', word: 'rose', groupWord: null, hex: null, label: 'Rose' };

  it('prefers the family word, which merchants actually use', () => {
    const colour = searchableColour([plum]);
    expect(colour).not.toBeNull();
    expect(colourSearchWord(colour!)).toBe('purple');
  });

  it('takes the shade itself when it has no family to fall back on', () => {
    expect(colourSearchWord(searchableColour([teal])!)).toBe('teal');
  });

  it('refuses a word that is also a product', () => {
    // "rose backpack" is a search for flowers.
    expect(searchableColour([rose])).toBeNull();
  });

  it('is nothing for somebody who named no colour', () => {
    expect(searchableColour([])).toBeNull();
  });
});

describe('budget', () => {
  it('is full marks inside the band', () => {
    expect(budgetSignal(150_000, null, 200_000)).toBe(1);
  });

  it('falls away over the ceiling, to nothing at twice it', () => {
    expect(budgetSignal(250_000, null, 200_000)).toBeLessThan(1);
    expect(budgetSignal(400_000, null, 200_000)).toBe(0);
  });

  it('is kinder to cheap than to dear', () => {
    // Nobody minds a present that cost less than it might have.
    const under = budgetSignal(50_000, 100_000, 200_000);
    const over = budgetSignal(300_000, 100_000, 200_000);

    expect(under).toBeGreaterThan(over);
  });

  it('never zeroes a gift for being far under budget', () => {
    // Well below the floor is still a perfectly good gift — half marks, not
    // none. Only going over is ruinous.
    expect(budgetSignal(10_000, 100_000, 200_000)).toBe(0.5);
  });

  it('gives an unpriced row a neutral score, not zero', () => {
    expect(budgetSignal(null, null, 200_000)).toBeGreaterThan(0);
  });
});

describe('whose budget it is', () => {
  const cheapUnmatched = () => row(product({ title: 'Wireless Earbuds', amountMinor: 79_900 }));
  const dearMatched = () => row(product({ title: 'Smart Speaker', amountMinor: 349_900 }));
  const smart = {
    tokens: [
      {
        term: 'smart',
        weight: 0.5,
        source: 'interest' as const,
        key: 'tech_smart_home',
        label: 'Smart Home',
      },
    ],
  };

  it('a default ceiling does not outrank what they said they like', () => {
    // Found end to end: an unmatched ₹799 gift led the shelf over the only
    // product matching the person's interest, on a ₹2,000 limit nobody set.
    const [first] = rankForTaste(
      [cheapUnmatched(), dearMatched()],
      taste({ ...smart, budget: { minMinor: null, maxMinor: 200_000, source: 'default' } }),
      { limit: 2 },
    );

    expect(first.product.title).toBe('Smart Speaker');
  });

  it('a ceiling somebody asked for still counts in full', () => {
    const [first] = rankForTaste(
      [cheapUnmatched(), dearMatched()],
      taste({ ...smart, budget: { minMinor: null, maxMinor: 200_000, source: 'explicit' } }),
      { limit: 2 },
    );

    expect(first.product.title).toBe('Wireless Earbuds');
  });

  it('only a budget somebody set becomes a reason', () => {
    const [inferred] = rankForTaste(
      [cheapUnmatched()],
      taste({ budget: { minMinor: null, maxMinor: 200_000, source: 'default' } }),
      { limit: 1 },
    );
    const [asked] = rankForTaste(
      [cheapUnmatched()],
      taste({ budget: { minMinor: null, maxMinor: 200_000, source: 'explicit' } }),
      { limit: 1 },
    );

    expect(inferred.reasons.join(' ')).not.toContain('Within');
    expect(asked.reasons).toContain('Within ₹2,000');
  });
});

describe('quality', () => {
  it('trusts many reviews over a perfect few', () => {
    expect(qualitySignal(4.4, 9000)).toBeGreaterThan(qualitySignal(4.9, 2));
  });

  it('does not sink a product that simply has no rating', () => {
    // Google omits ratings on most rows.
    expect(qualitySignal(null, null)).toBeGreaterThan(qualitySignal(3.1, 500));
  });
});

describe('the shelf that comes back', () => {
  it('holds at most two from one merchant', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row(product({ title: `Distinct item ${i} ${'x'.repeat(i)}`, merchant: 'MegaStore' })),
    );

    const shelf = rankForTaste(rows, taste(), { limit: 10 });

    expect(shelf.filter((s) => s.product.merchant === 'MegaStore')).toHaveLength(MAX_PER_MERCHANT);
  });

  it('collapses the same product sold under two names', () => {
    const shelf = rankForTaste(
      [
        row(product({ title: 'Boat Rockerz 450 Wireless Headphones' })),
        row(product({ title: 'boAt Rockerz 450 Wireless Headphones!' })),
        row(product({ title: 'Ceramic Coffee Mug' })),
      ],
      taste(),
      { limit: 10 },
    );

    expect(shelf).toHaveLength(2);
  });

  it('ranks what two shelves both turned up higher', () => {
    const [both, one] = rankForTaste(
      [
        row(product({ title: 'Item one', externalId: 'one' }), [1]),
        row(product({ title: 'Item two', externalId: 'two' }), [1, 2]),
      ],
      taste(),
      { limit: 2 },
    );

    expect(both.product.externalId).toBe('two');
    expect(one.product.externalId).toBe('one');
  });

  it('pushes a known-unavailable product to the back', () => {
    const [first] = rankForTaste(
      [
        row(product({ title: 'Running Shoes', inStock: false })),
        row(product({ title: 'Ceramic Vase' })),
      ],
      taste(likes('shoes')),
      { limit: 2 },
    );

    expect(first.product.title).toBe('Ceramic Vase');
  });

  it('comes back in the same order every time', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row(product({ title: `Same score ${i}`, externalId: `id_${i}` })),
    );

    const first = rankForTaste(rows, taste(), { limit: 12 }).map((s) => s.product.externalId);
    const second = rankForTaste([...rows].reverse(), taste(), { limit: 12 }).map(
      (s) => s.product.externalId,
    );

    expect(second).toEqual(first);
  });

  it('respects the limit', () => {
    // Genuinely different products — near-identical titles would be collapsed
    // as one product, which is a different rule.
    const nouns = [
      'Vase',
      'Headphones',
      'Scarf',
      'Notebook',
      'Candle',
      'Wallet',
      'Kettle',
      'Novel',
      'Backpack',
      'Watch',
      'Blanket',
      'Speaker',
      'Lamp',
      'Mug',
      'Planter',
      'Perfume',
      'Sneakers',
      'Camera',
      'Puzzle',
      'Teapot',
    ];
    const rows = nouns.map((noun) => row(product({ title: noun })));

    expect(rankForTaste(rows, taste(), { limit: 12 })).toHaveLength(12);
  });

  it('gives at most two reasons', () => {
    const [scored] = rankForTaste(
      [row(product({ title: 'Purple Running Shoes', rating: 4.8, reviewCount: 5000 }))],
      taste({
        ...likes('shoes'),
        colours: [
          { key: 'purple_plum', word: 'plum', groupWord: 'purple', hex: null, label: 'Plum' },
        ],
      }),
      { limit: 1 },
    );

    expect(scored.reasons.length).toBeLessThanOrEqual(2);
  });
});

describe('reordering one page of a search', () => {
  it('drops nothing, however alike the rows are', () => {
    // A page that comes back short reads as the end of the results.
    const rows = Array.from({ length: 6 }, (_, i) =>
      row(product({ title: 'Same Product', merchant: 'MegaStore', externalId: `dup_${i}` })),
    );

    const page = rankForTaste(rows, taste(), { limit: rows.length, diverse: false });

    expect(page).toHaveLength(6);
  });

  it('still puts what they like first', () => {
    const page = rankForTaste(
      [row(product({ title: 'Ceramic Vase' })), row(product({ title: 'Running Shoes' }))],
      taste(likes('shoes')),
      { limit: 2, diverse: false },
    );

    expect(page[0].product.title).toBe('Running Shoes');
  });
});

describe('gender', () => {
  const ranked = (titles: string[], gender: TasteProfile['gender']) =>
    rankForTaste(
      titles.map((title, i) => row(product({ title, externalId: `g${i}` }))),
      taste({ gender }),
      { limit: titles.length, diverse: false },
    ).map((s) => s.product.title);

  it('puts what is made for them ahead of what is made for others', () => {
    expect(ranked(["Men's Leather Wallet", "Women's Leather Wallet"], 'female')[0]).toBe(
      "Women's Leather Wallet",
    );
    expect(ranked(["Women's Leather Wallet", "Men's Leather Wallet"], 'male')[0]).toBe(
      "Men's Leather Wallet",
    );
  });

  it('never reads "women" as "men"', () => {
    // Whole words: the male signal must not fire inside "women".
    expect(ranked(['Watch for Women', 'Plain Watch'], 'male')[0]).toBe('Plain Watch');
  });

  it('pushes the other section down without taking it off the page', () => {
    const titles = ranked(['Watch for Men', 'Plain Watch'], 'female');
    expect(titles).toEqual(['Plain Watch', 'Watch for Men']);
  });

  it('treats unisex, and both at once, as for anybody', () => {
    const [a, b] = rankForTaste(
      [
        row(product({ title: 'Unisex Hoodie for Men and Women', externalId: 'u1' })),
        row(product({ title: 'Plain Hoodie', externalId: 'u2' })),
      ],
      taste({ gender: 'female' }),
      { limit: 2, diverse: false },
    );
    expect(a.signals.gender).toBe(0);
    expect(b.signals.gender).toBe(0);
  });

  it('reads "for her" and "for him" as phrases', () => {
    const [top] = rankForTaste(
      [row(product({ title: 'Perfect Gift for Her' }))],
      taste({ gender: 'female' }),
      { limit: 1 },
    );
    expect(top.signals.gender).toBe(1);
  });

  it('does nothing without a known gender', () => {
    const [top] = rankForTaste([row(product({ title: "Men's Watch" }))], taste({ gender: null }), {
      limit: 1,
    });
    expect(top.signals.gender).toBe(0);
  });

  it('is never a reason — the app is not told', () => {
    const [top] = rankForTaste(
      [row(product({ title: "Women's Watch" }))],
      taste({ gender: 'female' }),
      { limit: 1 },
    );
    expect(top.reasons.join(' ')).not.toMatch(/women|female|her/i);
  });
});

describe('asking for their section of the shop', () => {
  it('names the section only for a known gender', () => {
    expect(genderSearchPhrase('female')).toBe('for women');
    expect(genderSearchPhrase('male')).toBe('for men');
    expect(genderSearchPhrase(null)).toBeNull();
  });

  it('only for things shops sell by gender', () => {
    expect(typedIsGendered('smart watch')).toBe(true);
    expect(typedIsGendered('Graphic T-Shirt')).toBe(true);
    expect(typedIsGendered('coffee maker')).toBe(false);
    expect(GENDERED_SHELVES.has('fashion')).toBe(true);
    expect(GENDERED_SHELVES.has('electronics')).toBe(false);
  });

  it('not when the words already say who it is for', () => {
    expect(typedSaysGender('watch for women')).toBe(true);
    expect(typedSaysGender("men's wallet")).toBe(true);
    expect(typedSaysGender('unisex hoodie')).toBe(true);
    expect(typedSaysGender('watch')).toBe(false);
  });
});
