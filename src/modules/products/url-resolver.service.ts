import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import * as https from 'node:https';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { SsrfGuard } from 'src/common/net/ssrf-guard';
import type { AppConfig } from 'src/config/configuration';
import { amazonProductFromUrl, isAmazonShortLink, type AmazonProductRef } from './amazon-link';
import { AmazonLookupService } from './amazon-lookup.service';
import { amazonExternalId } from './amazon-product.mapper';
import type { NormalizedProduct } from './product.types';
import { ProductsService } from './products.service';
import { PRODUCT_PROVIDER, type IProductProvider } from './providers/product-provider.port';
import { linkExternalId, nameFromWords, readShopLink, type ShopLink } from './shop-link';
import { ShopLinkMatcher } from './shop-link-matcher.service';

/**
 * What a person is told when a link cannot be read, whatever the reason.
 *
 * One message, because there is one thing they can do about any of them. The
 * app puts the cursor in the name field beside it.
 */
export const ASK_FOR_A_NAME =
  'We couldn’t get the product name from that link. Type a name and we’ll still save the link.';

/**
 * How long a product saved from a link is reused before it is looked up
 * again. Two people pasting the same Amazon link in one afternoon is one
 * SerpApi call, not two; the nightly sync keeps the saved row honest after.
 */
const REUSE_WITHIN_MS = 6 * 60 * 60 * 1_000;

export interface ResolvedUrlProduct {
  /**
   * - `provider`: looked up — Amazon by ASIN, another shop on Google Shopping.
   * - `scrape`: read from the page's own tags.
   * - `link`: named from the words in the link, because neither could answer.
   */
  source: 'provider' | 'scrape' | 'link';
  product: Partial<NormalizedProduct> & { productUrl: string; title: string };
  /**
   * The catalogue row this product was saved as, when it was looked up. The
   * app imports the gift by it, so the item gets everything a searched
   * product gets: the details, price tracking, and a link that earns.
   */
  catalogueRef: { provider: string; externalId: string } | null;
}

@Injectable()
export class UrlResolverService {
  private readonly logger = new Logger(UrlResolverService.name);

  constructor(
    @Inject(PRODUCT_PROVIDER) private readonly provider: IProductProvider,
    private readonly ssrf: SsrfGuard,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly amazon: AmazonLookupService,
    private readonly products: ProductsService,
    private readonly matcher: ShopLinkMatcher,
  ) {}

  /**
   * Turns a pasted product URL into something importable.
   *
   * Cheapest route first. The provider recognising the URL costs nothing. An
   * Amazon link is looked up by its ASIN — exact, one SerpApi call — and never
   * scraped. Any other shop's page is read for free; only when the shop
   * blocks that is Google Shopping asked (one call), and only a confident
   * match is used. Failing all of those, the link's own words name the gift.
   */
  async resolve(rawUrl: string): Promise<ResolvedUrlProduct> {
    const known = await this.provider.resolveUrl(rawUrl).catch((err: Error) => {
      // A provider outage must not block the scrape fallback.
      this.logger.warn(`Provider could not resolve URL: ${err.message}`);
      return null;
    });
    if (known) {
      return {
        source: 'provider',
        product: known,
        catalogueRef: { provider: known.provider, externalId: known.externalId },
      };
    }

    // Amazon is never scraped. It answers a server reading its pages with a
    // 5xx, which reached people as "That link returned 500" on a link that
    // opened fine in their own browser.
    const amazon = await this.amazonProductBehind(rawUrl);
    if (amazon) {
      const product =
        (await this.recentlySaved(amazonExternalId(amazon))) ??
        (await this.saved(await this.amazon.lookup(amazon)));
      if (product) return UrlResolverService.lookedUp(product);
      // Scraping is not a fallback here — it is the thing that fails.
      throw new AppException(ErrorCode.PRODUCT_URL_UNSUPPORTED, ASK_FOR_A_NAME, 422);
    }

    let scrapeFailure: Error | null = null;
    try {
      const html = await this.fetchHtml(rawUrl);
      const parsed = UrlResolverService.parseOpenGraph(html, rawUrl);
      if (parsed.title) {
        return {
          source: 'scrape',
          product: parsed as ResolvedUrlProduct['product'],
          catalogueRef: null,
        };
      }
    } catch (err) {
      scrapeFailure = err instanceof Error ? err : new Error(String(err));
    }

    // The page would not say. The link might.
    const link = readShopLink(rawUrl) ?? (await this.shopLinkBehind(rawUrl));
    if (!link) {
      if (scrapeFailure) throw scrapeFailure;
      throw new AppException(ErrorCode.PRODUCT_URL_UNSUPPORTED, ASK_FOR_A_NAME, 422);
    }

    const matched =
      (await this.recentlySaved(linkExternalId(link.url))) ??
      (await this.saved(await this.matcher.find(link)));
    if (matched) return UrlResolverService.lookedUp(matched);

    return {
      source: 'link',
      product: {
        title: nameFromWords(link.words),
        productUrl: link.url,
        merchant: link.shop,
        imageUrls: [],
      },
      catalogueRef: null,
    };
  }

  private static lookedUp(product: NormalizedProduct): ResolvedUrlProduct {
    return {
      source: 'provider',
      product,
      catalogueRef: { provider: product.provider, externalId: product.externalId },
    };
  }

  /** A row this resolver saved within [REUSE_WITHIN_MS], so it is not paid for twice. */
  private async recentlySaved(externalId: string): Promise<NormalizedProduct | null> {
    const row = await this.products.findSnapshot('serpapi', externalId);
    if (!row?.lastSyncedAt || Date.now() - row.lastSyncedAt.getTime() > REUSE_WITHIN_MS) {
      return null;
    }
    return ProductsService.toNormalized(row);
  }

  /**
   * Saves a looked-up product to the catalogue, where an import can find it.
   * Before answering, so the reference the app is handed always resolves.
   */
  private async saved(product: NormalizedProduct | null): Promise<NormalizedProduct | null> {
    if (!product) return null;
    await this.products.upsertMany([product]);
    return product;
  }

  /**
   * A shop link hidden behind a short one — Flipkart's `dl.flipkart.com/s/…`,
   * Myntra's `myntr.it/…` — found by following the redirects until an address
   * names a product. Null when none does, or when a hop is refused.
   */
  private async shopLinkBehind(rawUrl: string): Promise<ShopLink | null> {
    const cfg = this.config.get('products', { infer: true });
    let current = rawUrl;
    try {
      for (let hop = 0; hop <= cfg.urlMaxRedirects; hop++) {
        const named = readShopLink(current);
        if (named) return named;
        const target = await this.ssrf.assertUrlIsSafe(current);
        const response = await this.request(target.url, target.address, cfg);
        if (!response.redirectTo) return null;
        current = new URL(response.redirectTo, current).toString();
      }
    } catch {
      return null;
    }
    return readShopLink(current);
  }

  /**
   * The Amazon product a link leads to, found without requesting Amazon.
   *
   * A storefront URL is read directly. A short link is followed hop by hop —
   * those hosts only redirect, and are not blocked — but the walk stops the
   * moment a hop *names* a product, before the product page itself is
   * requested. Anything else is not Amazon's, and returns null.
   *
   * Null too when there is no way to look the product up, so the link falls
   * through to the ordinary scrape rather than to a guaranteed refusal.
   */
  private async amazonProductBehind(rawUrl: string): Promise<AmazonProductRef | null> {
    if (!this.amazon.enabled) return null;

    const cfg = this.config.get('products', { infer: true });
    let current = rawUrl;
    for (let hop = 0; hop <= cfg.urlMaxRedirects; hop++) {
      const named = amazonProductFromUrl(current);
      if (named) return named;
      if (!isAmazonShortLink(current)) return null;

      // Every hop through the SSRF guard, exactly as the scrape does.
      const target = await this.ssrf.assertUrlIsSafe(current);
      const response = await this.request(target.url, target.address, cfg);
      if (!response.redirectTo) return null;
      current = new URL(response.redirectTo, current).toString();
    }
    return amazonProductFromUrl(current);
  }

  /**
   * Fetches a vetted URL, following redirects, re-vetting every hop.
   *
   * Redirects are the SSRF bypass everyone forgets: a public URL that 302s to
   * http://169.254.169.254/ passes a naive up-front check and then hands the
   * attacker the metadata service anyway. Every hop goes back through the
   * guard, exactly like the first.
   */
  private async fetchHtml(rawUrl: string): Promise<string> {
    const cfg = this.config.get('products', { infer: true });
    let currentUrl = rawUrl;

    for (let hop = 0; hop <= cfg.urlMaxRedirects; hop++) {
      const target = await this.ssrf.assertUrlIsSafe(currentUrl);
      const response = await this.request(target.url, target.address, cfg);

      if (response.redirectTo) {
        // Resolved against the current URL so a relative Location works.
        currentUrl = new URL(response.redirectTo, currentUrl).toString();
        continue;
      }
      return response.body;
    }

    throw new AppException(
      ErrorCode.PRODUCT_URL_UNREACHABLE,
      'That link redirects too many times',
      422,
    );
  }

  private request(
    url: URL,
    address: string,
    cfg: AppConfig['products'],
  ): Promise<{ body: string; redirectTo?: string }> {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.request(
        {
          // Connect to the ADDRESS the guard vetted, not the hostname.
          //
          // This is what closes the DNS-rebinding window: if we passed the
          // hostname, Node would resolve it again and could get a different —
          // private — answer than the one we checked. `servername`/Host keep
          // TLS and virtual hosting working against the pinned address.
          host: address,
          servername: isHttps && !/^[\d.:]+$/.test(url.hostname) ? url.hostname : undefined,
          port: url.port ? Number(url.port) : isHttps ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            Host: url.host,
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'WishtickBot/1.0 (+https://wishtick.app/bot)',
            'Accept-Encoding': 'identity',
          },
          timeout: cfg.urlFetchTimeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;

          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume(); // drain, or the socket leaks
            resolve({ body: '', redirectTo: res.headers.location });
            return;
          }

          if (status >= 400) {
            res.resume();
            // The status is for us, not for the person: "That link returned
            // 500" told them nothing they could do, and the fix is always the
            // same one — type the name.
            this.logger.debug(`${url.host} answered ${status} to a product read`);
            reject(new AppException(ErrorCode.PRODUCT_URL_UNREACHABLE, ASK_FOR_A_NAME, 422));
            return;
          }

          const contentType = String(res.headers['content-type'] ?? '');
          if (contentType && !contentType.includes('html')) {
            res.resume();
            reject(
              new AppException(
                ErrorCode.PRODUCT_URL_UNSUPPORTED,
                'That link is not a web page',
                422,
              ),
            );
            return;
          }

          // Cap the body as it streams. Trusting Content-Length would let a
          // server declare 1KB and stream gigabytes into our heap.
          let received = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > cfg.urlMaxBytes) {
              req.destroy();
              reject(
                new AppException(ErrorCode.PRODUCT_URL_UNSUPPORTED, 'That page is too large', 422),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new AppException(ErrorCode.PRODUCT_URL_UNREACHABLE, 'That link timed out', 422));
      });
      req.on('error', (err: Error) => {
        if (err instanceof AppException) reject(err);
        else
          reject(
            new AppException(
              ErrorCode.PRODUCT_URL_UNREACHABLE,
              'That link could not be reached',
              422,
            ),
          );
      });
      req.end();
    });
  }

  /**
   * Pulls Open Graph / meta tags out of HTML.
   *
   * Regex rather than a DOM parser on purpose: we want four tags from an
   * untrusted, often malformed page, and a full parser is a large attack
   * surface and a heavy dependency for that. Nothing here is rendered — every
   * value is treated as plain text and re-validated by the item DTO.
   */
  static parseOpenGraph(
    html: string,
    sourceUrl: string,
  ): Partial<NormalizedProduct> & {
    productUrl: string;
    title?: string;
  } {
    const meta = (property: string): string | null => {
      const patterns = [
        new RegExp(
          `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
          'i',
        ),
        new RegExp(
          `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`,
          'i',
        ),
      ];
      for (const re of patterns) {
        const m = re.exec(html);
        if (m?.[1]) return UrlResolverService.decodeEntities(m[1].trim());
      }
      return null;
    };

    const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    const title =
      meta('og:title') ??
      meta('twitter:title') ??
      (titleTag?.[1] ? UrlResolverService.decodeEntities(titleTag[1].trim()) : null);

    const image = meta('og:image') ?? meta('twitter:image');
    const priceText = meta('product:price:amount') ?? meta('og:price:amount');
    const currency = meta('product:price:currency') ?? meta('og:price:currency');

    return {
      productUrl: sourceUrl,
      ...(title ? { title: title.slice(0, 200) } : {}),
      description: meta('og:description')?.slice(0, 1000) ?? null,
      // Only absolute image URLs: a relative one would need resolving against a
      // page we do not trust, and a broken image is better than a surprise.
      imageUrls: image && /^https?:\/\//i.test(image) ? [image] : [],
      amountMinor: UrlResolverService.toMinorUnits(priceText),
      currency: currency?.toUpperCase() ?? 'INR',
      merchant: meta('og:site_name'),
      affiliateUrl: null,
      inStock: true,
      affiliateMeta: { scrapedFrom: sourceUrl },
    };
  }

  /** "2,499.00" → 249900. Returns null rather than guess. */
  private static toMinorUnits(text: string | null): number | null {
    if (!text) return null;
    const cleaned = text.replace(/[^\d.]/g, '');
    if (!cleaned) return null;
    const value = Number.parseFloat(cleaned);
    if (Number.isNaN(value)) return null;
    return Math.round(value * 100);
  }

  private static decodeEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
}
