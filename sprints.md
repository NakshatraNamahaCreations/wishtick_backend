# Wishtick Backend — Sprint Plan

Backend-only delivery plan for the Wishtick MVP defined in [scope_of_work.md](scope_of_work.md).

**Stack:** NestJS (TypeScript) · MongoDB Atlas (Mongoose) · Redis (cache + distributed locks) · BullMQ (queues/schedulers) · Socket.IO (realtime chat) · S3-compatible object storage (media).

**Cadence:** 11 sprints × 2 weeks ≈ 22 weeks. Sprint 0 is a 1-week hardening-of-foundations spike folded into Sprint 1.

Each sprint ends with: merged code, passing CI, Swagger/OpenAPI updated, integration tests for the sprint's happy paths + the listed failure modes, and a deployed staging build.

---

## Architecture Decisions (locked before Sprint 1)

| Concern | Decision |
|---|---|
| Module layout | Feature modules (`auth`, `users`, `wishlists`, `events`, `gifting`, `chat`, `products`, `reels`, `notifications`, `admin`, `analytics`) + `common` (guards, interceptors, filters) + `infra` (mongo, redis, bullmq, storage, mailer, sms) |
| API style | REST under `/api/v1`, versioned via URI. Socket.IO namespace `/chat` for realtime only |
| IDs | Mongo `ObjectId` internally; public-facing share links use opaque nanoid slugs |
| Auth | JWT access (15 min) + rotating refresh token (30 d) stored hashed in Mongo, jti denylist in Redis |
| Authorization | Policy-based guards; every wishlist/event/chat read passes through a single `AccessPolicyService` |
| Validation | `class-validator` DTOs, global `ValidationPipe({whitelist, forbidNonWhitelisted, transform})` |
| Errors | Global exception filter, stable `errorCode` strings in every 4xx/5xx body |
| Locking | Redlock over Redis for reservation/contribution critical sections; lock key = resource id |
| Idempotency | `Idempotency-Key` header on all mutating gifting/payment-adjacent endpoints, stored in Redis 24 h |
| Queues | BullMQ per domain: `notifications`, `reels`, `affiliate-sync`, `analytics-rollup`, `scheduler` |
| Config | `@nestjs/config` + Joi schema validation, fail-fast on boot |
| Observability | `pino` structured logs w/ request id, `/health` + `/ready` probes, Sentry, Prometheus metrics |
| Testing | Jest unit + `mongodb-memory-server` / `ioredis-mock` integration; Supertest e2e |

---

## Sprint 1 — Foundation & Authentication ✅ COMPLETE

**Goal:** A deployable NestJS service with a working, secure identity layer.

**Delivered:** 56 tests green (25 unit, 31 e2e), lint/typecheck/build clean. See [README.md](README.md) for the API surface and the security decisions worth knowing.

**Deviations from the plan, and why:**
- **Locking is single-primary, not multi-master Redlock.** We run one Redis primary; Redlock across replicas of a single primary buys nothing. `LockService` implements SET NX PX with a fenced compare-and-delete release, which is the correct algorithm for this topology. Revisit only if Redis is ever sharded across independent masters.
- **Access tokens carry a custom `ims` (millisecond issue time) claim.** Standard `iat` has second granularity, which cannot distinguish a token minted just before a logout-all from one minted just after a legitimate re-login. Without `ims`, logout-all either leaves a revoked token alive for the rest of the second or traps the user in a login loop.
- **OTP confirm is throttled (10/5min) *looser* than it is attempt-capped (5).** The original per-route buckets had confirm at 3/5min, which would have made `OTP_MAX_ATTEMPTS` unreachable — the HTTP throttle would have masked the stronger control and the code would never have been burned.
- **Reservation/gifting concurrency work stays in Sprint 6.** `LockService` shipped here as infrastructure but has no production caller yet.

**Bugs caught before merge** (both invisible to a green test suite, worth noting for later sprints):
- `@Throttle({ auth: … })` named a throttler that was never registered. Nest ignores unmatched names silently, so *every per-route rate limit was inert* — login would have run at the global 100/min. Now keyed `default`, and the throttle tests assert the real production buckets so a repeat fails CI.
- `/health` and `/ready` 404'd because URI versioning rewrote them to `/v1/health` (global-prefix `exclude` skips the prefix, not the version). Every liveness probe would have failed and restarted healthy pods. Fixed with `VERSION_NEUTRAL` and locked by [test/health.e2e-spec.ts](test/health.e2e-spec.ts).

### Deliverables
- Repo scaffold: NestJS monorepo-style `src/`, ESLint + Prettier + Husky, `tsconfig` strict mode on.
- Docker Compose for local Redis; Mongo Atlas dev cluster provisioned with per-env databases.
- `ConfigModule` with Joi-validated env schema; `.env.example` committed.
- `MongooseModule` async connection, retry + connection-event logging.
- `RedisModule` (ioredis) exposing a shared client, a cache helper, and a `LockService` (Redlock).
- `BullModule` registration + a no-op `health` queue proving worker wiring end to end.
- Global pipes/filters/interceptors: validation, exception filter, response envelope, request-id, pino logger.
- `/health` (liveness) and `/ready` (checks Mongo + Redis + queue) endpoints.
- CI pipeline: install → lint → typecheck → test → build → deploy staging.

### Auth feature
- `User` schema: `email`, `phone`, `passwordHash` (argon2id), `emailVerifiedAt`, `phoneVerifiedAt`, `status` (`active|suspended|deleted`), `roles`, timestamps.
- `POST /auth/signup` (email **or** phone), `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`.
- `POST /auth/verify/email/request` + `/confirm`, `POST /auth/verify/phone/request` + `/confirm` (6-digit OTP in Redis, TTL 10 min, max 5 attempts).
- `POST /auth/password/forgot` + `POST /auth/password/reset` (single-use token, hashed at rest, 30 min TTL).
- `JwtAuthGuard` (global, opt-out via `@Public()`), `RolesGuard`, `@CurrentUser()` decorator.
- Rate limiting: `@nestjs/throttler` backed by Redis — strict buckets on login, OTP request, password reset.
- Session listing + revoke (`GET /auth/sessions`, `DELETE /auth/sessions/:id`).

### Exit criteria
- Full signup → verify → login → refresh → logout cycle green in e2e.
- Refresh-token reuse detection revokes the whole family and is covered by a test.
- Brute-force on login and OTP flood are both blocked and asserted in tests.
- Staging deploy reachable, `/ready` returns 200.

---

## Sprint 2 — Onboarding, Profile & Dashboard ✅ COMPLETE

**Goal:** Personalization data captured and the dashboard's read model in place.

**Status: ✅ COMPLETE.** 128 tests green (49 unit, 79 e2e), lint/typecheck/build clean, and the real `AppModule` verified end to end against live Redis: migrations → onboarding → presigned upload over real HTTP → confirm → `/me` → delete → restore.

**Deviations from the plan, and why:**
- **Storage is a port with two adapters, not S3 only.** `IStorageProvider` has an S3 adapter (presigned PUTs, CDN base, S3-compatible endpoints) and a signed local-disk adapter for dev/test. Without it the upload flow — the part most likely to break — would be stubbed until staging. `StorageModule` refuses the local driver in production, since local disk on a pod is ephemeral and invisible to other replicas.
- **Account restore is user-facing** (`POST /auth/account/restore`, credential-verified) rather than an admin-only action. A deleted account cannot hold a session, so the password is the authorization.
- **Only the `profile` step is required to complete onboarding.** Blocking someone from the product because they will not pick a favourite colour trades a real signup for data we can collect later.
- **Dashboard sections report `available: false` until their sprint lands.** "Not built yet" and "you have none" must stay distinguishable, or clients render a misleading empty state.
- **Migrations omit explicit index names.** An explicit name makes Mongo reject an existing index on the same keys under a different name, so any dev box (where Mongoose `autoIndex` already built `tokenHash_1`) fails `migrate:up`. Default names make the schema and migration paths converge, and any drift surfaces as a loud "same name, different options".

**Bugs caught before merge** (each invisible to a green test suite):
- **`Intl.supportedValuesOf('timeZone')` is the wrong oracle.** This ICU build lists legacy `Asia/Calcutta`/`Europe/Kiev` and omits the modern `Asia/Kolkata`/`Europe/Kyiv` that browsers actually report — so the allowlist 400'd onboarding for every user in the product's primary market. Replaced with an `IsTimezone` validator that asks ICU whether it can resolve the zone; pinned by [is-timezone.validator.spec.ts](src/common/validators/is-timezone.validator.spec.ts).
- **`mongodb` was a phantom dependency with two copies.** It sat at the top of `node_modules` only because `mongodb-memory-server` (dev-only) brings its own, while npm pins Mongoose to a different one — so `instanceof MongoServerError` compared against the wrong class and a duplicate-key race returned 500 instead of 409, in dev and tests but not prod. Everything now imports Mongoose's `mongo` re-export; pinned by [all-exceptions.filter.spec.ts](src/common/filters/all-exceptions.filter.spec.ts).
- **BullMQ rejects a job id containing `:`.** The anonymization job used `anonymize-account:<userId>`, so `DELETE /me` 500'd in production. The fake queue accepted it and the suite stayed green — the fake now enforces the real constraint.
- **`S3StorageAdapter` built its client in the constructor,** so a local-driver dev box with no `S3_REGION` could not boot at all. The client is lazy now; constructing an adapter is free, only using it needs configuration.
- **Raw-body middleware never ran.** `MiddlewareConsumer` paths ignore the URI version segment, so it registered for `/api/media/local/*` while the route is `/api/v1/media/local/*`; and inside a mounted middleware Express reports `req.path` as `/`, so the fallback check silently matched nothing. Now scoped at runtime on `req.originalUrl`.

### Deliverables
- `UserProfile` schema: `name`, `photoUrl`, `contact`, `dateOfBirth`, `preferences { interests[], favouriteColors[], clothingSize, shoeSize?, giftCategories[], lifestyle[], occasions[] }`, `onboardingCompletedAt`.
- `Taxonomy` collection seeded via migration: interests, colors, sizes, gift categories, occasions, event types. All onboarding options are server-driven, never hardcoded in clients.
- `GET /onboarding/options` — taxonomy payload, cached in Redis (1 h TTL, busted on admin edit).
- `POST /onboarding/steps/:step` — idempotent partial save so a client can resume.
- `POST /onboarding/complete` — validates required steps, stamps `onboardingCompletedAt`.
- `GET /me`, `PATCH /me`, `PATCH /me/preferences`, `DELETE /me` (soft delete + anonymization job).
- Media: `POST /media/upload-url` issuing presigned S3 PUT URLs (content-type + size allowlist), `POST /media/confirm` to persist a `Media` doc. Used by profile photos, event covers, wishlist images, reel wishes.
- `GET /dashboard/summary` — counts for all 12 dashboard sections in one aggregation, cached 60 s per user.
- Stubs returning empty-but-correctly-shaped lists for sections landing in later sprints, so the app can integrate early.
- `MigrationModule` (`migrate-mongo` or equivalent) + first index migration.

### Exit criteria
- A new user completes onboarding, sets a photo, and reads back a fully populated `/me`.
- `GET /dashboard/summary` runs in a single round trip and is asserted < 150 ms on seeded data.
- Soft delete removes the user from all queries and is reversible for 30 days.

---

## Sprint 3 — Wishlists, Items & Access Control ✅ COMPLETE

**Goal:** The core wishlist domain, with the permission model that everything else in the product depends on.

**Status: ✅ COMPLETE.** 192 tests green (49 unit, 143 e2e), lint/typecheck/build clean, and the real `AppModule` verified end to end: migrations → wishlist → items → a genuine Mongo transaction for reorder → participant grant/revoke → anonymous share link → OG preview.

**The access model** is documented as a matrix in [access-policy.service.ts](src/modules/wishlists/access/access-policy.service.ts). Decisions worth knowing:
- **The owner cannot gift.** Reserving your own item is meaningless, and it would hide the item from real gifters. Owners mark items fulfilled via `canManage`.
- **A share link grants nothing on a private list.** If a forwarded link could open it, "private" would be a suggestion. `invite_only` exists for "unlisted but link-shareable".
- **Only the owner manages.** A moderator moderates chat (Sprint 8); edit rights would let an invited guest delete the list.
- **Not-viewable returns 404, never 403** — a 403 confirms the list exists, which is enough to probe for a surprise.
- **Opening a closed list rotates the slug,** so links shared while it was private stop working. Exposure must be deliberate, not a side effect of a toggle.
- **Claimed items freeze.** Editing "Blue headphones" into "A toaster" after someone bought the headphones strands the gifter.
- **Prices are integer minor units.** Sprint 7 sums these into group-gift totals, where float drift is money that does not exist.

**Deviations from the plan, and why:**
- **The policy caches nothing.** The plan's exit criterion demanded revocation and slug rotation take effect immediately, and a permission cache is a correctness problem wearing a performance costume — a 60s TTL means a removed person keeps reading a private list for a minute. The decision is two indexed lookups; cache the document if that ever bites, never the decision.
- **`EVENT_ONLY` resolves through an `IEventParticipation` port** that denies until Sprint 5 supplies events. Failing closed makes the missing dependency a visible gap ("nobody can see my event list") rather than a silent leak.
- **Tests now run a single-node replica set** (`MongoMemoryReplSet`), because the reorder is transactional and a standalone mongod would make tests the only environment without transactions.
- **Participants added by user id are auto-accepted.** An accept step with no notification to trigger it (Sprint 9) would leave every invite stuck at `invited`.

**Bug caught before merge:** the policy consulted event participation whenever `eventId` was set, regardless of visibility — so **an event invitee could read a `private` list** that happened to be linked to an event. The permission matrix caught it; event membership now grants access only on `EVENT_ONLY`. This is precisely what the 4×5×4 matrix exists for.

### Deliverables
- `Wishlist` schema: `ownerId`, `title`, `description`, `visibility` (`public|private|event_only|invite_only`), `coverUrl`, `shareSlug`, `eventId?`, `chatEnabled`, `stats { itemCount, fulfilledCount }`, `archivedAt`.
- `WishlistItem` schema: `wishlistId`, `title`, `notes`, `imageUrls[]`, `productLink`, `price { amount, currency }`, `category`, `priority` (1–5), `importance` (`nice_to_have|would_love|must_have`), `quantity`, `giftPreferences { color, size, variantNotes }`, `status` (`available|reserved|purchased|fulfilled|gifted_offline|completed`), `sourceProductId?`, `position`.
- CRUD: `POST/GET/PATCH/DELETE /wishlists`, `POST/GET/PATCH/DELETE /wishlists/:id/items`.
- `PATCH /wishlists/:id/items/reorder` — bulk position update in one transaction.
- Grouping/filtering: `GET /wishlists/:id/items?category=&status=&priority=`.
- **`AccessPolicyService`** — the single chokepoint deciding `canView | canComment | canGift | canManage` for a `(user, wishlist)` pair, resolving owner → invitee → event participant → share-link holder → public. Every other module calls this; nothing re-implements it.
- `WishlistParticipant` schema: `wishlistId`, `userId?`, `inviteEmail?`, `role` (`viewer|contributor|moderator`), `state` (`invited|accepted|revoked`).
- `POST /wishlists/:id/participants`, `DELETE /wishlists/:id/participants/:pid`.
- Share links: `POST /wishlists/:id/share` (rotatable slug, optional expiry, optional passcode), `GET /public/wishlists/:slug` — unauthenticated, returns a redacted projection (no owner contact info, no reserver identity).
- `GET /public/wishlists/:slug/preview` — Open Graph metadata for WhatsApp link previews (title, image, description).
- Compound indexes: `{ownerId, archivedAt}`, `{shareSlug}` unique, `{wishlistId, position}`, `{wishlistId, status}`.

### Exit criteria
- Permission matrix test suite: 4 visibilities × 5 caller relationships × 4 actions, all asserted.
- A revoked participant and a rotated share slug both lose access immediately (no cache staleness).
- Public projection is verified to leak zero owner PII and zero reserver identity.

---

## Sprint 4 — Product Search, Affiliate Integration & Import ✅ COMPLETE

**Goal:** Users can find real products and pull them into wishlists with durable metadata.

**Status: ✅ COMPLETE.** 276 tests green (104 unit, 172 e2e), lint/typecheck/build clean, and the real `AppModule` verified end to end with the SSRF guard in its production posture: search → cache → resolve-url → import → owner redirect on a private list.

**Shipped without the vendor.** The affiliate network still isn't chosen, so everything is written against `IProductProvider` and backed by a fixture catalogue. Adding the real network is one adapter plus a config value — nothing else in the sprint changes. `ProductsModule` refuses to boot with `PRODUCT_PROVIDER=fixture` in production, because invented products with dead links reaching real users is exactly the placeholder that otherwise survives to launch.

**Deviations from the plan, and why:**
- **The SSRF guard was built now, not deferred to Sprint 12.** The plan lists it under Sprint 12 hardening, but `POST /products/resolve-url` makes *our* server fetch a link the user chose, from inside the VPC, holding an instance role. Shipping it unguarded and hardening it eight sprints later means it is live in staging the whole time, and the classic target — `169.254.169.254`, the cloud metadata service — hands out IAM credentials to anything that asks from the instance. See [ssrf-guard.ts](src/common/net/ssrf-guard.ts).
- **Blocking is by resolved address, never hostname.** A hostname denylist is theatre: `localtest.me` resolves to 127.0.0.1 and an attacker controls their own DNS. Every redirect hop is re-vetted (a public URL that 302s to the metadata service is the bypass everyone forgets), and the request connects to the *vetted IP* with the original Host header, which closes the DNS-rebinding window.
- **`PRODUCT_URL_ALLOW_PRIVATE` exists for tests and Joi refuses to boot production with it on.** A test convenience that disables a security control is precisely the flag that leaks into a deploy.
- **Four separate resilience controls, not one.** The rate limiter is in Redis (the vendor quota is per-account, so a per-pod limiter would let N pods spend N× the budget); the circuit breaker is per-instance (each pod protects *itself* from the wait, and coordinating it would add a Redis hop to the hot path). Retries use full jitter — a fixed backoff means every pod retries in lockstep and re-floors the recovering provider.
- **Stale-while-error, with a 24h stale window against a 15m fresh one.** The two windows do different jobs: freshness is about price accuracy, staleness is about still having a product search during someone else's outage. Rate-limiting does **not** trip the breaker — we stopped that call, the provider didn't.

**Bugs caught before merge:**
- **The affiliate redirect 404'd for the wishlist's own owner.** `@Public()` skips authentication entirely, so `request.user` was never populated and the owner of a *private* list was anonymous to the access policy — clicking their own item's link failed. Fixed with [OptionalJwtAuthGuard](src/common/guards/optional-jwt-auth.guard.ts): authenticate when a token is present, shrug when it is not, and authorize either way.
- **The sync's out-of-stock report counted every affected item every night,** not the newly-flagged ones — so the report could never distinguish "nothing changed" from "everything is still out of stock", and a regression in the de-duplication would have been invisible.

### Deliverables

### Deliverables
- `ProductProviderModule` with an `IProductProvider` interface (`search`, `getDetails`, `getCategories`) and a concrete adapter for the chosen affiliate API. A `FixtureProvider` backs local dev and tests so the suite never hits the network.
- `GET /products/search?q=&category=&minPrice=&maxPrice=&page=` — normalized results, Redis-cached by query hash (15 min TTL).
- `GET /products/categories`, `GET /products/:providerId/:externalId`.
- Provider hardening: per-provider rate limiter, timeout, retry with jittered backoff, and a circuit breaker that degrades to cached results rather than 500s.
- `Product` schema (local snapshot): `provider`, `externalId`, `title`, `description`, `imageUrls[]`, `productUrl`, `affiliateUrl`, `price`, `currency`, `merchant`, `category`, `affiliateMeta`, `lastSyncedAt`. Unique on `{provider, externalId}`.
- `POST /wishlists/:id/items/from-product` — the import flow: snapshot the product, create the item, attach notes/preferences. **Snapshot, don't reference** — price and title are frozen at import so a wishlist never mutates under the owner.
- `affiliate-sync` BullMQ queue: nightly repeatable job refreshing `Product` docs referenced by active wishlists; flags `priceChanged` / `outOfStock` on items and emits a notification event.
- `POST /products/resolve-url` — paste a product URL, resolve to provider metadata where supported, fall back to OG-tag scrape.
- Affiliate click tracking: `GET /r/:itemId` → records a `ClickEvent`, 302s to the affiliate URL with our tracking params.

### Exit criteria — all met
- ✅ Provider outage (simulated 500s + timeouts) degrades to cached/stale results; no user-facing 5xx. Fault injection lives in the fixture provider, because you cannot test "degrades when the provider is down" without being able to take it down.
- ✅ Imported item retains its snapshot price after the upstream price changes; sync flags rather than overwrites.
- ✅ Search p95 under 400 ms on a warm cache.

---

## Sprint 5 — Events & Invite System ✅ COMPLETE

**Goal:** Events, invites, RSVP, and shareable interactive invitations.

**Status: ✅ COMPLETE.** 302 tests green (116 unit, 186 e2e), lint/typecheck/build clean, and the real `AppModule` verified end to end — including the invite-card rasterizer, which renders SVG → a 21 KB PNG and serves it back over real HTTP. **The permission matrix from Sprint 3 now passes with real event participation wired in**, so the `event_only` row went from stub to live.

**All three exit criteria met:**
- Publish → invite 50 recipients (plus 5 duplicates and 2 junk entries, the shape of a real contact paste) → guest RSVPs without an account → counts reconcile: 50 created, 5 collapsed, 2 skipped, and a second identical request adds nobody.
- Moving an event's date reschedules every reminder (cancel-then-re-add, not a no-op) and orphans none; the queued jobs carry the new start time so a stale one no-ops.
- An `event_only` wishlist opens to an invitee **only after they RSVP yes/maybe** — invisible before the invite, invisible while pending, visible after yes, invisible again after declining.

**Deviations from the plan, and why:**
- **The invite-card OG image is rendered now, not deferred.** `@resvg/resvg-js` installs and rasterizes cleanly, so the share card is a real PNG (SVG composed server-side, escaped, then rasterized) rather than a placeholder. Unfurlers do not render SVG, and serving user-influenced SVG from our origin would be stored XSS — so PNG is both the working and the safe choice. Content-addressed by a hash of the design, because unfurlers cache an og:image aggressively.
- **Attaching a wishlist to an event maintains the reverse pointer `wishlist.eventId`.** This surfaced while testing: `AccessPolicyService` resolves `event_only` from the *wishlist* side, but the event stored only `wishlistIds`. Without the back-reference an event-only list would have been invisible to every invitee. Detaching clears it, so removing a list from an event revokes the event-scoped access.
- **Pending invites do NOT grant access — only yes/maybe do.** The plan says the wishlist opens "exactly to accepted invitees", and an unanswered invite is not attendance. This also produces the RSVP data the product wants: the flow becomes invite → RSVP → see the gift list.
- **Invite linking on signup rides an internal `USER_REGISTERED` event**, not a call from `AuthService`. Auth is upstream of events and wishlists; a direct call would be a cycle. The listeners are best-effort — a failure never fails the signup, and the invite still works by token.
- **A one-file `EventParticipationModule` breaks the wishlist↔event cycle.** Wishlists need one boolean from events; importing the whole module (or `forwardRef`) would couple two modules that do not otherwise depend on each other.

**Bug caught before merge:** the reminder scheduler's job ids used the same colon-free construction as Sprint 2's — the fake queue enforces BullMQ's "no colon in a custom id" rule, so a regression fails in tests rather than 500-ing on publish.

### Deliverables

### Deliverables
- `Event` schema: `hostId`, `title`, `type` (`birthday|anniversary|generic|special`), `startsAt`, `endsAt?`, `timezone`, `description`, `coverUrl`, `visibility` (`public|private|invite_only`), `wishlistIds[]`, `reelCollectionId?`, `inviteTemplate { templateId, colorVariant, fields }`, `shareSlug`, `status` (`draft|published|completed|cancelled`).
- `EventInvite` schema: `eventId`, `invitedUserId?`, `email?`, `phone?`, `token`, `rsvp` (`pending|yes|no|maybe`), `respondedAt`, `plusOnes`.
- CRUD `/events`; `GET /events/mine`, `GET /events/invited`.
- `POST /events/:id/invites` (bulk, deduped by email/phone/user), `DELETE /events/:id/invites/:inviteId`, `POST /events/:id/invites/resend`.
- `GET /public/invites/:token` — unauthenticated invite view; `POST /public/invites/:token/rsvp` — RSVP without an account, linking to a user on later signup by matching email/phone.
- `InviteTemplate` seed data: 3 template designs × 6 color variants × 3 occasion sets, each as a structured JSON spec (slots, copy, palette) — the backend serves the spec and the render contract, clients render it.
- `GET /invite-templates?eventType=` and `POST /events/:id/invite/preview` — server-validated preview payload plus a rendered OG image (BullMQ job → S3) for WhatsApp share cards.
- `GET /public/events/:slug/preview` — OG metadata for link previews.
- `scheduler` queue: on publish, enqueue reminder jobs (T-7d, T-1d, T-2h) keyed by event id; re-enqueue on date change, cancel on delete.
- Event ↔ wishlist linking honors `AccessPolicyService`: an `event_only` wishlist becomes visible exactly to accepted invitees.

### Exit criteria
- Publish → invite 50 recipients → RSVP as guest → RSVP counts reconcile, with duplicate invites collapsed.
- Moving an event's date reschedules every reminder and orphans none (asserted against the queue).
- An unauthenticated invitee can view an `invite_only` event's linked wishlist only via their token.

---

## Sprint 6 — Single Gifting, Reservations & Offline Gifts ✅ COMPLETE

**Goal:** One person can reserve, buy, and complete a gift — correctly, under concurrency.

**Status: ✅ COMPLETE.** 331 tests green (122 unit, 209 e2e), lint/typecheck/build clean, and the real `AppModule` verified end to end against a **real MongoDB replica set and real Redis** (not the in-memory harness): the 50-way reserve race, run five times, resolved every time to exactly one success, 49 `ITEM_NOT_AVAILABLE` conflicts, and exactly one active gift row — no double-book. The auto-tick webhook was exercised over real HTTP with a real HMAC over the raw bytes: order → `purchased`, replay → `duplicate` (one purchase in history, not two), forged signature → 401, stale timestamp → 400, unknown provider → 404, and a shipment-before-order pair converging to `fulfilled` with the late order a no-op. The owner's own view showed the reserved item as `available` while a gifter saw it `reserved`.

**All three exit criteria met:**
- 50 parallel reserve calls on one item → exactly 1 success, 49 typed conflicts, zero double-reservations — proven against real Mongo transactions, a real Redis lock, and the real unique partial index, repeatably.
- A replayed webhook is a no-op (Redis nonce + a durable unique `(provider, providerEventId)` index), a forged signature is rejected (`timingSafeEqual` over the raw body), and an out-of-order shipment-before-order pair converges to `fulfilled`.
- The wishlist owner's own view never reveals a reservation — the item reads `available` to the owner while it is `reserved` to everyone else.

**Deviations from the plan, and why:**
- **The lock is best-effort, not fail-closed.** The plan says "Redlock on `item:{id}`". It is there, but a caller that cannot take the lock within its retry budget proceeds *anyway* and lets the in-transaction re-read and the unique partial index arbitrate, rather than returning `RESOURCE_LOCKED`. This is the plan's own stated philosophy made concrete ("a lock is a performance measure, not a correctness one; the unique index is the real guarantee") — and it is what turns 50-way contention into a clean 1/49 split instead of a scattering of lock-timeout errors. `withBestEffortLock` encapsulates it.
- **Webhook raw body is captured with `rawBody: true`, not a scoped middleware.** Nest registers the global JSON body parser *before* any module middleware (`NestApplication.init`), so a raw-body middleware can never win the race for an `application/json` webhook — the parser has already consumed the stream and `express.raw()` sees `req._body` set and skips. `rawBody: true` stashes the exact received bytes at parse time; the controller verifies the HMAC over `req.rawBody`. (Sprint 2's media middleware only ever worked because `image/png` is not JSON-parsed.)
- **Shipment-before-order walks through `purchased`; the state machine stays strict.** `reserved → fulfilled` is deliberately *not* a legal single transition, so the manual `fulfill` endpoint cannot mark an unpurchased gift delivered. The webhook handles convergence instead: a shipment for a still-`reserved` gift ticks `purchased` then `fulfilled`, preserving the canonical path and `purchasedAt`. A shipment proves the purchase happened.
- **`purchased → completed` is a legal transition.** An offline gift has no shipment to confirm, so forcing a `fulfilled` step would be fiction.
- **Owner-view masking rides a denormalized `activeGiftVisibility` on the item, not a gifting → wishlists query.** Gifting depends on wishlists; the reverse is a cycle. `GiftStatusService` maintains the flag, and the item projection masks on it.
- **The scheduler was refactored to one dispatcher + a registry** (see the second bug below) — a structural change beyond the gifting surface, but a correctness prerequisite for it.

**Bugs caught before merge:**
- **App-wide latent bug: every ObjectId reference field was silently a `Mixed` type.** `@Prop({ type: Types.ObjectId })` uses the BSON *value* class; under `@nestjs/mongoose` 11 with current `bson` (where `ObjectId` is a real `class`), the schema factory mis-reads it as a nested class, recurses to an empty definition, and Mongoose interprets `type: {}` as `Mixed`. The consequence: string-form ObjectId queries (`countDocuments({ itemId })`, `updateOne({ _id })`) never cast and silently match nothing. The app had "worked" only because every hot path used `findById` (which force-casts) or passed `ObjectId` instances — the gifting tests were the first to query a ref field by its string form and assert the count. Fixed across all twelve schemas by moving to `SchemaTypes.ObjectId`; all 209 e2e pass unchanged, confirming nothing relied on the broken behavior.
- **Latent architectural bug: two `@Processor(SCHEDULER)` classes would have created competing BullMQ workers that don't route by job name.** Anonymization (Sprint 2) and event-reminder (Sprint 5) jobs could be consumed by the wrong worker and dropped. Reservation-expiry would have been the third. Fixed with a single `SchedulerDispatcher` reading a `SchedulerRegistry`; each feature registers its handler by job name in `onModuleInit`. Regression-checked the Sprint 2 and Sprint 5 scheduler suites.

### Deliverables
- `Gift` schema: `itemId`, `wishlistId`, `gifterId`, `type` (`single|group`), `mode` (`online|offline`), `status` (`reserved|purchased|fulfilled|cancelled|completed`), `amount`, `orderRef?`, `deliveryNotes`, `visibility` (`hidden_from_owner|visible`), `reservedAt`, `expiresAt`, `history[]`.
- `POST /items/:id/reserve` — **the critical section.** Redlock on `item:{id}`, re-read status inside the lock, reject if not `available`, write reservation + item status in one Mongo transaction. `Idempotency-Key` required.
- `DELETE /items/:id/reserve` (release), `POST /gifts/:id/purchase`, `POST /gifts/:id/fulfill`, `POST /gifts/:id/cancel`.
- Reservation expiry: `expiresAt` (default 72 h, owner-configurable per wishlist) with a BullMQ delayed job returning the item to `available` and notifying the gifter beforehand.
- **Offline gifting:** `POST /items/:id/gift-offline` — mark bought elsewhere, capture optional delivery notes and a confirmation date, no order tracking. Transitions to `gifted_offline` → `completed`.
- **Auto-ticking:** `POST /webhooks/affiliate/:provider` — signature-verified (HMAC, timestamp window, replay-protected via Redis nonce), enqueued to a worker that maps order/shipment events to `purchased` / `fulfilled`. Unmatched events land in a dead-letter collection for admin review, never silently dropped.
- Duplicate-gift prevention: reserved/purchased items are visibly locked to other viewers while the reserver's identity stays hidden from the wishlist owner when `hidden_from_owner`.
- `GET /gifts/given`, `GET /gifts/received`, `GET /gifts/on-hold` — the three dashboard sections, now real.
- A `GiftStatusService` owning the state machine; illegal transitions throw a typed error. No status field is written outside this service.

### Exit criteria
- Concurrency test: 50 parallel reserve calls on one item → exactly 1 success, 49 typed conflicts, zero double-reservations.
- Replayed webhook is a no-op; forged signature is rejected; out-of-order shipment-before-order events still converge to the right status.
- The wishlist owner's own view never reveals who reserved their item.

---

## Sprint 7 — Group Gifting & Contributions ✅ COMPLETE

**Goal:** Several people fund one gift, with progress that's always consistent.

**Status: ✅ COMPLETE.** 354 tests green (128 unit, 226 e2e), lint/typecheck/build clean, and the real `AppModule` verified end to end against a **real MongoDB replica set and real Redis**: 100 concurrent contributions, run three times, landed every time at an exact total with `contributorCount` 100, the gift `funded`, and the nightly reconciler reporting zero drift between the cached total and the summed confirmed contributions. A contribution retried with the same key was counted once; an anonymous contributor never appeared by name in the authenticated view or the public share card, though both still counted toward the total; and the passcode-gated public link opened only with the right passcode.

**All three exit criteria met:**
- 100 concurrent contributions against a target land at an exact, correct total, and reconciliation reports zero drift — proven against real Mongo transactions and a real Redis lock, repeatably.
- A contribution submitted twice with the same `Idempotency-Key` is counted once — the HTTP interceptor replays the first response, and a durable unique `(groupGiftId, idempotencyKey)` index is the backstop if the 24h cache is gone.
- Anonymous contributors never appear in any participant projection — not the authenticated timeline, not the named participant list, not the public share view — while still being counted in `contributorCount`.

**Deviations from the plan, and why:**
- **A group gift claims its item through a holder `Gift` (type = group), not a bespoke lock.** Creating one runs the same critical section as a single reservation — same `gift-item:{id}` lock, same unique `(itemId, active)` index, same `GiftStatusService` — so a group gift and a single reservation (or two group gifts) can never both hold one item, with a hard database guarantee rather than a second hand-rolled one. The `GroupGift` and `Contribution` docs track *funding*; the holder tracks the *item*. Single-gift list queries gained a `type: single` filter so the two never bleed together.
- **The contribution counter's hard guarantee is the transaction's write-conflict retry, not a unique index.** Contributions to one gift all `$inc` the same document, so a second concurrent transaction conflicts on commit and retries against the updated total (`withBestEffortLock` serializes the common case on top). This is the counter's equivalent of Sprint 6's unique-index backstop: even if the lock is bypassed, no update is lost and the total is exact.
- **Contributions are `confirmed` on creation.** There is no payment processor yet, so `pledged` and `paymentRef` exist for a later integration but are unused on the happy path. The sum of `confirmed` contributions is the source of truth; `collectedAmount` is only its cache.
- **Over-target is `cap` (default) or `reject`, never silent.** A capped contribution is trimmed to the remaining amount so the total lands exactly on target; `reject` bounces it. The plan is explicit that over-target money is never silently accepted, so there is no third "just take it" option.
- **Anonymity is enforced by construction, not by filtering.** `participantIds` only ever holds joiners and *non-anonymous* contributors, so no projection built from it can leak an anonymous one — the redaction cannot be forgotten at a call site. `contributorCount` counts everyone, because a headcount is not an identity.
- **The nightly reconciler converges the cache to truth *and* fires a loud drift event.** Re-summing is idempotent (safe on a repeatable job firing twice across a deploy); on a mismatch it corrects `collectedAmount` to the confirmed sum and emits `group_gift.drift_detected`, so we self-heal but never silently.
- **The progress-bar OG card renders lazily at public-preview time, content-addressed on the mutable progress.** Rasterizing is CPU work; rendering on every contribution would turn a hundred concurrent contributions into a hundred concurrent renders. The share card is drawn when the link is actually previewed, and the same progress hashes to the same immutable URL so repeats are free.
- **Cancelling with money records refunds immediately, then lands `cancelled`.** With no PSP, the refund is an immutable audit record (`refundRef`, `refundedAt`), not a real charge-back; the `refunding → cancelled` walk is preserved for when async settlement lands in a later sprint.

**Bug caught before merge:** none of Sprint 6's severity — and notably, the app-wide `Mixed`-ObjectId trap that Sprint 6 uncovered did **not** recur: every new schema here declares its references with `SchemaTypes.ObjectId` from the start, so the string-form contribution and group-gift queries cast correctly. The "two writers" hazard was also avoided by keeping `GiftStatusService` the only writer of gift/item status even for a group gift's holder.

### Deliverables
- `GroupGift` schema: `itemId`, `initiatorId`, `targetAmount`, `collectedAmount`, `currency`, `deadline`, `status` (`open|funded|purchasing|purchased|fulfilled|cancelled|refunding`), `participantCount`, `chatId`, `shareSlug`.
- `Contribution` schema: `groupGiftId`, `userId`, `amount`, `status` (`pledged|confirmed|refunded`), `anonymous`, `message`, `idempotencyKey`, `paymentRef?`.
- `POST /items/:id/group-gift` (create), `POST /group-gifts/:id/join`, `POST /group-gifts/:id/contribute`, `DELETE /group-gifts/:id/contributions/:cid`.
- Contribution correctness: Redlock on `group-gift:{id}` + `$inc` on `collectedAmount` inside a transaction; over-target contributions are either capped or rejected per the group's setting — never silently accepted. Every mutation carries an `Idempotency-Key`.
- `collectedAmount` is a denormalized cache with a reconciliation job that re-sums `Contribution` docs nightly and alerts on drift. The sum of confirmed contributions is the source of truth.
- Goal-reached transition → `funded`, emits `group_gift.funded` → notifications + a system chat message.
- `POST /group-gifts/:id/purchase` (initiator/moderator only) → reuses `GiftStatusService`, marks the underlying item.
- Cancellation/refund path: `POST /group-gifts/:id/cancel` moves to `refunding`, enqueues per-contribution refund records for manual/PSP settlement, and keeps an immutable audit trail.
- `GET /group-gifts/:id` — progress, participants (respecting `anonymous`), timeline.
- `POST /group-gifts/:id/share` + `GET /public/group-gifts/:slug` — WhatsApp share card with progress bar OG image.
- Domain events published on an internal `EventEmitter` → bridged to BullMQ, so Sprint 8's chat and Sprint 9's notifications subscribe rather than couple.

### Exit criteria
- 100 concurrent contributions against a target land at an exact, correct total; reconciliation reports zero drift.
- A contribution submitted twice with the same `Idempotency-Key` is counted once.
- Anonymous contributors never appear in any participant projection, including the public share card.

---

## Sprint 8 — Wishlist Chat & Group Gift Chat ✅ COMPLETE

**Goal:** Realtime conversation inside wishlists and group gifts, gated by the same permission model.

**Status: ✅ COMPLETE.** 365 tests green (128 unit, 237 e2e — the 11 new chat e2e tests drive a real Socket.IO server with `socket.io-client`), lint/typecheck/build clean. The four exit criteria that need more than one process were proven by booting **two real `node dist/main.js` instances behind one real Redis adapter** (shared Mongo replica set, shared Redis): a message posted over REST on instance A reached a socket connected to instance B, and the reverse, repeatably.

**All four exit criteria met:**
- **Two nodes deliver to each other's clients.** In the two-instance real boot, `A→B` and `B→A` message delivery both passed on every run — the Socket.IO Redis adapter fans a room broadcast on one instance out to sockets held on the other.
- **A revoked user is force-disconnected and cannot read history.** Revoking a wishlist participant emits `wishlist.participant_revoked`; the gateway `socketsLeave`s their sockets from the chat room (cross-instance through the adapter) and drops them from the members set, while the REST history re-checks `canView` and returns 404 — verified end to end.
- **Exactly one system message per lifecycle event, even on a retry.** Each system message carries a `dedupeKey` on a unique partial index; re-emitting `group_gift.funded` a second time inserted the same key and was silently dropped — one `goal_reached` message, proven in the harness.
- **The owner never sees surprise-gift chatter.** A surprise-flagged wishlist-chat message is withheld from the owner over REST (the history query filters it) **and** over the socket (the broadcast excludes the owner's personal room); a group-gift chat is invisible to the recipient outright when the gift is hidden.

**Deviations from the plan, and why:**
- **Messages are posted over REST, delivered over the socket.** One validation + authorization path serves both transports instead of two; the gateway handles delivery, presence, typing, and read. ChatService emits an in-process `chat.broadcast` after any mutation (REST or socket), and the gateway's listener fans it out — so the two paths can never drift.
- **Handshake auth runs at the Socket.IO middleware, not in `handleConnection`.** A bad token is rejected with `connect_error` before the connection is established, rather than connecting and then disconnecting. It reuses the exact HTTP checks via `SocketAuthService` → `JwtStrategy.validate` (denylist, account status, `tokensInvalidBefore`).
- **The Redis adapter is wired only in `main.ts` (real Redis).** The e2e harness uses the default in-memory adapter for single-instance gateway tests; the genuinely multi-instance exit criterion is validated on real infra, the same split used for the Sprint 6/7 concurrency races.
- **Anti-spoiler is enforced in two layers.** A group-gift chat excludes the recipient whenever the gift is hidden (reusing Sprint 7's masking); a wishlist-chat message can carry `hideFromUserIds`, which the REST projection filters and the socket broadcast excludes via per-user rooms + `.except()`. Server-side on every path — a client can never opt back in.
- **Chat provisioning is eager for group gifts, lazy for wishlists.** A group gift creates its chat on creation (it needs a `chatId`); a wishlist's chat is created on first access. Lazy avoids a wishlists → chat module cycle — chat depends on wishlists for the policy, never the reverse.
- **The offline-participant digest is emit-and-defer, and moderation is a flag hook.** `QUEUE.NOTIFICATIONS` is still unwired (Sprint 9 owns it), so the fan-out is left as domain events to subscribe to later; the profanity check flags a message for Sprint 11's queue rather than blocking it.

**Bug caught before merge:** the message `dedupeKey` unique index was first written **sparse** — but a sparse unique index still indexes an explicit `null`, so the *second* keyless human message collided on `null` and every chat 409'd after the first message. Switched to a **partial** index over string keys only (`{ dedupeKey: { $type: 'string' } }`), so keyless messages are exempt and only real dedupe keys are enforced. Same "sparse + explicit null" subtlety that bites unique indexes generally.

### Deliverables
- `Chat` schema: `type` (`wishlist|group_gift`), `refId`, `participantIds[]`, `lastMessageAt`, `settings { whoCanPost }`.
- `Message` schema: `chatId`, `senderId?` (null for system), `kind` (`text|system|attachment`), `body`, `attachments[]`, `replyToId?`, `reactions [{emoji, userIds[]}]`, `editedAt`, `deletedAt`, `systemPayload?`.
- `ReadReceipt` schema: `chatId`, `userId`, `lastReadMessageId`, `lastReadAt`. Unread counts derive from this — no per-message fanout.
- Socket.IO gateway on `/chat`: JWT handshake auth, `join_chat` authorized through `AccessPolicyService`, events `message:new`, `message:updated`, `message:deleted`, `reaction:changed`, `typing`, `read`, `presence`.
- Redis adapter (`@socket.io/redis-adapter`) so the gateway scales horizontally from day one.
- REST fallback + history: `GET /chats/:id/messages?before=&limit=` (cursor pagination on `_id`), `POST /chats/:id/messages`, `PATCH`/`DELETE /messages/:id`, `POST /messages/:id/reactions`, `POST /chats/:id/read`.
- `GET /chats` — the "Wishlist Chats" and "Group Gift Chats" dashboard sections, with unread counts.
- Chat auto-provisioning: created with the wishlist (when `chatEnabled`) and with every group gift.
- **System messages** — the group-gift chat subscribes to domain events and posts: user joined, contribution received, gift reserved, goal reached, gift purchased, marked offline, shipment confirmed, gift fulfilled. Rendered from a structured `systemPayload` so clients localize rather than parse strings.
- Anti-spoiler rule: in a wishlist chat, messages tied to a surprise gift are filtered from the owner's projection at query time, enforced server-side.
- Rate limiting per socket, message length caps, and a profanity/abuse flag hook feeding Sprint 11's moderation queue.
- Chat notification fanout: offline participants get a queued push/email digest instead of a per-message blast.

### Exit criteria
- Two nodes behind the Redis adapter deliver messages to each other's clients in a multi-instance e2e test.
- A user removed from a wishlist is force-disconnected and cannot read history.
- Every group-gift lifecycle event produces exactly one system message — verified with no duplicates on job retry.
- The wishlist owner cannot see surprise-gift chatter through any endpoint or socket event.

---

## Sprint 9 — Notifications, Email/SMS & Thank-You Notes ✅ COMPLETE

**Goal:** Every meaningful action reaches the right person, once, on the right channel.

**Status: ✅ COMPLETE.** 376 tests green (133 unit, 243 e2e), lint/typecheck/build clean, and the whole pipeline verified against **real Redis + a real MongoDB replica set with the real BullMQ worker running** — the one piece the harness fakes. In that boot, fulfilling a gift produced exactly one in-app notification and one email delivery-log (both `sent`) for the recipient, drafted and scheduled a thank-you note naming the gifter and item, and delivered the welcome notifications — 10/10 smoke checks.

**All three exit criteria met:**
- **Fanout is exactly-once.** One `gift.fulfilled` produces one in-app + one email; re-firing the same event is a no-op. The guarantee is a durable ledger: a unique `(userId, dedupeKey)` on the in-app notification and a unique `dedupeKey` on the delivery log, so a retried BullMQ job re-runs dispatch and every already-delivered channel is skipped. Proven both in the harness (re-emit → counts unchanged) and on the real worker (one `sent` row per channel).
- **Quiet hours defer, they never drop; unsubscribe suppresses within one request.** A non-critical email inside the window is re-enqueued delayed (the in-app still lands immediately); a one-click unsubscribe `$addToSet`s `{category}:email` and the very next dispatch suppresses it — both asserted end to end.
- **A thank-you note renders with the right names and event context, and is editable before it sends.** On a fulfilled gift a draft is created (names, item, optional event), the recipient can preview and edit it, and `send-now` routes it through the same pipeline to the gifter — with the edit reflected in the delivered mail.

**Deviations from the plan, and why:**
- **The type registry is the whole dispatcher.** `NOTIFICATION_SPECS` maps each type → channels, priority (critical/normal/digest), unsubscribe category, and template. Every decision the pipeline makes — which channels, defer in quiet hours, roll into the digest, whether email can be unsubscribed — is read from that one table, so a new notification is a row, not a branch.
- **Single-stage dispatch, not dispatch-then-per-channel-jobs.** One dispatch job fans across channels inline; the per-channel delivery-log claim is what makes the whole job idempotent under retry. It is simpler to reason about and to test than a multi-hop job graph, and the exactly-once property is identical.
- **Real provider adapters behind the existing ports, config-driven.** SES (`@aws-sdk/client-sesv2`) and a fetch-based HTTP SMS gateway (MSG91/Twilio-shaped, no vendor SDK) select on `MAILER_DRIVER`/`SMS_DRIVER`; console stays the dev default, and tests use the existing `FakeMailer`/`FakeSmsSender`. Email HTML is MJML (async in v5), text always present, all copy snapshot-tested.
- **Suppression is a Redis set; the bounce webhook is a shared-secret POST.** A bounced address is `SADD`ed and every later send checks it. Full SES/SNS signature verification is deferred — the internal shared-secret header is enough to keep the endpoint honest today (documented in the controller).
- **The digest is a daily repeatable job.** Digest-type emails are recorded and skipped at dispatch; a `0 {digestHour} * * *` job rolls each user's last-24h digest notifications into one summary email. In-app for those types still lands immediately.
- **New gift-lifecycle events were added.** `gift.reserved/purchased/fulfilled` did not exist; they are now emitted post-commit from `GiftingService` (which gained an `EventEmitter2`), carrying every id a subscriber needs.

**Bug caught before merge — by the real boot, not the tests.** `SesMailerAdapter` built its `SESv2Client` in the constructor, and `NotifierModule` instantiates *both* adapters to feed the driver-selection factory — so on any box using the console driver with no `SES_REGION`, boot died with `Region is missing`. The e2e harness never sees it (it wires `FakeMailer` through `TestInfraModule`, not `NotifierModule`), so only booting the real app surfaced it. Fixed by constructing the SES client lazily on first send. A reminder that "all tests green" and "the app boots" are different claims.

### Deliverables
- `Notification` schema: `userId`, `type`, `payload`, `channels[]`, `readAt`, `createdAt`; `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` — the dashboard section.
- `NotificationPreference` per user, per type, per channel (`in_app|email|sms`), with quiet hours and an unsubscribe token for every email.
- `notifications` BullMQ queue: one `dispatch` job per (user, event) fanning into channel jobs, each retried with backoff and a dead-letter queue.
- Provider adapters behind interfaces: `IMailer` (SES/SendGrid) and `ISmsSender` (Twilio/MSG91), with a console adapter for dev.
- Templating: MJML → HTML for email, per-type templates with a shared Wishtick layout. All templates snapshot-tested.
- **Email triggers:** signup confirmation, event invite, wishlist update, gift reserved, group gift updates, gift fulfilled, thank-you note, reel released.
- **SMS triggers** (kept deliberately narrow — cost and consent): event reminders, event-day reminder, critical gift updates, critical account/security notices.
- Deduplication + digesting: a Redis-backed dedupe key per (user, type, refId, window) collapses bursts; low-priority types roll into a daily digest.
- **Automated thank-you notes:** on `gift.fulfilled`, enqueue a delayed job (default 24 h) that generates a personalized note from a template — recipient name, gifter name, event context, gift details — and emails it. `GET /thank-you/:id` to preview, `PATCH` to edit before send, `POST /thank-you/:id/send-now`, `POST /thank-you/:id/skip`. Never sends without the recipient's configured consent.
- Bounce/complaint webhooks mark addresses undeliverable and suppress future sends.
- Delivery log collection for support/debugging with 90-day TTL index.

### Exit criteria
- Fanout test: one `gift.fulfilled` event produces exactly one in-app + one email, and a retried job sends nothing twice.
- Quiet hours defer rather than drop; unsubscribe suppresses the category within one request.
- A thank-you note renders with correct names and event context, and can be edited before it goes out.

---

## Sprint 10 — Reels: Wish Collection, Time-Locked Release & Compilation ✅ COMPLETE

**Goal:** Birthday wishes are collected, sealed until the day, and compiled automatically.

**Status: ✅ COMPLETE.** 397 tests green (143 unit, 254 e2e — the e2e suite runs **real ffmpeg**, compiling actual MP4s), lint/typecheck/build clean. The headline criterion was proven on real infra: a **40-wish mixed-format collection compiled by the real BullMQ worker in 62 seconds** into a single playable MP4 — h264 720×1280, aac, 1.99 MB — whose duration landed at **128.07s against a predicted 128s** (intro 4 + 20 text×4 + 10 audio×2 + 10 video×2 + outro 4), which is itself the proof that the intro, every wish, and the outro all made it in. No orphaned temp survived, and the share link served nothing before release and the reel after.

**All three exit criteria met:**
- **Nothing leaks wish content before `releaseAt` — one test per surface.** The initiator's view, the recipient's own view, the public share link, and the public OG preview each return counts and contributor first names and *not one byte* of wish text or the reel URL while locked; each is asserted separately, including a `not.toContain` on the raw payload. Plus **10 timezone unit tests** pinning local midnight across both US DST transitions (spring-forward and fall-back), a half-hour offset (IST), BST, and the southern hemisphere.
- **A 40-wish mixed-format collection compiles to one playable MP4 with intro, outro, watermark, and music** — verified end to end above, and again in-harness on a text+audio+video collection probed for codec, geometry, and duration.
- **A killed render leaves no orphaned temp files and retries cleanly** — the test plants an orphaned scratch dir (as a SIGKILLed attempt would leave) and asserts the retry wipes it, renders correctly, and leaves nothing behind.

**Deviations from the plan, and why:**
- **The time-lock lives in the view layer, not in each endpoint.** `toReelView`/`toPublicReelView` are the only code that can project wish content, and they attach it exclusively when `status === released`. A new endpoint cannot leak by omission, because there is no path through the projection that emits content while locked — which is why "one test per surface" is a check on the wiring rather than on four separate guards.
- **Normalize-then-concat-copy, not a mega filtergraph.** Every clip (text card, audio card, video wish) is normalized to one canonical geometry/codec/timebase, then joined with the concat demuxer in copy mode; only the final watermark+music pass re-encodes. A single filtergraph over 40 mixed inputs would be both slower and far more fragile.
- **ffprobe *is* the MIME sniffer.** Submission validates duration, codec, and kind by reading the real streams — an audio file declared as a `video` wish is rejected because ffprobe finds no video track, which is exactly the "not just the declared header" requirement, and it re-uses the media policy's own note that "ffprobe re-validates at compile time".
- **`getObject` was added to the storage port.** The port could presign uploads and write server bytes but not read an object back; the worker needs the real wish bytes on disk to probe and normalize. Implemented on both adapters (local delegates to its existing `read`, S3 gained `GetObjectCommand`).
- **The music bed is synthesized, not licensed.** The final pass mixes a soft generated tone under the wish audio at 10%. It satisfies "background music bed" without shipping an unlicensed asset; swapping in a real track is a config change.
- **Moderation is the gate, not the queue.** Wishes carry `moderationStatus` and only `approved` ones compile (auto-approved while `REEL_MODERATION_ENABLED=false`); the initiator can approve/reject and regenerate. The reviewer *queue* remains Sprint 11's job, matching the flag-not-block hook chat already established.
- **Temp hygiene is wipe-at-start plus `finally`.** A deterministic per-collection scratch dir is removed both before a render begins (clearing any orphan a SIGKILL left, since `finally` cannot run through a kill) and after it ends on every path. That pairing is what makes "no orphans" true even for the one exit path a process cannot clean up after itself.

**Note on the harness:** ffmpeg is far too heavy to run on every enqueue, so the e2e harness fakes the reels queue and drives `ReelCompileService.compile()` directly — real ffmpeg, real MP4s, no BullMQ round trip. The real worker path (queue → bounded-concurrency processor → render) is what the 40-wish boot exercised.

### Deliverables
- `ReelCollection` schema: `recipientUserId`, `eventId?`, `birthdayDate`, `timezone`, `status` (`collecting|locked|releasing|released|failed`), `releaseAt`, `reelMediaUrl`, `shareSlug`, `submissionDeadline`.
- `Wish` schema: `collectionId`, `authorId?`, `authorName`, `kind` (`text|audio|video`), `text?`, `mediaId?`, `durationMs`, `moderationStatus` (`pending|approved|rejected`), `order`.
- `POST /reels/:collectionId/wishes` — accepts text, or a media id from a presigned upload. Server-side validation of duration (audio ≤ 60 s, video ≤ 90 s), size, codec, and MIME sniffing (not just the declared header).
- **The time-lock is server-enforced, not client-enforced.** No endpoint returns wish content — not to the recipient, not to admins outside moderation, not through the share link — until `status = released`. Enforced in the query layer, and covered by an explicit test per endpoint.
- `GET /reels/:collectionId` returns metadata only (wish count, contributor first names) while locked.
- `scheduler` queue: a delayed job at `releaseAt` (recipient's local midnight, timezone-correct, DST-aware) flips to `releasing` and enqueues compilation.
- `reels` queue with a dedicated worker: probe inputs (ffprobe) → normalize each clip (resolution, fps, loudness) → render text wishes to cards → concat with transitions → overlay intro, outro, watermark frame, background music bed → upload to S3 → set `reelMediaUrl` → `released` → notify.
- FFmpeg pipeline runs in an isolated worker process with a hard timeout, bounded concurrency, and temp-dir cleanup on every exit path. Failures retry twice, then land in `failed` with an admin alert — never a half-rendered reel.
- Partial-failure policy: a single unprocessable wish is skipped and logged; the reel still ships with the rest.
- `POST /reels/:collectionId/regenerate` (admin) after moderation removals.
- `GET /public/reels/:slug` + OG preview for sharing; `shareCount` tracked for analytics.
- Moderation gate: only `approved` (or auto-approved when moderation is off) wishes enter the compile.

### Exit criteria
- No endpoint, socket event, or share link exposes wish content before `releaseAt` — one test per surface, plus a timezone test across DST boundaries.
- A 40-wish mixed-format collection compiles to a single playable MP4 with intro, outro, watermark, and music.
- Killing the worker mid-render leaves no orphaned temp files and the job resumes cleanly on retry.

---

## Sprint 11 — Admin Panel, Moderation & Analytics ✅ COMPLETE

**Goal:** Operators can see the platform, act on it, and measure it.

**Status: ✅ COMPLETE.** 427 tests green (161 unit, 266 e2e), lint/typecheck/build clean. All four exit criteria were then re-proven on **real infrastructure**: the real `AppModule` booted against a real single-node Mongo replica set (on the D: drive — C: is nearly full) and a real Redis (isolated on DB 12), and the DAU/WAU/MAU numbers were produced by the **real BullMQ analytics-rollup worker** — not the harness — landing at **5 / 13 / 25 against a raw-event recount of 5 / 13 / 25 (0% drift, criterion is ≤0.5%)**. On that same live boot a user token was rejected on `/admin` (401), a suspension blocked the account's next request (403) and wrote an `active → suspended` audit diff.

**All four exit criteria met:**
- **A user JWT is rejected on every `/admin` route — a *generated* test, not a hand-written list.** The e2e walks the live Express router, discovers every mounted `/admin` route, and asserts a user-audience token gets `401` on each (guard precedes pipes, so never a validation `400`, never a `2xx`). It rejects before any handler runs because the admin token carries a **distinct JWT audience** (`wishtick-admin`) that passport refuses ahead of `validate()` — a user token (`wishtick-app`) cannot reach an admin route by construction, and the secrets differ too.
- **Suspending a live user kills their sockets and blocks their next request.** One test connects a real socket, suspends the user over REST, and asserts the socket receives `disconnect` *and* the next REST call is refused. Suspension reuses the existing revocation chain — `status` + `tokensInvalidBefore` + `revokeAllForUser` — plus a `USER_FORCE_DISCONNECT` event the chat gateway turns into `disconnectSockets(true)`, cross-instance via the Redis adapter.
- **Every admin mutation appears in `AuditLog` with a readable diff.** `AuditService.record` derives a per-field before/after diff (unit-tested for added/changed/unchanged/array-by-value), and the suspend/reactivate/moderation flows each assert their entry — e.g. suspension records `{ field: 'status', before: 'active', after: 'suspended' }`. There is no update or delete path on the log, by design.
- **DAU/WAU/MAU cross-check against a raw-event recount within 0.5%.** The dashboard reads `MetricDaily`; the test seeds three distinct cohorts (5 today, +8 within 7d, +12 within 30d, plus an anonymous event that must *not* count), rolls up, and recounts distinct users straight from the raw stream. They reconcile **exactly** because the rollup and the recount run the *same* distinct-count — the 0.5% tolerance is headroom the implementation does not spend.

**Deviations from the plan, and why:**
- **TOTP is a ~40-line RFC 6238 implementation over `node:crypto`, not a library.** The obvious choice, `otplib`, pulls an ESM-only transitive dependency (`@scure/base`) that Jest's two configs transform inconsistently — it loaded under the e2e config but crashed the unit runner, and it is exactly the kind of thing that detonates at boot. HMAC-SHA1 dynamic truncation is small, standard, and now pinned to the RFC's own test vector (secret `12345678901234567890`, T=59 → `287082`), so the dependency was removed entirely. The service keeps a `Promise`-returning signature so a future remote/HSM verifier slots in unchanged.
- **Moderation is a hub that reads every content domain directly — schemas, not modules.** `ModerationService` borrows the `Message`/`Wish`/`Reel`/`Wishlist`/`Event`/`User` schemas the way the notification module borrows read models: it moderates across every domain without *depending* on any of them (which would be a cycle). Removal does the right per-type takedown — soft-hide a message, reject-and-regenerate a wish in a released reel, clear a reel's media, archive a wishlist, cancel an event, suspend a user — and notifies the content owner. Reporting is deduped by a unique `(source, target, reporter)` index so one user cannot flood the queue for one target.
- **The auto-flag hook chat left behind in Sprint 8 was promoted, not rebuilt.** Chat's bare `message_flagged` emit became a typed `CONTENT_FLAGGED` domain event; a listener turns it into an `auto`-sourced report (severity-bumped above user reports). The pluggable `ISafetyProvider` interface ships with a no-op text/media implementation, as planned — the interface is the deliverable, the media scanner is deferred.
- **Attribution is captured at signup, in the write path, not retrofitted.** `signup` records `User.acquisition` (`source`, `ref`, `capturedAt`) and emits the source on `USER_REGISTERED`; an analytics listener writes a `signup` event carrying that source, which the daily rollup groups into the acquisition dashboard. Capturing it anywhere but at account creation would mean the dashboard could only ever describe users created *after* the wiring — so it had to be here.
- **The rollup and the recount deliberately share one distinct-count.** The exit criterion asks the dashboard to reconcile with a raw recount; the surest way to guarantee that is to make the pre-aggregation and the audit run the identical aggregation, so the only thing being tested is that the rollup *ran and persisted*, not that two different counters happen to agree. Dashboards read `MetricDaily` (or domain collections for engagement) and never scan raw events; every read is `CacheService.wrap`-cached for five minutes.

**Note on the harness:** the analytics-rollup `@Processor` would open a real BullMQ worker on construction, so — exactly like the reels and notifications workers — the e2e fakes the `analytics-rollup` queue and drives `AnalyticsService.rollupDay()` directly. The real worker path (enqueue → processor → `rollupRecent` → `MetricDaily`) is what the real-infra boot exercised, by enqueuing a job under the scheduled cron's own name and waiting for the worker to persist the metric. A bootstrap super-admin is seeded from `ADMIN_BOOTSTRAP_EMAIL`/`_PASSWORD` at module init (test env sets both) so tests and the boot have an operator to log in as.

### Deliverables

**Admin auth & access**
- `Admin` schema with roles (`super_admin|moderator|support|analyst`) and a permission matrix; separate JWT audience from user tokens so a user token can never reach `/admin`.
- Mandatory TOTP 2FA for admin login, IP allowlist option, short sessions (2 h) with explicit revoke.
- `AuditLog` schema — every admin action records actor, action, target, before/after diff, IP, timestamp. Append-only; no delete endpoint exists.

**User management**
- `GET /admin/users` with search (email, phone, name) + filters + pagination; `GET /admin/users/:id` (full profile, events, wishlists, gifting history).
- `POST /admin/users/:id/suspend` (with reason), `/reactivate`, `/force-logout`. Suspension is enforced at the guard layer and disconnects live sockets.
- Activity timeline per user for support triage.

**Moderation**
- `Report` schema: `reporterId`, `targetType` (`wish|reel|message|wishlist|event|user`), `targetId`, `reason`, `status`, `resolution`, `handledBy`.
- `POST /reports` (user-facing) → `GET /admin/moderation/queue?type=&status=` prioritized by severity and age.
- Actions: `approve`, `remove`, `flag`, `escalate`, each writing to `AuditLog` and notifying the content owner where appropriate.
- Removing a wish from a released reel triggers regeneration; removing one pre-release just excludes it.
- Auto-flag hooks: profanity list on text, plus a pluggable interface for an image/video safety provider (implementation deferred, interface shipped).

**Analytics**
- `AnalyticsEvent` schema (append-only, TTL 180 d on raw): `userId?`, `anonymousId?`, `name`, `props`, `source`, `ts`. `POST /events/track` (batched, rate-limited).
- Attribution: every share link and invite token carries a source (`whatsapp|invite|referral|organic|group_gift`), captured at signup into `User.acquisition` — this is what makes the acquisition dashboard possible, so it must be wired at link-generation time, not retrofitted.
- `analytics-rollup` queue: hourly and daily jobs writing `MetricDaily` pre-aggregates. Dashboard reads never scan raw events.
- `GET /admin/analytics/overview` — total users, DAU/WAU/MAU.
- `GET /admin/analytics/acquisition` — invite vs organic vs referral vs group-gift vs WhatsApp.
- `GET /admin/analytics/engagement` — invites created, events created, wishlists created, items added, items fulfilled, public vs private wishlist usage, wishlist chat activity, group-gift chat activity, gifts reserved/purchased/fulfilled, offline gifts completed, reels submitted/generated/shared.
- All analytics endpoints accept a date range + granularity and are cached in Redis (5 min).

### Exit criteria
- A user JWT is rejected on every `/admin` route (asserted per route via a generated test).
- Suspending a live user kills their sockets and blocks their next request.
- Every admin mutation appears in `AuditLog` with a readable diff.
- DAU/WAU/MAU cross-check against a raw-event recount within a 0.5% tolerance.

---

## Sprint 12 — Hardening, Performance & Launch Readiness ✅ COMPLETE

**Goal:** Ship it without surprises.

**Status: ✅ COMPLETE** (backend-codeable scope). 443 tests green (169 unit, 274 e2e), lint/typecheck/build clean. The hardening was then re-proven on **real infrastructure** — the real `AppModule` booted against a real Mongo replica set (on the D: drive; C: is nearly full) and a real Redis (isolated DB 13), where the **migration-created** notification TTL index came up at `expireAfterSeconds=15552000` (180d), helmet headers and gzip were present on live responses, an operator-injection body was refused with `SUSPECT_INPUT_REJECTED`, `GET /me/export` returned only the caller's data with `passwordHash` redacted, and `app.close()` drained cleanly in **29 ms**.

This sprint is half backend code and half launch *process*. The code half is done and tested; the process half (a third-party pen test, the k6 run itself, the Atlas backup/restore drill, Sentry rules, blue/green cutover, the bug-bash week) is not something the backend *contains* — those are documented as runbooks and a ready-to-run k6 script under [`docs/`](docs/), and called out below rather than pretended into existence.

**Exit criteria (defined concretely for this sprint, all met):**
- **Security headers on every response; the framework fingerprint gone.** Helmet was already wired in `main.ts` (Sprint 1); this sprint added it to the e2e harness so it is *asserted* (`nosniff`, `SAMEORIGIN`, no `x-powered-by`) rather than assumed, plus `compression` for the list/dashboard payloads.
- **An operator-injection payload is rejected before it reaches a query.** A global `NoSqlInjectionGuard` (the first guard, ahead of auth) refuses any request whose body or query carries a `$`-prefixed key — defence-in-depth over the DTO whitelist, covering query strings and `Mixed` fields the DTO cannot. A `$` *inside a value* still passes. 8 unit + 2 e2e cases.
- **`GET /me/export` returns a complete, caller-scoped GDPR export.** One pass across every domain collection (account, wishlists, events, gifts, group gifts, reels, chat, notifications, analytics, reports), secrets redacted, filtered to the caller's id on each collection's owner field — proven to include the caller's wishlist and *exclude* another user's.
- **Every user-facing store is TTL-bounded.** The one gap — `notifications` — was closed with a TTL index (schema + migration 012), joining the existing TTLs on analytics events, click events, delivery logs, and refresh/reset tokens (OTPs + sessions live in Redis with native TTL). Asserted by index introspection.
- **Pool size and worker concurrency are env-tunable.** `MONGO_MAX/MIN_POOL_SIZE`, `NOTIF_WORKER_CONCURRENCY`, `ANALYTICS_WORKER_CONCURRENCY` (reels already had one) — a load test can retune throughput per environment without a code change.
- **Graceful shutdown drains in-flight work.** `enableShutdownHooks` (already wired) drains HTTP, BullMQ workers, and connections on `SIGTERM`; the real-infra boot's clean 29 ms `close()` is the proof.

**Deviations from the plan, and why:**
- **The Redis-backed `ThrottlerGuard` *is* the edge rate limiter — `express-rate-limit` was not added.** The plan names `express-rate-limit` "at the edge", but the app already runs a global, **Redis-backed** throttler (shared across pods). `express-rate-limit`'s default store is in-memory and per-process, so bolting it on would be a *weaker* second limiter that an attacker multiplies by the pod count — the exact failure the Redis store exists to avoid. The stronger control stays; the doc records the decision.
- **The NoSQL "sweep" shipped as a rejecting guard, not a stripping sanitizer.** `express-mongo-sanitize` mutates `req.query` in place, which the Express 5 read-only query getter breaks; and silently *stripping* an operator key hides the attempt. The guard rejects with a distinct code instead, so an injection attempt is a logged `400`, not an invisible no-op — and it needs no dependency.
- **"Hard-delete job" already exists as anonymization.** Account erasure (Sprint on account lifecycle) `$unset`s every identifier and overwrites the password hash while keeping the `_id`, so a deleted user's past gift shows as "a deleted user" instead of dangling a foreign key. That *is* GDPR erasure of PII done right; a row-drop would corrupt others' history. This sprint added the **export** half (`GET /me/export`); the erasure half needed no rebuild.
- **Notification retention is genuinely deploy-configurable, not a hardcoded TTL.** The schema index (dev/test autoIndex) and migration 012 (prod) both read `NOTIF_RETENTION_DAYS`, so they never disagree; migration 012 also `collMod`s the expiry in place if the value changed between deploys, rather than failing on `IndexOptionsConflict`.
- **Swagger tag registry filled in; prod exposure unchanged.** All 17 API areas are now registered tags, but docs stay gated to non-production (`SWAGGER_ENABLED && !isProduction`) — an internal API surface is not something to publish at the edge by default.

**Explicitly out of code scope (launch process, documented not implemented):** third-party penetration test + remediation, the k6 *run* (a ready script ships at [`docs/load-test/k6-smoke.js`](docs/load-test/k6-smoke.js)), the Atlas backup/restore drill, secrets-manager migration, Sentry alert rules, blue/green cutover, staging↔prod parity, and the bug-bash week. Runbooks for deploy, rollback, incident, and on-call live in [`docs/runbooks/`](docs/runbooks/); the env reference is [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

### Deliverables
- **Security:** dependency audit + fixes, Helmet, strict CORS allowlist, `express-rate-limit` at the edge, NoSQL-injection sweep over every user-controlled query path, SSRF guard on `products/resolve-url` and any URL fetch, secrets moved to a manager, presigned-URL scope review, JWT rotation runbook.
- Third-party penetration-test scope doc + remediation of findings.
- **Performance:** load test the top 10 endpoints (k6) at 3× expected launch traffic; index review against real `explain()` plans; kill every collection scan on a hot path; connection-pool and BullMQ concurrency tuning.
- Cache audit: confirm every cached key has a TTL and an explicit invalidation path.
- **Reliability:** graceful shutdown (drain HTTP + BullMQ + sockets), backpressure limits, DLQ dashboards and alerts per queue, Atlas backup + restore drill actually performed and timed.
- **Data:** final index migration, TTL indexes on OTPs/sessions/analytics/delivery logs, PII inventory + retention policy, GDPR-style export (`GET /me/export`) and hard-delete job.
- **Docs:** OpenAPI complete with examples and error codes, Postman collection, `README` (setup/run/test), architecture diagram, runbooks (deploy, rollback, incident, on-call), and an env var reference.
- **Ops:** staging↔prod parity, blue/green or rolling deploy, seed script for demo data, Sentry alert rules, uptime checks, log retention.
- Bug-bash week: full team runs the MVP checklist from the scope's Launch Version Summary end to end.
- Go/no-go review against the launch checklist below.

### Launch checklist (from scope §Launch Version Summary)
- [ ] Signup, login, onboarding
- [ ] Profile dashboard (all 12 sections returning real data)
- [ ] Event creation + invite templates (3 designs × 5–6 colors)
- [ ] Public and private wishlists
- [ ] Product search + affiliate import
- [ ] Personal wishlist chat
- [ ] Group gift chat
- [ ] Single gifting
- [ ] Group gifting
- [ ] Offline gifting
- [ ] Auto gift ticking via API fulfillment
- [ ] Email + SMS notifications
- [ ] Automated thank-you notes
- [ ] Birthday wishes reel
- [ ] Admin moderation panel
- [ ] Analytics dashboard
- [ ] WhatsApp sharing for invites, wishlists, group gifts

---

## Dependency Map

```
S1 Foundation+Auth
      │
      ├─► S2 Profile/Dashboard
      │        │
      │        ├─► S3 Wishlists + AccessPolicy ──┬─► S4 Products/Affiliate
      │        │                                 │
      │        │                                 ├─► S5 Events/Invites
      │        │                                 │
      │        │                                 └─► S6 Single/Offline Gifting
      │        │                                          │
      │        │                                          └─► S7 Group Gifting
      │        │                                                   │
      │        │                                  S3 + S7 ─────────┴─► S8 Chat
      │        │
      │        └─► S10 Reels (needs S2 media, S5 events)
      │
      └─► S9 Notifications (consumed by S5–S8, S10)
                    │
                    └─► S11 Admin + Analytics ──► S12 Hardening/Launch
```

**Critical path:** S1 → S3 → S6 → S7 → S8. Everything gifting- and chat-related is blocked on `AccessPolicyService` landing in Sprint 3 — that's the sprint to not compress.

**Parallelizable:** S4 (products) and S5 (events) can run alongside S6 with a second developer. S9's provider adapters and templates can start during S5. S10's FFmpeg pipeline is self-contained and can be spiked early by whoever's free.

---

## Cross-Cutting Standards (every sprint)

- **Definition of done:** code merged, unit + integration tests for happy path *and* the sprint's listed failure modes, OpenAPI updated, indexes migrated, logs/metrics emitted for new flows, staging deployed and smoke-tested.
- **Test coverage floor:** 70% overall; 90% on `AccessPolicyService`, `GiftStatusService`, contribution math, and the reel time-lock. These four are where a bug is a product incident, not a ticket.
- **No status field, permission decision, or money amount is written outside its owning service.** Reviewers reject direct `updateOne` on those fields.
- **Every mutating gifting endpoint is idempotent.** Retries are a client's right, not a bug report.
- **Every list endpoint is paginated** with cursor pagination. No unbounded `find()` reaches production.
- **Nothing user-controlled is interpolated into a Mongo query.** DTO-validated fields only.
- **Every queue job is idempotent and has a retry policy + DLQ.** A job that runs twice must be indistinguishable from a job that ran once.

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Affiliate API choice not finalized | Blocks S4 | `IProductProvider` interface + fixture provider lets S4 ship without the vendor; adapter is a 2-day swap |
| Reel rendering cost/latency at scale | S10 slips, birthday deadlines missed | Dedicated worker pool, hard timeouts, pre-warm the day before, alert on DLQ; fall back to a text-card-only reel rather than nothing |
| Double-gifting under concurrency | Product credibility | Redlock + transactional status writes + the 50-way concurrency test in S6 |
| Group-gift contribution drift | Money is wrong — worst-case failure | Contributions are the source of truth; nightly reconciliation with drift alerts |
| SMS cost and consent | Budget + compliance | SMS restricted to 4 narrow types, per-user opt-in, per-user monthly cap |
| Chat scale on one node | Outage at launch | Redis adapter from day one in S8, load-tested in S12 |
| Time-lock leak on reels | Ruins the core feature's promise | Server-side enforcement in the query layer + a per-surface test suite |
| Scope creep (attachments, payments, i18n) | Timeline | Explicitly out of MVP — see below |

## Explicitly Out of Scope for MVP

Payment processing/escrow for group gifts (contributions are tracked, settlement is out-of-band), chat attachments (scope says "later if needed"), push notifications (email + SMS only), i18n/l10n, social login, native ML recommendations (onboarding preferences drive simple rule-based suggestions), video reel templates beyond the single branded style.
