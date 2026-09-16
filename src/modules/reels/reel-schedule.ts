/**
 * Timezone math for "the recipient's local midnight on their birthday".
 *
 * Moved to `src/common/time/zoned.ts` once the celebration reminder needed the
 * same DST-correct zone arithmetic; re-exported here so this module's callers
 * and `reel-schedule.spec.ts` — the proof that the arithmetic is right — go on
 * reading exactly as they did.
 */
export { nextLocalMidnight, zonedWallTimeToUtc } from 'src/common/time/zoned';
