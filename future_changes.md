# Future changes

Work that is understood but not built. Each entry says what exists today, what
it would take, and what to be careful of — so picking one up does not start
with rediscovering the ground it stands on.

Everything here is optional. Nothing in this file is a bug; the gifting flow
works without any of it.

---

## Where the Cuelinks integration stands today

The four ideas below all draw on the same publisher API, so the state of it is
worth stating once.

**Configured and live.** `AFFILIATE_NETWORK=cuelinks` with a key in `.env`;
base URL `https://developers.cuelinks.com/pub_api/v3`. Auth is
`Authorization: Token <key>` — **not** `Bearer`. Every response except `/ping`
is wrapped in `{ data, meta }`, and paging is by page number (`meta.next_page`),
never a cursor.

**What we already use:**

| Endpoint | Used by | Notes |
|---|---|---|
| `POST /links/convert` | `MonetizationService.ensureMonetized` — [monetization.service.ts:56](src/modules/products/affiliate/monetization.service.ts#L56) | On every click, cached on the product row |
| `GET /transactions` | `ConversionSyncService.sync` — [conversion-sync.service.ts:65](src/modules/products/affiliate/conversion-sync.service.ts#L65) | Hourly (`40 * * * *`), incremental via `updated_since` |
| `GET /campaigns` | **nobody** — [cuelinks.client.ts:216](src/modules/products/affiliate/cuelinks.client.ts#L216) | The method exists and is never called |
| `GET /ping` | **nobody** | Written for a readiness check that was never added |

**Foundations that landed with the purchase auto-tick**, and that most of the
work below leans on:

- **Per-click attribution.** The redirect rewrites `subid` (item), `subid2`
  (wishlist), `subid3` (user) and stamps `subid5` with the click's own uuid —
  [click-tracking.service.ts](src/modules/products/click-tracking.service.ts).
  Before this, a product's link carried whoever converted it *first*.
- **A conversions table worth reading.** `conversions` now stores the click id,
  the merchant's `orderId`, the product name, the merchant reference, sale and
  commission in minor units, and the network's status verbatim —
  [conversion.schema.ts](src/modules/products/schemas/conversion.schema.ts).
- **A reconciler.** `ConversionReconcileService` matches a sale to the gift on
  that item held by that gifter and marks it purchased —
  [conversion-reconcile.service.ts](src/modules/gifting/conversion-reconcile.service.ts).
- **`ProviderGuard`** gives any new call retries with jitter, a timeout, a
  shared rate limit and a circuit breaker —
  [provider-guard.service.ts](src/modules/products/providers/provider-guard.service.ts).
  Wrap every upstream call in it. Note it currently reads its knobs from the
  `products` (SerpApi) config block; a Cuelinks-specific block is overdue if
  these features add much traffic.

**Verify before building.** The public docs page lists endpoints without full
field tables. `/transactions` was confirmed field by field; `/offers`,
`/campaigns`, `/reports/performance`, `/invoices` and `/missing_transactions`
were **not**. Open the API console at `developers.cuelinks.com/docs/console`,
call each one with the real key, and paste a redacted sample response into the
ticket before writing the client type. The `/transactions` lesson is worth
repeating: the sub-IDs are written as `subid…subid5` on the link and read back
as `sub_id…sub_id_5` in the report, and money arrives as a decimal *string* —
reading the wrong name yields `undefined`, which looks exactly like a sale with
no attribution.

---

## 1. Live offers and coupons (`GET /offers`)

**What it gives.** Live coupons and deals across campaigns. Field names
unconfirmed; expect at minimum a campaign id, a code, a description, a
discount, and a validity window.

**Why it is worth building.** Today a gifter is sent to the merchant with
nothing. "Flat 10% off with `GIFT10`" on the hand-off sheet is the cheapest
possible improvement to the moment they are actually about to spend money, and
it costs us nothing to pass on.

**Where it would show.**

- The gift hand-off sheet, under the address, before "Continue to Store" —
  [gift_handoff_sheet.dart](../wishtick_flutter/lib/features/gifting/presentation/widgets/gift_handoff_sheet.dart).
  Best placement: the gifter is committed and has the merchant's checkout in
  front of them thirty seconds later.
- The product detail screen and a wishlist item's page, as a small badge.

**Sketch.**

1. `CuelinksClient.offers(campaignId?)`, guarded by `ProviderGuard`.
2. A new `affiliate_offers` collection: campaign id, code, title, terms, starts
   and ends, `syncedAt`. Synced nightly on the existing `QUEUE.AFFILIATE_SYNC`
   registrar — [affiliate-sync.processor.ts:46](src/modules/products/affiliate-sync.processor.ts#L46)
   — beside the price sweep, not on a new clock.
3. Join by the campaign id already recorded per product in
   `affiliateMeta.cuelinks.campaignId` (written by `MonetizationService.mark`).
   A product that was never converted has no campaign and therefore no offers:
   show nothing rather than guessing from the merchant name.
4. Serve from the existing item/product views, or a small
   `GET /items/:itemId/offers`. Prefer folding it into the view the screen
   already fetches — one round trip, not two.

**Care.**

- **Never show an expired coupon.** Filter on the validity window at read time,
  not only at sync time; a nightly sync means a coupon can die during the day.
- A code that fails at checkout is worse than no code. Copy should say the
  merchant's terms apply, and the button must work whether or not the code does.
- Offers are per merchant, not per product: do not phrase one as "₹500 off this
  item" unless the payload actually says so.
- Rate limits are unknown. Sync per campaign we care about (the ones our
  products resolve to), not the whole catalogue of 10,000+.

**Effort.** Roughly a day for the sync and the model, a day for the surfaces.

---

## 2. Campaign EPC, to steer a buyer to the merchant that pays (`GET /campaigns`)

**What it gives.** Campaign id, name, categories, `epc_7_day`, `epc_90_day` —
already typed as `CuelinksCampaign` in
[cuelinks.client.ts:58](src/modules/products/affiliate/cuelinks.client.ts#L58).
EPC is earnings per hundred clicks, publisher-wide.

**Why.** A product row carries several sellers (`Product.offers`), and we pick
the order. Two sellers within ₹50 of each other are the same gift to the buyer
and a very different amount of revenue to us.

**Sketch.**

1. Nightly sync of campaigns into `affiliate_campaigns` (id, name, categories,
   both EPCs, `syncedAt`), on the existing affiliate-sync registrar.
2. Resolve each `Product.offers[n]` to a campaign — the conversion response
   already returns `campaign: {id, name}` per converted URL, so store it per
   offer in the same positional `$set` that writes `offers[n].affiliateUrl`
   ([monetization.service.ts:186](src/modules/products/affiliate/monetization.service.ts#L186)).
3. Sort or badge sellers with EPC as a **tiebreak**, never as the primary key.

**Care — read this before shipping it.**

- **Price first, always.** Reordering sellers so the buyer pays more is not a
  ranking change, it is a trust problem, and it is the kind of thing users
  notice once and never forgive. The defensible rule: sort by price, and among
  materially equal prices prefer the better-earning merchant.
- EPC is an average across all publishers and all traffic. It says nothing
  about one buyer, and a high-EPC merchant can still be the wrong shop for this
  product.
- An unapproved campaign can still return a working tracking URL
  (`affiliated:false` with a real `tracking_url` — the reason
  `MonetizationService` gates on the URL and not the flag). Do not use
  `affiliated` as an approval signal here either.

**Effort.** A day for the sync and the join; the ranking change is small code
and a large decision — get it agreed before writing it.

---

## 3. An earnings view (`GET /reports/performance`, `GET /invoices`)

**What they give.** Performance and earnings reporting, and invoices with a tax
breakdown.

**Why.** Nobody can currently answer "what did Wishtick earn last month" from
inside Wishtick. More interestingly, **we can answer questions the network
cannot**: our `conversions` rows carry item, wishlist, user and click, so
earnings can be broken down by wishlist, by occasion, by event, by group gift —
attribution the network has no idea about.

**Sketch.**

1. `CuelinksClient.performance(range)` and `.invoices()`.
2. Nightly sync into `affiliate_reports` and `affiliate_invoices`, keyed so a
   re-read updates rather than duplicates — the same discipline as
   `{network, externalId}` on conversions.
3. Admin-only read endpoints, `@Roles(UserRole.ADMIN)`, alongside the existing
   admin surface (see the dead-letter listing at
   [webhook.controller.ts:73](src/modules/gifting/webhook.controller.ts#L73) for
   the shape).
4. Screens in `wishtick_admin-panel`: earnings by month, by campaign, invoice
   status, and — the part that is ours alone — commission attributed to
   wishlists, events and group gifts, aggregated from `conversions`.

**Care.**

- Money is admin-only. No route may leak a commission figure to a normal user,
  and nothing here belongs in the app.
- Never show a gifter or a recipient what a gift earned us. It is true, it is
  legal, and it will feel like a cut of their present.
- The network's figures are revised for weeks. Show the status verbatim
  (`pending` / `validated` / `payable` / `paid`) rather than summing everything
  into one confident number.
- Currency is the account's (INR or USD), and dates are the network's timezone.
  Convert to minor units on write, as the conversion sync already does.

**Effort.** Two days backend, plus whatever the admin panel screens deserve.

---

## 4. Claiming sales the network missed (`GET`/`POST /missing_transactions`)

**What it gives.** File and track missing transaction claims — a sale that
happened but was never reported, usually because the affiliate cookie was lost.

**Why.** This is the one entry whose value grows out of what we already store.
A gifter who taps "Yes, I bought it" and whose gift never receives a matching
conversion is, by definition, a candidate missing transaction: we have the
click, its timestamp, the item, the price and the merchant. Today that revenue
is simply lost.

**Sketch.**

1. A weekly sweeper: gifts where `mode = online`, `status ∈ {purchased,
   fulfilled}`, `orderRef = null`, and `purchasedAt` older than the network's
   reporting lag (start at 7 days; a sale can legitimately take days to
   appear). Join to the `click_events` row by item and gifter for the click
   time and tracking id.
2. Draft a claim per candidate into `affiliate_claims` with the evidence, and
   **file nothing automatically**: an admin reviews and submits. Networks
   penalise noisy publishers, and a claim with no order number is noise.
3. `POST /missing_transactions` on approval; poll status with the `GET` and
   show it in the admin panel.

**Prerequisite — capture the merchant's order number.** Claims need proof, and
we do not ask for any. The cheapest way: an optional "order number" field on
the "Did you complete the purchase?" dialog
([gift_handoff_sheet.dart](../wishtick_flutter/lib/features/gifting/presentation/widgets/gift_handoff_sheet.dart)),
passed through the existing `note`/`deliveryNotes` path on
`POST /gifts/:giftId/purchase` or a new field on the gift. Optional, skippable,
and worth asking for exactly once — the gifter is looking at the confirmation
email at that moment and never will be again.

**Care.**

- Never file the same claim twice; key it on the gift.
- Never file for a gift that already has an `orderRef` — the reconciler found
  it, so it was not missing.
- The gifter's word is the only evidence that a purchase happened at all. A
  claim built on it and nothing else is a guess; the order number is what makes
  it a claim.

**Effort.** A day for the sweeper and the model, half a day for the app field,
plus the admin review screen.

---

## Adjacent gaps, for whoever picks this file up

Not Cuelinks work, but found while mapping the gifting flow and worth tracking
in the same place.

- **A recipient cannot confirm anything arrived.** `fulfill` and `complete` are
  both gifter-only ([gifting.service.ts:248](src/modules/gifting/gifting.service.ts#L248));
  a recipient calling them gets a 404. So "it arrived" is asserted by the one
  person who did not receive it, and Gifts Received stays empty until the
  gifter remembers to say so. `completed` is effectively a dead status: no
  group-gift path can reach it either.
- **No way to log a gift bought elsewhere.** `POST /items/:id/gift-offline`
  works and no screen calls it. Most real gifting will not go through the
  affiliate link.
- **Group-gift contributors do not appear in their own Gifts Given.** Only the
  initiator gets a `Gift` row; a contribution creates none — so chipping in
  ₹2,000 leaves the Group tab empty for everyone but the organiser.
- **Gifts Given lists cancelled and expired reservations** alongside real
  gifts, with no filter and no paging
  ([gift-list.service.ts:55](src/modules/gifting/gift-list.service.ts#L55)).
- **`ReservationExpiryService.sweepExpired` is wired to nothing.** If a delayed
  BullMQ job is ever lost, that reservation holds the item forever
  ([reservation-expiry.service.ts:95](src/modules/gifting/reservation-expiry.service.ts#L95)).
- **`gifting.reservationWarnHours` is configured and unused** — nothing warns a
  gifter that their hold is about to lapse.
