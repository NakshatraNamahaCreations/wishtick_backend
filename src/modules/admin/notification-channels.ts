import { NotificationChannel } from 'src/modules/notifications/notification.types';

/**
 * Wishtick reaches people in the app and by push. It sends no email and no SMS
 * notifications, so the panel never shows those as channels: what the logs say
 * about them is left out of every admin view.
 */
const NOT_SENT: string[] = [NotificationChannel.EMAIL, NotificationChannel.SMS];

/** A filter leaving out the channels Wishtick does not send on. */
export const SENT_CHANNELS_ONLY = { channel: { $nin: NOT_SENT } };

/** Whether [channel] is one Wishtick sends on. */
export function isShownChannel(channel: string): boolean {
  return !NOT_SENT.includes(channel);
}

/** [channels] without the ones Wishtick does not send on. */
export function shownChannels<T extends string>(channels: readonly T[]): T[] {
  return channels.filter(isShownChannel);
}
