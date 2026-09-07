# Runbook: On-call

## What you own
Availability and correctness of the API and its workers. First responder for pages,
escalation to the service owner for data-affecting or security incidents.

## Dashboards & signals (wire these in the observability stack)
- **Availability:** `/ready` success rate; 5xx rate by route.
- **Latency:** p50/p95/p99 on the top endpoints (see [load-test](../load-test/)).
- **Queues:** depth and `failed`-set size per queue — a growing `failed` set is the
  earliest sign of a systemic handler bug.
- **Mongo:** connection-pool utilisation, slow-query log.
- **Redis:** memory, connected clients, evictions.
- **Sentry:** unhandled exceptions (set `SENTRY_DSN`).

## First five minutes
1. Ack the page. Is it availability, correctness, or security? → [incident.md](incident.md).
2. Check `/ready` — which dependency?
3. Recent deploy? If the timeline lines up, → [rollback.md](rollback.md).
4. Grab a failing `x-request-id` and pull its full request trace from the logs.

## Safe actions without escalation
- Scale pods; raise a worker-concurrency or pool env and redeploy.
- Remove a poisoned job from a `failed` set (handlers are idempotent).
- Suspend an abusive account (audited, reversible via reactivate).

## Escalate before doing
- Any script that **writes** data (status, money, suspension bulk actions).
- Reversing a migration in production.
- Anything touching secrets or the SSRF/CORS allowlists.

## Handy references
- Env: [ENVIRONMENT.md](../ENVIRONMENT.md) · Deploy: [deploy.md](deploy.md) · Architecture & security notes: [../../README.md](../../README.md)
