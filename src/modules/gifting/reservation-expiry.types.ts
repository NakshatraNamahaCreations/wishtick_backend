export const RESERVATION_EXPIRY_JOB = 'reservation-expiry';

export interface ReservationExpiryJobData {
  giftId: string;
  /**
   * The gift's expiresAt when the job was queued.
   *
   * The worker compares it against the gift's current expiresAt and no-ops on a
   * mismatch — the safety net behind cancelling the job when a reservation is
   * purchased or released. Same pattern as the event reminders.
   */
  expiresAtIso: string;
}

/**
 * Deterministic job id per gift. Hyphens, never ':' — BullMQ rejects a colon in
 * a custom id, which would 500 the reserve endpoint.
 */
export const reservationExpiryJobId = (giftId: string): string =>
  `${RESERVATION_EXPIRY_JOB}-${giftId}`;
