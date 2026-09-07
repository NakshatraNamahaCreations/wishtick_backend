/** The delayed unlock job lives on QUEUE.SCHEDULER (via the shared dispatcher). */
export const MEMORY_UNLOCK_JOB = 'memory-unlock';

export interface MemoryUnlockJobData {
  capsuleId: string;
  /**
   * Staleness guard: skip if the capsule's unlockAt has since moved. A host who
   * pushes the date back leaves the old job in the queue, and without this it
   * would open the capsule at the original instant.
   */
  unlockAtIso: string;
}

// BullMQ rejects ':' in a custom job id — hyphens only.
export const unlockJobId = (capsuleId: string): string => `${MEMORY_UNLOCK_JOB}-${capsuleId}`;
