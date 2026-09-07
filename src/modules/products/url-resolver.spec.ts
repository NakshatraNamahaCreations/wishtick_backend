import { UrlResolverService } from './url-resolver.service';

/**
 * The Open Graph parser, tested on its own.
 *
 * Every input here is an untrusted page from a stranger's link, so the parser
 * must never throw and never invent data — a missing tag is null, not a guess.
 */
describe('UrlResolverService.parseOpenGraph', () => {
  const parse = (html: string, url = 'https://shop.example.com/p/1') =>
    UrlResolverService.parseOpenGraph(html, url);

  it('reads title, image, price, and merchant from meta tags', () => {
    const parsed = parse(`
      <html><head>
        <meta property="og:title" content="Blue Headphones">
        <meta property="og:image" content="https://cdn.example.com/hp.jpg">
        <meta property="product:price:amount" content="2,499.00">
        <meta property="product:price:currency" content="inr">
        <meta property="og:site_name" content="SoundHouse">
      </head></html>`);

    expect(parsed.title).toBe('Blue Headphones');
    // Minor units, integer: 2,499.00 → 249900. A float here would drift once
    // Sprint 7 sums contributions.
    expect(parsed.amountMinor).toBe(249_900);
    expect(parsed.currency).toBe('INR');
    expect(parsed.merchant).toBe('SoundHouse');
    expect(parsed.imageUrls).toEqual(['https://cdn.example.com/hp.jpg']);
  });

  it('falls back to <title> when og:title is absent', () => {
    expect(parse('<html><head><title>Plain Page</title></head></html>').title).toBe('Plain Page');
  });

  it('handles reversed attribute order', () => {
    // Real pages are not tidy; content-before-property is common.
    expect(parse('<meta content="Reversed" property="og:title">').title).toBe('Reversed');
  });

  it('accepts name= as well as property=', () => {
    expect(parse('<meta name="twitter:title" content="From Twitter">').title).toBe('From Twitter');
  });

  it('decodes HTML entities', () => {
    expect(parse('<meta property="og:title" content="Tom &amp; Jerry&#39;s Mug">').title).toBe(
      "Tom & Jerry's Mug",
    );
  });

  it('drops a relative image rather than resolving it against an untrusted page', () => {
    const parsed = parse(
      '<meta property="og:title" content="X"><meta property="og:image" content="/img/x.jpg">',
    );
    expect(parsed.imageUrls).toEqual([]);
  });

  it('ignores a non-http image URL', () => {
    // `javascript:` or `data:` in an image slot has no business reaching a client.
    const parsed = parse(
      '<meta property="og:title" content="X"><meta property="og:image" content="javascript:alert(1)">',
    );
    expect(parsed.imageUrls).toEqual([]);
  });

  it('returns no title for a page with nothing usable', () => {
    // The caller turns this into a 422 telling the user to add the item by hand.
    expect(parse('<html><body>nothing here</body></html>').title).toBeUndefined();
  });

  it('returns a null price rather than guessing', () => {
    expect(parse('<meta property="og:title" content="No price">').amountMinor).toBeNull();
  });

  it('returns a null price for an unparseable amount', () => {
    expect(
      parse(
        '<meta property="og:title" content="X"><meta property="product:price:amount" content="call us">',
      ).amountMinor,
    ).toBeNull();
  });

  it('caps an absurdly long title', () => {
    const parsed = parse(`<meta property="og:title" content="${'x'.repeat(5_000)}">`);
    expect(parsed.title!.length).toBe(200);
  });

  it('does not throw on malformed HTML', () => {
    expect(() => parse('<html><head><meta property="og:title" content=')).not.toThrow();
    expect(() => parse('')).not.toThrow();
  });

  it('keeps the source URL as the product link', () => {
    const parsed = parse('<meta property="og:title" content="X">', 'https://shop.test/p/9');
    expect(parsed.productUrl).toBe('https://shop.test/p/9');
    // A scrape never yields a monetized link — we only get those from a network.
    expect(parsed.affiliateUrl).toBeNull();
  });
});
