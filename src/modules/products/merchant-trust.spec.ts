import type { NormalizedProduct } from './product.types';
import { merchantTrust, trustedFirst } from './merchant-trust';

const at = (merchant: string | null, url = 'https://example.test/p'): NormalizedProduct =>
  ({
    provider: 'serpapi',
    externalId: `${merchant}`,
    title: 'x',
    merchant,
    productUrl: url,
  }) as NormalizedProduct;

describe('where a product is sold', () => {
  it('knows the big stores however they are written', () => {
    expect(merchantTrust(at('Amazon.in'))).toBe(2);
    expect(merchantTrust(at('amazon.in - Seller'))).toBe(2);
    expect(merchantTrust(at('Tata CLiQ'))).toBe(2);
    expect(merchantTrust(at(null, 'https://www.flipkart.com/p/1'))).toBe(2);
  });

  it('puts cross-border resellers last', () => {
    expect(merchantTrust(at('ubuy.co.in'))).toBe(0);
    expect(merchantTrust(at('desertcart.in'))).toBe(0);
  });

  it('leaves everybody else in the middle', () => {
    expect(merchantTrust(at('Etsy'))).toBe(1);
    expect(merchantTrust(at('Mysore Handicrafts'))).toBe(1);
  });

  it('matches whole words, not pieces of them', () => {
    expect(merchantTrust(at('Pineapple Crafts'))).toBe(1);
    expect(merchantTrust(at('Sailboat Gifts'))).toBe(1);
  });
});

describe('trusted stores first', () => {
  it('lifts them without reshuffling anything else', () => {
    const order = trustedFirst([
      at('ubuy.co.in'),
      at('Etsy'),
      at('Amazon.in'),
      at('Local Shop'),
      at('Flipkart'),
    ]).map((p) => p.merchant);

    expect(order).toEqual(['Amazon.in', 'Flipkart', 'Etsy', 'Local Shop', 'ubuy.co.in']);
  });
});
