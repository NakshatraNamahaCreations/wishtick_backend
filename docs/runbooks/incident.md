# Runbook: Incident response

## Triage
1. **Scope it.** Is it availability (`/ready` failing), correctness (wrong data), or
   security (suspected abuse)? Check the error rate and which routes, by
   `x-request-id` correlation in the logs.
2. **Find the dependency.** `/ready` names the failing check — Mongo, Redis, or the
   queue connection. A liveness-only (`/health`) pass with `/ready` failing means the
   process is up but a dependency is down.

## Common incidents

### A queue is backing up
- Inspect depth and the `failed` (dead-letter) set per queue (`QUEUE.NOTIFICATIONS`,
  `analytics-rollup`, `reels`, `scheduler`). Every job is idempotent with a retry
  policy; an exhausted job stays in `failed` as the DLQ record.
- If a poisoned job blocks a worker, remove it from `failed`; the source event can be
  replayed because handlers are safe to run twice.
- If throughput is the problem, raise the worker concurrency env
  (`NOTIF_WORKER_CONCURRENCY`, `ANALYTICS_WORKER_CONCURRENCY`, `REEL_WORKER_CONCURRENCY`)
  and redeploy — no code change.

### Mongo latency / connection exhaustion
- Check pool saturation; raise `MONGO_MAX_POOL_SIZE` and redeploy.
- Pull the slow query from logs and confirm it has an index (`explain()`); every hot
  path is indexed via a migration.

### Suspected account abuse
- Suspend via `POST /admin/users/:id/suspend` — it revokes sessions **and**
  force-disconnects live sockets across instances, and writes an `AuditLog` entry.
- Report content lands in `GET /admin/moderation/queue`; act with
  `/admin/moderation/reports/:id/act`.

### Redis loss (rate-limit / cache / queues)
- Rate limiting and caches fail open on read but the throttler is Redis-backed —
  a Redis outage removes the shared limit; watch for flood traffic and scale/limit at
  the edge until Redis returns. Queue jobs are durable in Redis; a flush loses
  in-flight jobs — the account-anonymization **sweeper** is the safety net for the one
  that must not be lost.

## After
Write the timeline (detection → mitigation → resolution), the blast radius, and one
prevention action. File it and link the `x-request-id`s.
