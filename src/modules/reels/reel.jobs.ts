/** The delayed release job lives on QUEUE.SCHEDULER (via the shared dispatcher). */
export const REEL_RELEASE_JOB = 'reel-release';
/** The heavy compile job lives on its own QUEUE.REELS worker. */
export const REEL_COMPILE_JOB = 'reel-compile';

export interface ReelReleaseJobData {
  collectionId: string;
  /** Staleness guard: skip if the collection's releaseAt has since moved. */
  releaseAtIso: string;
}

export interface ReelCompileJobData {
  collectionId: string;
}

// BullMQ rejects ':' in a custom job id — hyphens only.
export const releaseJobId = (collectionId: string): string => `${REEL_RELEASE_JOB}-${collectionId}`;
export const compileJobId = (collectionId: string): string => `${REEL_COMPILE_JOB}-${collectionId}`;
