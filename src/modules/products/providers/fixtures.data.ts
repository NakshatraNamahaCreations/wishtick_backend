import type { NormalizedProduct } from '../product.types';

const p = (
  externalId: string,
  title: string,
  amountMinor: number | null,
  category: string,
  merchant: string,
  extra: Partial<NormalizedProduct> = {},
): NormalizedProduct => ({
  provider: 'fixture',
  externalId,
  title,
  description: `${title} — sample catalogue entry.`,
  imageUrls: [`https://cdn.example.test/products/${externalId}.jpg`],
  productUrl: `https://shop.example.test/p/${externalId}`,
  affiliateUrl: `https://track.example.test/click?pid=${externalId}`,
  amountMinor,
  // Only the rows that opt in via `extra` carry an MRP, so the catalogue
  // exercises both branches of Discover's price rendering — struck-through
  // and plain.
  listPriceMinor: null,
  currency: 'INR',
  merchant,
  category,
  inStock: true,
  // Null by default so the fixture catalogue mirrors the real one, where most
  // rows carry none of these — a fixture that always had a rating would hide
  // every "hide it when absent" bug the UI can have.
  rating: null,
  reviewCount: null,
  deliveryNote: null,
  brand: null,
  features: [],
  offers: [],
  affiliateMeta: { commissionPct: 4 },
  ...extra,
});

/** A discounted row: `amountMinor` is what you pay, `listPriceMinor` the MRP. */
const discounted = (listPriceMinor: number): Partial<NormalizedProduct> => ({ listPriceMinor });

/**
 * A small catalogue spanning every seeded gift category, so search, filtering,
 * and import can be exercised without a vendor contract.
 *
 * Categories are real taxonomy keys from the Sprint 2 seed — a fixture that
 * invented its own would let the category mapping ship broken.
 */
export const FIXTURE_PRODUCTS: NormalizedProduct[] = [
  p(
    'hp-001',
    'Noise-cancelling Headphones',
    2_499_00,
    'electronics',
    'SoundHouse',
    discounted(299_900),
  ),
  p('hp-002', 'Wireless Earbuds', 799_00, 'electronics', 'SoundHouse', discounted(99_900)),
  p('el-003', 'Smart Speaker', 349_900, 'electronics', 'TechBazaar'),
  p('el-004', 'E-reader', 1_099_00, 'electronics', 'TechBazaar', { inStock: false }),
  p('bk-001', 'The Midnight Library', 39_900, 'books', 'PagePalace'),
  p('bk-002', 'Atomic Habits', 45_000, 'books', 'PagePalace', discounted(59_900)),
  p('bk-003', 'A History of Filter Coffee', 62_500, 'books', 'PagePalace'),
  p('fa-001', 'Linen Shirt', 189_900, 'fashion', 'ThreadCo', discounted(249_900)),
  p('fa-002', 'Leather Belt', 129_900, 'fashion', 'ThreadCo'),
  p('be-001', 'Skincare Gift Set', 249_900, 'beauty', 'GlowUp', discounted(319_900)),
  p('ho-001', 'Scented Candle Trio', 99_900, 'home', 'HearthAndHome'),
  p('ho-002', 'Throw Blanket', 159_900, 'home', 'HearthAndHome', discounted(199_900)),
  p('ki-001', 'Cast Iron Skillet', 289_900, 'kitchen', 'ChefsCorner'),
  p('ki-002', 'Pour-over Coffee Kit', 219_900, 'kitchen', 'ChefsCorner', discounted(274_900)),
  p('to-001', 'Wooden Puzzle Set', 79_900, 'toys', 'PlayLoft'),
  p('sp-001', 'Yoga Mat', 149_900, 'sports_gear', 'FitKit', discounted(189_900)),
  p('sp-002', 'Resistance Bands', 59_900, 'sports_gear', 'FitKit'),
  p('ex-001', 'Pottery Workshop Voucher', 350_000, 'experiences', 'MakeSpace'),
  p('ha-001', 'Personalised Name Print', 129_900, 'handmade', 'CraftLane'),
  p('je-001', 'Silver Pendant', 449_900, 'jewellery', 'Lustre', discounted(549_900)),
  p('st-001', 'Leather Notebook', 89_900, 'stationery', 'InkAndFold'),
  p('gc-001', 'Bookshop Gift Card', null, 'gift_cards', 'PagePalace'),
  p('fd-001', 'Single-origin Coffee Beans', 79_900, 'food_drink', 'RoastWorks'),
];
