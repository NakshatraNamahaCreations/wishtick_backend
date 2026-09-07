/**
 * Queue names are centralized so a typo is a compile error rather than a job
 * silently landing on a queue nobody consumes.
 */
export const QUEUE = {
  /** Proves worker wiring end-to-end and backs the /ready probe. */
  HEALTH: 'health',
  /** Sprint 9. */
  NOTIFICATIONS: 'notifications',
  /** Sprint 10. */
  REELS: 'reels',
  /** Sprint 4. */
  AFFILIATE_SYNC: 'affiliate-sync',
  /** Sprint 11. */
  ANALYTICS_ROLLUP: 'analytics-rollup',
  /** Sprints 5, 6 — event reminders, reservation expiry, reel release. */
  SCHEDULER: 'scheduler',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * Every job retries with backoff and keeps a bounded history. `removeOnFail`
 * is deliberately false-ish (kept, capped) — a queue that discards failures
 * has no dead-letter story, and Sprint 12 needs DLQ dashboards.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};
