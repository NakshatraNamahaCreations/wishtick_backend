import type { NormalizedProduct } from './product.types';
import { soldOn } from './platforms';

const sold = (merchant: string | null, productUrl = 'https://www.google.com/x') =>
  ({ merchant, productUrl }) as NormalizedProduct;

describe('soldOn', () => {
  it.each([
    ['Amazon.in', 'amazon'],
    ['Amazon.in - Seller', 'amazon'],
    ['Flipkart', 'flipkart'],
    ['Tata CLiQ', 'tatacliq'],
    ['Swiggy Instamart', 'swiggy'],
    ['Instamart', 'swiggy'],
    ['Croma', 'croma'],
  ] as const)('%s is %s', (merchant, platform) => {
    expect(soldOn(sold(merchant), platform)).toBe(true);
  });

  it('matches whole words only', () => {
    expect(soldOn(sold('Chromatic Crafts'), 'croma')).toBe(false);
    expect(soldOn(sold('Decathlon Sports India'), 'amazon')).toBe(false);
  });

  it("falls back to the link's host when no seller is named", () => {
    expect(soldOn(sold(null, 'https://www.myntra.com/p/1'), 'myntra')).toBe(true);
  });
});
