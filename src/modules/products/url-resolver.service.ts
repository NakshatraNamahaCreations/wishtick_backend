import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import * as https from 'node:https';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { SsrfGuard } from 'src/common/net/ssrf-guard';
import type { AppConfig } from 'src/config/configuration';
import type { NormalizedProduct } from './product.types';
import { PRODUCT_PROVIDER, type IProductProvider } from './providers/product-provider.port';

export interface ResolvedUrlProduct {
  /** 'provider' when a network recognized the URL; 'scrape' when we read tags. */
  source: 'provider' | 'scrape';
  product: Partial<NormalizedProduct> & { productUrl: string; title: string };
}

@Injectable()
export class UrlResolverService {
  private readonly logger = new Logger(UrlResolverService.name);

  constructor(
    @Inject(PRODUCT_PROVIDER) private readonly provider: IProductProvider,
    private readonly ssrf: SsrfGuard,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Turns a pasted product URL into something importable.
   *
   * Asks the provider first, and only scrapes when it does not recognize the
   * URL: a provider answer needs no outbound request at all, which is both
   * faster and strictly safer than fetching a stranger's link from inside our
   * network.
   */
  async resolve(rawUrl: string): Promise<ResolvedUrlProduct> {
    const known = await this.provider.resolveUrl(rawUrl).catch((err: Error) => {
      // A provider outage must not block the scrape fallback.
      this.logger.warn(`Provider could not resolve URL: ${err.message}`);
      return null;
    });
    if (known) return { source: 'provider', product: known };

    const html = await this.fetchHtml(rawUrl);
    const parsed = UrlResolverService.parseOpenGraph(html, rawUrl);
    if (!parsed.title) {
      throw new AppException(
        ErrorCode.PRODUCT_URL_UNSUPPORTED,
        'We could not read a product from that link. You can add the item manually.',
        422,
      );
    }
    return { source: 'scrape', product: parsed as ResolvedUrlProduct['product'] };
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
            reject(
              new AppException(
                ErrorCode.PRODUCT_URL_UNREACHABLE,
                `That link returned ${status}`,
                422,
              ),
            );
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
