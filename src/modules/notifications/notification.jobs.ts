import type { NotificationChannel, NotificationType } from './notification.types';

/** BullMQ job names on QUEUE.NOTIFICATIONS. */
export const NOTIFICATION_DISPATCH_JOB = 'notification-dispatch';
export const THANK_YOU_SEND_JOB = 'thank-you-send';
export const NOTIFICATION_DIGEST_JOB = 'notification-digest';

export interface DispatchJobData {
  userId: string;
  type: NotificationType;
  /** The entity the notification is about; the dedupe axis. */
  refId: string;
  /** Fully-resolved display context for rendering — no DB reads in the processor. */
  payload: Record<string, unknown>;
  /** When set, only this channel is processed (a deferred re-enqueue). */
  onlyChannel?: NotificationChannel;
  /**
   * A refId prefix this notification replaces in the in-app list: the user's
   * earlier rows of the same type whose refId starts with it are hidden once
   * this one lands. For news where only the latest word counts — a guest's
   * RSVP, which they can change as often as they like.
   */
  supersedes?: string;
}

export interface ThankYouSendJobData {
  noteId: string;
}

// BullMQ rejects ':' in a custom jobId — hyphens only.
export const dispatchJobId = (userId: string, type: string, refId: string): string =>
  `${NOTIFICATION_DISPATCH_JOB}-${userId}-${type}-${refId}`.replace(/:/g, '-');

export const thankYouJobId = (noteId: string): string => `${THANK_YOU_SEND_JOB}-${noteId}`;
