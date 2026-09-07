# Runbook: Deploy

## Preconditions
- CI green on the target commit: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e`.
- `.env` for the target environment complete (see [ENVIRONMENT.md](../ENVIRONMENT.md)). Boot **fails loudly** on a missing/invalid var, so a bad config is caught at start, not at first request.
- `CORS_ORIGINS` is a real allowlist (not `*`) and `PRODUCT_URL_ALLOW_PRIVATE` is unset/false — the boot refuses both in production.

## Steps
1. **Migrate indexes first.** `npm run migrate:up` (idempotent — each migration records its id and is skipped if already applied). New TTL/unique indexes must exist before the new code writes. In production `autoIndex` is off, so migrations are the *only* index creator.
2. **Roll out the new revision** (rolling or blue/green). The app registers graceful-shutdown hooks (`enableShutdownHooks`), so on `SIGTERM` it drains in-flight HTTP requests, stops pulling new BullMQ jobs and finishes running ones, and closes Mongo/Redis cleanly. Give the orchestrator a termination grace ≥ the longest job (reel compile can run ~60–120s — set `terminationGracePeriodSeconds` accordingly or run reels on a separate pool).
3. **Gate on readiness.** `/ready` checks Mongo, Redis, and the queue connection; wire it as the readiness probe so traffic only shifts once dependencies answer. `/health` is liveness (no deps).
4. **Verify** post-deploy: `/ready` 200, error rate flat in logs (correlate by `x-request-id`), queue depths draining (not growing), no spike in BullMQ `failed` sets.

## Notes
- Repeatable jobs (digest, analytics rollup, reminders) use **fixed jobIds**, so a redeploy re-registers the same schedule instead of stacking duplicates.
- Schema changes are additive-first; a field rename is a two-deploy migration (add new, backfill, switch reads, drop old).
