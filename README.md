# Wishtick Backend

NestJS + TypeScript API for the Wishtick MVP. See [scope_of_work.md](scope_of_work.md) for product scope and [sprints.md](sprints.md) for the delivery plan.

**Stack:** NestJS 11 · MongoDB Atlas (Mongoose) · Redis (cache + locks + rate limiting) · BullMQ · Passport/JWT · Pino · Swagger

**Status:** Sprints 1–10 complete — foundation, auth, onboarding, profile, media, dashboard, wishlists, product search / affiliate import, events / invites, single gifting, group gifting, realtime chat, notifications (email/SMS + thank-you notes), and time-locked birthday reels compiled with ffmpeg.

---

## Quick start

```bash
npm install
cp .env.example .env          # then edit the JWT secrets
docker compose up -d          # Redis + a single-node Mongo replica set
npm run migrate:up            # indexes + the taxonomy seed
npm run start:dev
```

- API: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/api/docs`
- Probes: `http://localhost:3000/health`, `http://localhost:3000/ready`

Generate real secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Boot fails fast if any variable in [src/config/env.validation.ts](src/config/env.validation.ts) is missing or malformed — including a `JWT_ACCESS_SECRET` under 32 characters or identical to `JWT_REFRESH_SECRET`.

If you use MongoDB Atlas instead of the local container, set `MONGO_URI` to your `mongodb+srv://` string. Mongo runs as a replica set locally because transactions are required from Sprint 6 onward, and dev should match Atlas.

## Scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` / `npm run start:prod` | Compile / run compiled output |
| `npm run lint` / `npm run lint:fix` | ESLint (type-aware) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `npm run test:cov` | Unit + integration tests |
| `npm run test:e2e` | End-to-end HTTP tests |
| `npm run migrate:up` / `migrate:status` | Apply / list database migrations |

Tests need no running infrastructure: Mongo comes from `mongodb-memory-server` and Redis from `ioredis-mock`.

**Migrations run as their own deploy step, never on boot** — otherwise every replica races to build the same indexes during a rolling deploy, and one failure takes down every pod instead of failing one step. They are forward-only and applied at most once per database (see [src/infra/migrations/](src/infra/migrations/)).

## API surface (Sprints 1–12)

All routes are prefixed `/api/v1`. Public routes need no token; the rest require `Authorization: Bearer <accessToken>`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | public | Register with email **or** phone |
| POST | `/auth/login` | public | Log in with either identifier |
| POST | `/auth/refresh` | public | Rotate a refresh token |
| POST | `/auth/logout` | bearer | End the current session |
| POST | `/auth/logout-all` | bearer | End every session everywhere |
| GET | `/auth/me` | bearer | The authenticated user |
| GET | `/auth/sessions` | bearer | List sessions (one per device) |
| DELETE | `/auth/sessions/:id` | bearer | Revoke one session |
| POST | `/auth/verify/email/request` \| `/confirm` | public | Email OTP |
| POST | `/auth/verify/phone/request` \| `/confirm` | public | SMS OTP |
| POST | `/auth/password/forgot` \| `/reset` | public | Password reset |
| POST | `/auth/account/restore` | public | Undo a pending deletion (password-authorized) |
| GET | `/onboarding/options` | public | The flow definition + every selectable value |
| GET | `/onboarding/status` | bearer | Steps done, steps still required |
| POST | `/onboarding/steps/:step` | bearer | Save one step (idempotent) |
| POST | `/onboarding/complete` | bearer | Finish onboarding |
| GET | `/me` | bearer | User + full profile |
| GET | `/me/export` | bearer | GDPR-style export of everything we hold about you |
| PATCH | `/me` | bearer | Name, photo, DOB, timezone, contact |
| PATCH | `/me/preferences` | bearer | Gifting preferences (taxonomy-validated) |
| DELETE | `/me` | bearer | Soft delete + scheduled anonymization |
| POST | `/media/upload-url` | bearer | Presigned upload ticket |
| POST | `/media/confirm` | bearer | Verify the upload landed |
| GET | `/dashboard/summary` | bearer | Counts for all 12 sections |
| POST/GET | `/wishlists` | bearer | Create / list your wishlists |
| GET | `/wishlists/shared-with-me` | bearer | Lists others shared with you |
| GET/PATCH/DELETE | `/wishlists/:id` | bearer | Read / update / archive |
| POST | `/wishlists/:id/share` | bearer | Rotate the slug, set a passcode or expiry |
| GET/POST | `/wishlists/:id/items` | bearer | List (filterable) / add items |
| PATCH | `/wishlists/:id/items/reorder` | bearer | Reorder atomically |
| GET/PATCH/DELETE | `/wishlists/:id/items/:itemId` | bearer | Read / update / remove |
| GET/POST | `/wishlists/:id/participants` | bearer | Who has access / grant access |
| DELETE | `/wishlists/:id/participants/:pid` | bearer | Revoke access |
| POST | `/wishlists/:id/items/from-product` | bearer | Import a catalogue product |
| GET | `/products/search` | bearer | Search the catalogue (cached) |
| GET | `/products/categories` | bearer | Browsable categories |
| GET | `/products/:provider/:externalId` | bearer | One product |
| POST | `/products/resolve-url` | bearer | Resolve a pasted product URL |
| GET | `/r/:itemId` | optional | Affiliate redirect + click tracking |
| POST/GET | `/events` \| `/events/mine` | bearer | Create / list events you host |
| GET | `/events/invited` | bearer | Events you were invited to |
| GET/PATCH/DELETE | `/events/:id` | bearer | Read / update / cancel |
| POST | `/events/:id/publish` | bearer | Publish + schedule reminders |
| POST | `/events/:id/invite/preview` | bearer | Render the invite card |
| GET/POST | `/events/:id/invites` | bearer | Guest list / bulk invite |
| POST/DELETE | `/events/:id/invites/:iid` (resend / revoke) | bearer | Manage one invite |
| GET | `/invite-templates` | public | Designs + colour variants |
| GET | `/public/invites/:token` | optional | Open an invite |
| POST | `/public/invites/:token/rsvp` | optional | RSVP, no account needed |
| GET | `/public/events/:slug/preview` | public | Event OG metadata |
| GET | `/public/wishlists/:slug` | public | Open a shared list, redacted |
| GET | `/public/wishlists/:slug/preview` | public | Open Graph metadata |
| POST | `/items/:id/reserve` | bearer | Reserve an item (`Idempotency-Key` required) |
| DELETE | `/items/:id/reserve` | bearer | Release your reservation |
| POST | `/items/:id/gift-offline` | bearer | Mark bought elsewhere (`Idempotency-Key`) |
| POST | `/gifts/:id/purchase` \| `/fulfill` \| `/complete` \| `/cancel` | bearer | Advance a gift through its state machine |
| GET | `/gifts/given` \| `/received` \| `/on-hold` | bearer | The three dashboard gift sections |
| POST | `/webhooks/affiliate/:provider` | public | Signed affiliate conversion (auto-ticks a gift) |
| GET | `/webhooks/affiliate/dead-letter` | admin | Signature-valid webhooks that matched no gift |
| POST | `/items/:id/group-gift` | bearer | Start a group gift (`Idempotency-Key` required) |
| POST | `/group-gifts/:id/join` | bearer | Join as a named member (no money) |
| POST | `/group-gifts/:id/contribute` | bearer | Contribute (`Idempotency-Key` required) |
| DELETE | `/group-gifts/:id/contributions/:cid` | bearer | Withdraw your contribution while still open |
| POST | `/group-gifts/:id/purchase` \| `/fulfill` \| `/cancel` | bearer | Advance it (initiator only) |
| GET | `/group-gifts/:id` | bearer | Progress, participants, timeline |
| POST | `/group-gifts/:id/share` | bearer | Configure the public share link |
| GET | `/public/group-gifts/:slug` \| `/preview` | public | Redacted public view + OG progress card |
| GET | `/chats` | bearer | Your chats (the two dashboard sections) + unread counts |
| GET | `/wishlists/:id/chat` \| `/chats/:id` | bearer | Resolve a chat (lazy for wishlists) |
| GET | `/chats/:id/messages?before=&limit=` | bearer | History, cursor-paginated, anti-spoiler filtered |
| POST | `/chats/:id/messages` | bearer | Post (delivered live via `message:new`) |
| PATCH \| DELETE | `/messages/:id` | bearer | Edit / soft-delete your message |
| POST | `/messages/:id/reactions` \| `/chats/:id/read` | bearer | React / mark read |
| WS | `/chat` (Socket.IO) | handshake JWT | `join_chat`, `typing`; server pushes `message:new`, `reaction:changed`, `read`, `presence` |
| GET | `/notifications` | bearer | Your in-app notifications (newest first) |
| POST | `/notifications/:id/read` \| `/read-all` | bearer | Mark one / all read |
| GET \| PATCH | `/notifications/preferences` | bearer | Channels, quiet hours, timezone, thank-you auto-send |
| GET | `/notifications/unsubscribe/:token?category=` | public | One-click email unsubscribe (from the footer) |
| POST | `/webhooks/notifications/bounce` | secret | Suppress a bounced/complained address |
| GET | `/thank-you` \| `/thank-you/:id` | bearer | List / preview thank-you notes |
| PATCH \| POST | `/thank-you/:id` \| `/:id/send-now` \| `/:id/skip` | bearer | Edit / send now / skip before it auto-sends |
| POST | `/reels` \| `GET /reels` | bearer | Start a birthday reel / list yours |
| GET | `/reels/:id` | bearer | Metadata only until released, then the reel |
| POST | `/reels/:id/wishes` | bearer | Add a text/audio/video wish (ffprobe-validated) |
| POST | `/reels/:id/wishes/:wishId/moderate` | bearer | Approve / reject a wish (initiator) |
| POST | `/reels/:id/regenerate` \| `/share` | bearer | Recompile / configure the share link |
| GET | `/public/reels/:slug` \| `/preview` | public | Shared reel + OG preview (locked until release) |
| GET | `/health` \| `/ready` | public | Liveness / readiness |

### Events & invites

An event is a **draft** until published; publishing enables invites and schedules the three reminders (T-7d / T-1d / T-2h). Moving the date reschedules them all — cancel-then-re-add, never a no-op, or the old schedule would silently stick. Reminders re-check the event's current start time before firing, so a stale job announces itself instead of emailing the wrong date.

**Invites dedupe, they don't reject.** A guest list comes from someone's contacts, where the same person appears twice and re-inviting a guest by accident is normal — so duplicates are collapsed at three layers (in-request, existing-lookup, and a partial unique index for the concurrent race), never failed. A guest can **RSVP without an account**: requiring a signup to answer a party invitation is the fastest way to collect no RSVPs.

**The invite card is a rendered PNG.** Host copy is composed into SVG (escaped — it is untrusted), rasterized with `@resvg/resvg-js`, and stored content-addressed. PNG, not SVG, because unfurlers don't render SVG and serving user-influenced SVG from our origin would be stored XSS.

**`event_only` wishlists** open to an invitee only once they RSVP yes/maybe — resolved live through [AccessPolicyService](src/modules/wishlists/access/access-policy.service.ts), the same chokepoint as everything else. Attaching a wishlist to an event sets `wishlist.eventId` (the pointer the policy reads); detaching clears it, revoking the access.

### Products & affiliate

The affiliate network **is not chosen yet**. Everything is written against [IProductProvider](src/modules/products/providers/product-provider.port.ts) and backed by a fixture catalogue, so adding the real network is one adapter plus a config value. `PRODUCT_PROVIDER=fixture` **fails the boot in production** — invented products with dead links must never reach users.

**Import snapshots, it does not reference.** The item gets its own copy of the title, price, image, and link. Storing only `sourceProductId` and joining at read time would be tidier and wrong: the catalogue is someone else's mutable data, and a user who added "Blue headphones, ₹2,499" must keep seeing that after the merchant renames the listing or reuses the id. The nightly sync *flags* drift on the item (`sourceAlert`) and never rewrites the snapshot.

**Search is stale-while-error.** Results are fresh for 15 min and servable for 24 h. The windows do different jobs: freshness is price accuracy; staleness is still having a search during someone else's outage. `freshness: live | cached | stale` says which you got. With nothing cached it is a 503 with a reason, never a 500.

Four resilience controls, none redundant: a **Redis** rate limiter (the vendor quota is per-account, so a per-pod limiter would let N pods spend N× the budget), a timeout, jittered retries (a fixed backoff makes every pod retry in lockstep and re-floor a recovering provider), and a **per-instance** circuit breaker (each pod protects itself from the wait; coordinating it would add a Redis hop to the hot path).

### SSRF

`POST /products/resolve-url` makes **our server** fetch a link the user chose, from inside the VPC, holding an instance role. [SsrfGuard](src/common/net/ssrf-guard.ts) blocks by **resolved address, never hostname** — a hostname denylist is theatre, since `localtest.me` resolves to 127.0.0.1 and an attacker controls their own DNS. It blocks loopback, private, link-local (**`169.254.169.254` is the cloud metadata service — it hands out IAM credentials to anything on the instance**), CGNAT, multicast, IPv6 equivalents, and v4-mapped-v6 (`::ffff:127.0.0.1`). Every redirect hop is re-vetted, and the request connects to the *vetted IP* with the original Host header, closing the DNS-rebinding window.

`PRODUCT_URL_ALLOW_PRIVATE` disables those address checks so tests can use a loopback origin. **Joi refuses to boot production with it on.**

### Wishlist access

[AccessPolicyService](src/modules/wishlists/access/access-policy.service.ts) is the **single chokepoint** deciding `canView / canComment / canGift / canManage`. Sprints 6 (gifting) and 8 (chat) authorize through it too — nothing re-implements it, because four copies of "is this person allowed" is four chances to leak a surprise gift.

| visibility | owner | participant | event invitee | link holder | stranger |
|---|---|---|---|---|---|
| `public` | VCM | VCG | VCG | VG(+C) | V(+G) |
| `private` | VCM | VCG | — | — | — |
| `event_only` | VCM | VCG | VCG | — | — |
| `invite_only` | VCM | VCG | — | VG | — |

V=view C=comment G=gift M=manage. Resolution is priority-ordered (owner → participant → event → link → public), so an owner arriving via their own link is still an owner.

**The policy caches nothing, deliberately.** Revoking a participant or rotating a slug must take effect on the *next* request; a TTL would mean a removed person keeps reading a private list for a minute. If the two indexed lookups ever become the bottleneck, cache the wishlist document — never the decision.

### Gifting & reservations

**Reserving is the one concurrency-critical path, defended in three layers.** A Redis lock on `gift-item:{id}` serializes the common case; a Mongo transaction re-reads the item's status *inside* the lock so the check-then-act is atomic; and a **unique partial index on `(itemId, active)`** is the actual guarantee. The layers are ordered deepest-last on purpose: the lock is a performance measure, not a correctness one, so a caller that cannot take it proceeds anyway and lets the index arbitrate (`withBestEffortLock`). This is why 50 simultaneous reservers resolve to exactly one success and forty-nine typed conflicts rather than a scattering of lock-timeout errors — verified against a real replica set, not just the in-memory harness. `active` is `$unset` (not set to `false`) on cancellation so a released reservation drops out of the index and frees the item.

**One writer owns gift status.** [GiftStatusService](src/modules/gifting/gift-status.service.ts) is the only thing that writes `gift.status` or the mirrored `item.status`; the state machine is a data table ([gift.types.ts](src/modules/gifting/gift.types.ts)) and any move not in it throws a typed error. Gift status is money-adjacent and mirrored onto the item, so two writers would be two chances to leave them out of sync.

**Auto-ticking is signed, replay-proof, and never drops a signal.** `POST /webhooks/affiliate/:provider` verifies an HMAC over the **raw** request bytes (`timingSafeEqual`), inside a timestamp tolerance window, with a Redis nonce for fast replays and a durable unique `(provider, providerEventId)` index for slow ones. `order → purchased`, `shipment → fulfilled`; a shipment that beats its order still converges (it walks the gift through `purchased` first, because a shipment proves the purchase). A signature-valid event that matches no gift is **dead-lettered** for admin review, never silently discarded. The raw body is captured with Nest's `rawBody: true` — the global JSON parser runs before any middleware, so a re-serialized body would break every real signature.

**A reservation is a surprise by default.** When `hidden_from_owner`, the item is visibly locked to other viewers but reads `available` to the wishlist owner — masked through a denormalized `activeGiftVisibility` on the item, so gifting never has to query back into wishlists (that would be a module cycle). `GET /gifts/received` withholds a still-in-progress hidden gift for the same reason: it appears only once it is openly `visible` or has reached `fulfilled`/`completed`.

### Group gifting

**A group gift claims its item through a holder gift.** Creating one runs the *same* critical section as a single reservation — same `gift-item:{id}` lock, same unique `(itemId, active)` index, same `GiftStatusService` — by minting a holder `Gift` (`type: group`). So a group gift and a single reservation, or two group gifts, can never both hold one item, guaranteed by the database rather than a second hand-rolled lock. The `GroupGift` and `Contribution` documents track funding; the holder tracks the item and drives it through purchase and cancellation.

**Contributions sum exactly, under any concurrency.** `POST /group-gifts/:id/contribute` runs `withBestEffortLock` + a Mongo transaction + a `$inc` on the collected total. Every contribution to a gift writes the same document, so a second concurrent transaction conflicts on commit and retries against the updated total — that write-conflict-and-retry is the counter's hard guarantee, the way the unique index is the reservation's. **The source of truth is the sum of `confirmed` contributions**, not the `collectedAmount` cache; a nightly reconciler re-sums, corrects the cache to the truth on any drift, and fires a loud `group_gift.drift_detected` event so a self-heal is never silent. Durable idempotency comes from a unique `(groupGiftId, idempotencyKey)` index behind the 24h HTTP interceptor.

**Over-target money is never silently accepted.** A group is either `cap` (trim the contribution to what's left, landing exactly on target) or `reject` (bounce anything over). Once funded, contributions close.

**Anonymity is enforced by construction.** `participantIds` only ever holds joiners and non-anonymous contributors, so no participant projection — authenticated, public, or share card — can leak someone who chose to be anonymous. `contributorCount` still counts them, because a headcount is not an identity. Contributions are `confirmed` on creation (no payment processor yet; `pledged`/`paymentRef` await one), and cancelling records an immutable refund audit rather than a real charge-back.

### Chat

**One Socket.IO gateway, scaled by Redis from day one.** The `/chat` namespace authenticates at the handshake — the token runs through the *same* checks as a REST request (`SocketAuthService` → `JwtStrategy.validate`: denylist, account status, logout-all cutoff) — and a bad token is refused before the socket connects. A `@socket.io/redis-adapter` backs it, so a message posted on one instance reaches clients on every instance (verified with two real `node` processes behind one Redis).

**Messages are posted over REST, delivered over the socket.** `POST /chats/:id/messages` is the single authored path; ChatService then emits an internal `chat.broadcast` that the gateway fans out as `message:new`. REST and socket therefore share one validation, authorization, rate-limit, and anti-spoiler path — they cannot drift. History is cursor-paginated on `_id` (`{ items, nextCursor }`), and unread counts derive from a per-user read receipt, not a per-message fan-out.

**Authorization is the same chokepoint.** A wishlist chat defers to `AccessPolicyService` (`canView` to read, `canComment` to post); a group-gift chat defers to the gift's participation, with the recipient excluded whenever the gift is a surprise. Revoking a wishlist participant emits an event that force-disconnects their sockets across every instance (`socketsLeave` through the adapter) and closes their history reads.

**The owner never sees a surprise.** A surprise-flagged message carries the owner in `hideFromUserIds`; the history query filters it and the broadcast excludes the owner's personal room (`.except(user:{id})`). Server-side on both paths.

**System messages are exactly-once.** The group-gift chat subscribes to domain events (`group_gift.funded`, `contribution_received`, `joined`, `purchased`, `fulfilled`) and posts a structured `systemPayload` for the client to localize. Each carries a `dedupeKey` on a unique partial index, so a redelivered event — or a retried job once Sprint 9 wraps these in a queue — is a silent no-op.

### Notifications

**One registry drives the fan-out.** Every domain event prior sprints have been emitting and deferring (`user.registered`, `gift.reserved/purchased/fulfilled`, `group_gift.*`, `event.reminder_due`, `product.price_changed/out_of_stock`) is now consumed by a listener that enqueues a `dispatch` job on `QUEUE.NOTIFICATIONS`. `NOTIFICATION_SPECS` maps each type → channels, priority, unsubscribe category, and template — so the dispatcher reads a table instead of branching, and a new notification is one row.

**Exactly-once, by a durable ledger.** Dispatch is single-stage: one job fans across in-app / email / SMS, and each channel first claims a `DeliveryLog` row on a unique `(userId, type, refId, channel)` key. A retried BullMQ job re-runs dispatch and every already-`sent` channel is skipped — verified with the real worker, not just the harness. The in-app notification carries its own unique `(userId, dedupeKey)` for the same reason.

**Preferences the pipeline actually honors.** Quiet hours **defer** a non-critical email/SMS (re-enqueued delayed) rather than dropping it — the in-app still lands at once; a one-click **unsubscribe** flips `{category}:email` off and the next dispatch suppresses it within the request; **critical** security mail bypasses both. Bounced addresses are suppressed via a webhook. Email is MJML (text always present, all copy snapshot-tested); SES and a fetch-based SMS gateway sit behind the same ports as the dev console driver.

**Automated thank-you notes.** A fulfilled gift drafts a note (recipient/gifter names, item, optional event context) and schedules it to auto-send after 24h; the recipient can preview, edit, `send-now`, or `skip` first, and it routes to the gifter through the same pipeline — so their suppression and consent still apply.

### Reels

**The time-lock is one code path, not a guard per endpoint.** Friends submit text/audio/video wishes to a collection that stays sealed until the recipient's local midnight. `toReelView`/`toPublicReelView` are the *only* code that can project wish content, and they attach it exclusively when `status === released` — so the initiator's view, the recipient's own view, the share link, and the OG preview all return counts and contributor first names and nothing else while locked. A new endpoint cannot leak by omission.

**Release is timezone-correct and DST-aware.** `releaseAt` is the recipient's local midnight as a UTC instant, computed from `Intl.DateTimeFormat` offsets (with a second pass that pins DST boundaries) — no date library. A delayed scheduler job fires there, seals the collection, and hands off to the reels queue; it is staleness-guarded, so a moved birthday doesn't fire the old job.

**Compilation: normalize, concat-copy, one final pass.** The dedicated `reels` worker (bounded concurrency — ffmpeg is CPU-heavy) renders each wish to a clip normalized to one canonical geometry/codec/timebase (text and audio wishes get resvg-rendered cards), joins them with the concat demuxer in **copy** mode, then re-encodes exactly once to overlay the watermark and mix a music bed. Every ffmpeg step is an isolated child process with a hard SIGKILL timeout. **Submission validation is ffprobe reading the real streams** — an audio file declared as a `video` wish is rejected because there is no video track, which is MIME sniffing by content rather than by header.

**Temp hygiene survives a kill.** The per-collection scratch dir is wiped *before* a render starts — clearing any orphan a SIGKILLed attempt left, since `finally` cannot run through a kill — and again in a `finally` on every exit path. A single unprocessable wish is skipped and logged; the reel still ships with the rest. Retries exhausted → `failed` with a reason, never a half-rendered reel.

### Admin, moderation & analytics

Two user-facing routes feed the operator plane; everything else lives under `/admin` behind a **separate** auth.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/reports` | bearer (user) | Report content or a user for review |
| POST | `/events/track` | bearer (user) | Record a batch of analytics events |
| POST | `/admin/auth/login` | public | Admin login (password + TOTP once enrolled) |
| POST | `/admin/auth/logout` | admin | End this admin session (denylists the jti) |
| GET | `/admin/auth/me` | admin | The authenticated admin |
| POST | `/admin/auth/totp/setup` \| `/totp/enable` | admin | Enroll + confirm 2FA |
| POST \| GET | `/admin/admins` | admin `admins:manage` | Create / list admins |
| GET | `/admin/users` \| `/users/:id` | admin `users:view` | Search users / full profile + counts + activity |
| POST | `/admin/users/:id/suspend` \| `/reactivate` \| `/force-logout` | admin `users:manage` | Kill or restore an account |
| GET | `/admin/moderation/queue` | admin `moderation:view` | The report queue, severity- then age-ordered |
| POST | `/admin/moderation/reports/:id/act` | admin `moderation:act` | `approve` \| `remove` \| `flag` \| `escalate` |
| GET | `/admin/analytics/overview` \| `/acquisition` \| `/engagement` | admin `analytics:view` | DAU/WAU/MAU, sources, creation/fulfilment |
| GET | `/admin/audit` | admin `audit:view` | The append-only audit trail |

**Admin auth is a different audience, not a role bit.** Admin tokens are signed with the admin secret and a distinct JWT `aud` (`wishtick-admin`); passport rejects a wrong audience *before* `validate()` runs, so a user token can never authenticate on `/admin` and vice versa. Admin controllers are `@Public()` (the global user guard skips them) and `AdminGuard` is the sole gate — it runs the `admin-jwt` strategy, then checks the route's `@RequirePermission(...)` against the admin's permissions. Routes assert a *permission*, never a role, so the role→permission matrix ([admin.types.ts](src/modules/admin/admin.types.ts)) is the one place that decides who can do what. Sessions are short (2 h), revocable (logout denylists the jti; stamping `tokensInvalidBefore` kills every outstanding token), and 2FA is mandatory once enrolled.

**Suspension is the revocation chain, reused.** Suspending sets `status` + `tokensInvalidBefore` and calls `revokeAllForUser`, then emits `USER_FORCE_DISCONNECT` — the chat gateway turns it into `disconnectSockets(true)`, cross-instance via the Redis adapter. The account's next REST call is refused and its live sockets close.

**Every mutation is audited with a readable diff.** `AuditService` writes an append-only `AuditLog` entry — actor, action, target, a per-field before/after diff, IP — and there is no update or delete path. Moderation removal does the right per-type takedown (soft-hide a message, reject-and-regenerate a wish in a released reel, clear a reel's media, archive a wishlist, cancel an event, suspend a user) and notifies the owner; reports dedupe on a unique `(source, target, reporter)` index.

**Analytics never scans raw events.** `POST /events/track` appends to an append-only `AnalyticsEvent` stream (180-day TTL); the `analytics-rollup` worker pre-aggregates it into `MetricDaily`, and dashboards read the rollup (or domain collections for engagement), cached 5 minutes. DAU/WAU/MAU are distinct-active-user counts; attribution (`User.acquisition`) is captured at signup, in the write path. See [analytics.service.ts](src/modules/analytics/analytics.service.ts).

### Uploads

Bytes never pass through this API. `POST /media/upload-url` returns a short-lived `uploadUrl`; the client PUTs the file straight to storage with the returned `requiredHeaders`, then calls `POST /media/confirm`.

**Confirm is the security boundary.** Everything the client said when asking for the URL was a *claim* — a presigned URL grants a real write, so a client that asked for a 2 MB JPEG can still PUT a 50 MB executable. Confirm HEADs the object and enforces the per-purpose allowlist against what was *actually* stored, deleting anything that violates it. Attaching media (e.g. `photoMediaId`) additionally requires that the caller owns it, has confirmed it, and uploaded it for that purpose.

`STORAGE_DRIVER=local` (the default) signs uploads to this API's own disk so the flow works in dev without AWS. It is refused in production.

### Response shape

Success:

```json
{ "success": true, "data": { }, "requestId": "…", "timestamp": "…" }
```

Failure:

```json
{ "success": false, "error": { "code": "INVALID_CREDENTIALS", "message": "…" }, "requestId": "…" }
```

**Branch on `error.code`, never on the message or the status alone.** Codes are append-only and listed in [src/common/errors/error-codes.ts](src/common/errors/error-codes.ts). Pass `X-Request-Id` to correlate a request with server logs; it is echoed on every response.

## Architecture

```
src/
├── config/          Env schema (Joi) + typed config
├── common/          Guards, filters, interceptors, decorators, validators, error codes
├── infra/           Mongo, Redis (cache/locks), BullMQ, migrations, notifier + storage ports
└── modules/
    ├── auth/        Signup, login, tokens, OTP, password reset, sessions
    ├── users/       User schema + lookups
    ├── profile/     /me, preferences, account lifecycle (delete/restore/anonymize)
    ├── onboarding/  Server-driven steps, options, completion
    ├── taxonomy/    The seeded option catalogue behind every preference
    ├── media/       Presigned uploads, confirmation, local dev driver
    ├── wishlists/   Wishlists, items, participants, share links, AccessPolicy
    ├── products/    Catalogue search, affiliate import, sync, click tracking
    ├── events/      Events, invites, RSVP, reminders, invite-card rendering
    ├── gifting/     Reservations, offline gifts, state machine, auto-tick webhook
    ├── group-gifts/ Group gifts, contributions, funding machine, reconciler, OG card
    ├── chat/        Socket.IO gateway, messages, read receipts, system messages
    ├── notifications/ Fan-out queue, channels, preferences, digest, thank-you notes
    ├── reels/       Wish collection, time-locked release, ffmpeg compilation
    ├── analytics/   Event stream, rollup worker, DAU/WAU/MAU + acquisition
    ├── admin/       Separate-audience admin auth, moderation hub, audit log
    ├── dashboard/   The 12-section summary
    └── health/      Liveness/readiness probes
```

Auth is **deny-by-default**: `JwtAuthGuard` is global and routes opt out with `@Public()`. Forgetting the decorator makes a route private, which fails safe.

### Security decisions worth knowing

These are deliberate and load-bearing; read the comments before changing them.

- **Refresh rotation with reuse detection.** Rotated tokens are kept as tombstones, not deleted. Replaying one revokes the whole family — we cannot tell the thief from the victim, so both re-authenticate. Only a token revoked with reason `rotated` counts as reuse; other revocations report `TOKEN_REVOKED`.
- **`ims`, not `iat`.** Access tokens carry a millisecond issue time. Standard `iat` has second granularity and cannot distinguish a token minted just before a logout-all from one minted just after a legitimate re-login, forcing a choice between a live revoked token and a login loop.
- **Login is enumeration-resistant.** Unknown user and wrong password return the identical code and message, and the unknown-user path verifies against a decoy hash so the timing matches. Account status is checked only *after* the password verifies.
- **OTP confirm is throttled looser than it is attempt-capped.** The HTTP bucket (10/5min) sits above `OTP_MAX_ATTEMPTS` (5) on purpose: if the throttle bit first, the per-code counter could never burn the code, and the weaker control would mask the stronger one.
- **Throttle records are keyed `default`.** `@Throttle({ default: … })` must match the throttler name registered in `AppModule`. A name matching no registered throttler is silently ignored, and the route quietly keeps the global limit.
- **Password reset ends every session** and stamps `tokensInvalidBefore`, because a reset is how a victim evicts an attacker.
- **Admin access is a separate audience, not a claim on the user token.** `/admin` runs a distinct passport strategy keyed to the admin secret *and* a distinct `aud`; passport rejects a mismatched audience before `validate()`, so no amount of role-tampering on a user token reaches an admin route. Admin routes assert a *permission* (`@RequirePermission`), never a role — the matrix is the single source of authority. Enrolled 2FA is mandatory, and TOTP is a self-contained RFC 6238 implementation over `node:crypto` (no third-party OTP dependency to interop-break at boot).
- **Suspension enforces at the token layer *and* the socket layer.** `status` + `tokensInvalidBefore` block the next request; a `USER_FORCE_DISCONNECT` event closes live sockets across instances. A websocket cannot outlive the revocation that killed the REST session.
- **Operator-injection is rejected, not stripped.** `NoSqlInjectionGuard` (the first global guard, ahead of auth) refuses any request whose body or query carries a `$`-prefixed key. It is defence-in-depth over the DTO whitelist — covering query strings and `Mixed` fields a DTO cannot — and it *rejects* (a logged `400`) rather than silently stripping, so an attempt is visible. A `$` inside a value is fine; only keys are dangerous.
- **Rate limiting is the Redis-backed `ThrottlerGuard`, deliberately not `express-rate-limit`.** A per-process in-memory limiter would let an attacker multiply their budget by the pod count; the throttler shares one counter across pods. It *is* the edge limiter.
- **Every user store is TTL-bounded.** Analytics events, click events, delivery logs, refresh/reset tokens, and (as of Sprint 12) in-app notifications carry TTL indexes; OTPs and sessions live in Redis with native expiry. Notification retention is deploy-configurable (`NOTIF_RETENTION_DAYS`) with the schema and migration reading the same value so they never disagree.
- **Account deletion is two-phase.** Soft delete ends every session and hides the account everywhere; erasure runs after a 30-day grace window. Deleting immediately means one accidental tap destroys a user's gifting history; never deleting means holding PII forever. The anonymization job re-checks that the account is still deleted and that its `deletedAt` still matches the value captured when the job was queued — it is the one operation with no undo, so it must be safe to deliver twice, late, or after a restore.
- **Timezones are validated by asking ICU to resolve them,** never against `Intl.supportedValuesOf('timeZone')`. That list is one ICU build's canonical set and omits the names browsers actually report — see [is-timezone.validator.ts](src/common/validators/is-timezone.validator.ts).
- **Mongo types come from Mongoose's `mongo` re-export, never `import from 'mongodb'`.** `mongodb` is not a declared dependency and two copies exist, so a direct import compares against the wrong error classes.
- **ObjectId reference fields declare `type: SchemaTypes.ObjectId`, never `Types.ObjectId`.** `Types.ObjectId` is the BSON *value* class; with current `bson` (where `ObjectId` is a real `class`), `@nestjs/mongoose` mis-reads it and silently registers the field as `Mixed`, so string-form queries never cast and quietly match nothing. The property *type annotation* still uses `Types.ObjectId` — only the `@Prop({ type })` differs.

## Testing

```bash
npm test          # unit + integration
npm run test:e2e  # full HTTP stack
```

E2E boots the real pipe/filter/guard chain against in-memory Mongo and Redis. The rate-limit tests assert the **real production buckets** from `AuthController` rather than synthetic limits, so a mis-wired `@Throttle` fails the suite.

One trap worth knowing: `ThrottlerStorageRedisService` only adopts a client passing `instanceof Redis`. Anything else — including `ioredis-mock` — it treats as connection *options* and silently builds a real ioredis client from, which then talks to whatever Redis is running on the machine. Tests therefore use the default in-memory throttler storage. See [test/utils/test-app.ts](test/utils/test-app.ts).

## Conventions

- Every list endpoint paginates; no unbounded `find()` reaches production.
- Nothing user-controlled is interpolated into a Mongo query — DTO-validated fields only.
- Every cached value carries a TTL (`CacheService.set` has no infinite-TTL overload).
- Every queue job is idempotent with a retry policy and a DLQ.
- Application code throws `AppException` with an `ErrorCode`; nothing else reaches the client.

## Roadmap

Sprints 1–11 are **complete** — see [sprints.md](sprints.md). Sprint 6 (single gifting) is where `LockService` (built in Sprint 1) finally got a caller, defended by a Redis lock, a Mongo transaction, and a unique partial index. Sprint 7 (group gifting) reused that critical section and added a concurrency-exact contribution counter. Sprint 8 (chat) added the realtime dimension behind a Redis-adapter-scaled Socket.IO gateway. Sprint 9 (notifications) wired `QUEUE.NOTIFICATIONS` and consumed every domain event the prior sprints had been emitting and deferring. Sprint 10 (reels) lit up the last reserved queue: wishes collected behind a server-enforced time-lock, released at the recipient's DST-correct local midnight, and compiled by a real ffmpeg pipeline — proven with a 40-wish mixed-format reel rendered in 62s. Sprint 11 (admin panel) added a separate-audience operator plane: the moderation hub that finally consumes the flags earlier sprints left behind (chat's `CONTENT_FLAGGED`, the reel `moderationStatus` gate), suspension that kills sockets as well as sessions, an append-only audit trail with per-field diffs, and analytics rollups on the last reserved queue — DAU/WAU/MAU proven against a raw recount by the real BullMQ worker.

Sprint 12 (hardening, performance & launch readiness) closed out the backend-codeable scope: a NoSQL-injection guard, response compression, a GDPR export (`GET /me/export`), the last retention gap (a notification TTL index) closed, env-tunable connection pool + worker concurrency, and Swagger tag completeness — proven on real infra alongside helmet, gzip, and a clean draining shutdown. Operational runbooks (deploy, rollback, incident, on-call), an env reference, and a ready k6 load-test script live under [`docs/`](docs/).

**The MVP backend is feature-complete** across all twelve sprints — see the launch checklist in [sprints.md](sprints.md). The remaining launch work is *process*, not backend code: a third-party penetration test, the k6 run itself, an Atlas backup/restore drill, a secrets-manager migration, Sentry alert rules, and the bug-bash week.
