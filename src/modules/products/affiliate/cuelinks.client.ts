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

/**
 * One conversion from `GET /transactions`.
 *
 * Money arrives as decimal *strings* ("1499.00") in the documented shape and as
 * numbers in some responses, so both are accepted and normalised on our side.
 */
export interface CuelinksTransaction {
  id?: string | number;
  campaign_id?: number;
  campaign_name?: string;
  /** CPS, CPC — how the campaign pays. Recorded, not acted on. */
  campaign_type?: string;
  /**
   * Sub-IDs we set on the outbound link — how a sale maps back to an item.
   *
   * Written one way and read back another. The link takes
   * `subid,subid2,subid3,subid4,subid5` (dimension one is `subid`, **not**
   * `subid1` — a live convert call sent all six and `subid1` was silently
   * dropped), while the transactions report names the same five
   * `sub_id,sub_id_2…sub_id_5`. Both spellings are declared because reading the
   * wrong one yields `undefined`, which is indistinguishable from a sale we
   * cannot attribute — see [subIdsOf].
   */
  subid?: string | null;
  subid2?: string | null;
  subid3?: string | null;
  subid4?: string | null;
  subid5?: string | null;
  sub_id?: string | null;
  sub_id_2?: string | null;
  sub_id_3?: string | null;
  sub_id_4?: string | null;
  sub_id_5?: string | null;
  sale_amount?: string | number;
  /** The documented name for what we earn; `commission` is the older spelling. */
  user_commission?: string | number;
  commission?: string | number;
  currency?: string;
  /** pending | validated | payable | invoice_raised | paid | rejected. */
  status?: string;
  /** The merchant's own order number — what a buyer sees on their receipt. */
  order_id?: string | null;
  /** The network's reference for the same sale. */
  merchant_reference_id?: string | null;
  product_name?: string | null;
  category?: string | null;
  channel_id?: number | null;
  channel_name?: string | null;
  invoice_number?: string | null;
  transaction_date?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * The five attribution dimensions, whichever spelling this response used.
 *
 * In order: item, wishlist, user, group gift, click. The fifth is our own click
 * id, which is what makes a sale traceable to one person's click rather than to
 * whoever first caused the product's link to be converted.
 */
export const subIdsOf = (
  row: CuelinksTransaction,
): {
  itemId: string | null;
  wishlistId: string | null;
  userId: string | null;
  groupGiftId: string | null;
  clickId: string | null;
} => ({
  itemId: row.subid ?? row.sub_id ?? null,
  wishlistId: row.subid2 ?? row.sub_id_2 ?? null,
  userId: row.subid3 ?? row.sub_id_3 ?? null,
  groupGiftId: row.subid4 ?? row.sub_id_4 ?? null,
  clickId: row.subid5 ?? row.sub_id_5 ?? null,
});

/** What one page of `/transactions` may be narrowed to. */
export interface CuelinksTransactionQuery {
  page?: number;
  perPage?: number;
  /**
   * Only sales created or *revised* since this moment.
   *
   * The reason a revision-aware sync need not re-read history every hour: a
   * pending sale that becomes validated a week later is modified, not created,
   * and this is the filter that catches it.
   */
  updatedSince?: Date | null;
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
  async transactions(query: CuelinksTransactionQuery = {}): Promise<CuelinksTransactionPage> {
    const { page = 1, perPage = 100, updatedSince = null } = query;
    const body = await this.get<CuelinksEnvelope<CuelinksTransaction[]>>('/transactions', {
      page: String(page),
      per_page: String(perPage),
      // Sorted by when each row last changed, so paging stays meaningful
      // alongside `updated_since`: newest revision first, oldest last.
      sort: 'updated_at',
      order: 'desc',
      ...(updatedSince ? { updated_since: updatedSince.toISOString() } : {}),
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
