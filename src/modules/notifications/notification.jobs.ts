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
}

export interface ThankYouSendJobData {
  noteId: string;
}

// BullMQ rejects ':' in a custom jobId — hyphens only.
export const dispatchJobId = (userId: string, type: string, refId: string): string =>
  `${NOTIFICATION_DISPATCH_JOB}-${userId}-${type}-${refId}`.replace(/:/g, '-');

export const thankYouJobId = (noteId: string): string => `${THANK_YOU_SEND_JOB}-${noteId}`;
