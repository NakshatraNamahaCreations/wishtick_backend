# Runbook: Rollback

## When
`/ready` failing after a deploy, error rate or latency spiking, a queue's `failed`
set growing fast, or a correctness bug in a mutating path (gifting, contributions,
suspension).

## Steps
1. **Shift traffic back** to the previous revision (blue/green swap or scale the old
   ReplicaSet up and the new down). The old image is still compatible because
   migrations are **additive** — a new index or field does not break old code.
2. **Do not auto-run `migrate:down`.** Down-migrations drop indexes and are for
   development. In production, a forward-compatible schema means the previous
   revision runs fine against the migrated database; reversing indexes mid-incident
   risks a slow collection scan under load. Only reverse a migration deliberately,
   off the hot path.
3. **Drain, don't kill.** Let the new pods terminate via `SIGTERM` so in-flight jobs
   finish; a hard kill can leave a job half-done (the workers are idempotent, so a
   redelivery is safe, but draining is cleaner).
4. **Reconcile queues.** If the bad revision wrote jobs the old code cannot process,
   they will land in the `failed` set and retry-exhaust harmlessly — inspect and, if
   needed, remove them (see [incident.md](incident.md)).

## Data-affecting bugs
If the bad revision **wrote wrong data** (not just served wrong reads), rolling back
code is not enough. Identify the blast radius by `x-request-id` / `createdAt` window,
then run a targeted fix script. Gifting/contribution writes go through their owning
service and are auditable; never hand-edit status or money fields directly.
