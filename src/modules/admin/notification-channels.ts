import { NotificationChannel } from 'src/modules/notifications/notification.types';

/**
 * Wishtick does not send email to people, so the panel never shows it as a
 * channel: what its logs say about email is left out of every admin view.
 */
export const NOT_EMAIL = { channel: { $ne: NotificationChannel.EMAIL } };

/** [channels] without email. */
export function shownChannels<T extends string>(channels: readonly T[]): T[] {
  return channels.filter((c) => c !== (NotificationChannel.EMAIL as string));
}
