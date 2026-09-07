import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';

/** An upstream HTTP failure, carrying the status ProviderGuard retries on. */
export class CuelinksHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CuelinksHttpError';
  }
}

/**
 * Every Cuelinks v3 response is wrapped in `data`. Verified live — reading the
 * fields off the top level silently yields `undefined`, which for
 * `links/convert` looks exactly like "not affiliated".
 */
interface CuelinksEnvelope<T> {
  data?: T;
  meta?: CuelinksMeta;
}

/** Page-based, not cursor-based. Confirmed live on `/transactions`. */
export interface CuelinksMeta {
  page?: number;
  per_page?: number;
  total?: number;
  total_pages?: number;
  /** The next page number, or null on the last page. */
  next_page?: number | null;
  prev_page?: number | null;
}

/** What `POST /links/convert` answers, inside `data`. */
export interface CuelinksLink {
  /** The `linksredirect.com` tracked link to send the browser to. */
  tracking_url?: string;
  /** Same value as `tracking_url` in every live response seen so far. */
  affiliate_url?: string;
  original_url?: string;
  /**
   * **Not** a gate on whether the link works.
   *
   * Live calls against Amazon India and Flipkart both return `affiliated:false`
   * *together with* a valid `tracking_url` and a real campaign — the flag
   * appears to describe this publisher's approval state for the campaign, not
   * whether the URL can be tracked. Treating it as a gate rejected 100% of
   * links. It is recorded for reporting; the presence of `tracking_url` is what
   * decides.
   */
  affiliated?: boolean;
  campaign?: { id?: number; name?: string } | null;
}

export interface CuelinksCampaign {
  id?: number;
  name?: string;
  categories?: string[];
  epc_7_day?: number;
  epc_90_day?: number;
}

/** One conversion from `GET /transactions`. */
export interface CuelinksTransaction {
  id?: string;
  campaign_id?: number;
  campaign_name?: string;
  /**
   * Sub-IDs we set on the outbound link — how a sale maps back to an item.
   *
   * The first dimension is `subid`, **not** `subid1`: a live convert call sent
   * all six and the returned tracking URL carried
   * `subid,subid2,subid3,subid4,subid5` — `subid1` was silently dropped. Since
   * dimension one is the item id, using the wrong name loses the attribution
   * that makes any of this worth reconciling.
   */
  subid?: string | null;
  subid2?: string | null;
  subid3?: string | null;
  subid4?: string | null;
  subid5?: string | null;
  sale_amount?: number;
  commission?: number;
  currency?: string;
  status?: string;
  transaction_date?: string;
  updated_at?: string;
}

export interface CuelinksTransactionPage {
  transactions: CuelinksTransaction[];
  /** The next page number, or null when this was the last. */
  nextPage: number | null;
}

/**
 * Cuelinks' publisher API — the vendor that turns a merchant URL into a paid
 * link, and later tells us which of those links produced a sale.
 *
 * Deliberately a thin client. Retry, timeout, rate limiting and the breaker all
 * belong to ProviderGuard, which the callers wrap this in; errors carry a
 * `status` so the guard can tell a 429 from a 400.
 */
@Injectable()
export class CuelinksClient {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('affiliate', { infer: true });
  }

  get enabled(): boolean {
    return this.cfg.network === 'cuelinks' && this.cfg.cuelinksApiKey !== '';
  }

  /**
   * Converts a merchant product URL into a tracked link.
   *
   * The sub-IDs are Wishtick's attribution: they are what lets a commission
   * that lands weeks later be traced back to the item and the person who
   * clicked. Cuelinks accepts five dimensions; we spend four and keep one free.
   */
  async convert(input: {
    url: string;
    itemId?: string;
    wishlistId?: string;
    userId?: string;
    groupGiftId?: string;
  }): Promise<CuelinksLink> {
    const { data } = await this.send<CuelinksEnvelope<CuelinksLink>>(
      new URL(`${this.cfg.cuelinksBaseUrl}/links/convert`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: input.url,
          // `subid`, not `subid1` — see CuelinksTransaction.
          subid: input.itemId ?? null,
          subid2: input.wishlistId ?? null,
          subid3: input.userId ?? null,
          subid4: input.groupGiftId ?? null,
        }),
      },
    );
    return data ?? {};
  }

  /** Which merchants pay, and how well. Used to decide where to send a buyer. */
  async campaigns(q: string): Promise<CuelinksCampaign[]> {
    const { data } = await this.get<CuelinksEnvelope<CuelinksCampaign[]>>('/campaigns', { q });
    return data ?? [];
  }

  /**
   * One page of conversions. Page-based, not cursor-based: `meta.next_page`
   * carries the next number, or null when this was the last.
   */
  async transactions(page = 1, perPage = 100): Promise<CuelinksTransactionPage> {
    const body = await this.get<CuelinksEnvelope<CuelinksTransaction[]>>('/transactions', {
      page: String(page),
      per_page: String(perPage),
    });
    return { transactions: body.data ?? [], nextPage: body.meta?.next_page ?? null };
  }

  /** Key validity and publisher identity. Used by the readiness check. */
  async ping(): Promise<{ status?: string; publisher?: { id?: number; name?: string } }> {
    // `/ping` answers at the top level rather than under `data`.
    return this.send<{ status?: string; publisher?: { id?: number; name?: string } }>(
      new URL(`${this.cfg.cuelinksBaseUrl}/ping`),
      { method: 'GET' },
    );
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.cfg.cuelinksBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.send<T>(url, { method: 'GET' });
  }

  private async send<T>(url: URL, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        // Cuelinks' scheme is `Token <key>`, not `Bearer`.
        authorization: `Token ${this.cfg.cuelinksApiKey}`,
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CuelinksHttpError(
        response.status,
        `Cuelinks ${url.pathname} ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as T;
  }
}
