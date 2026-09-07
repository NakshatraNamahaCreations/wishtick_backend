import type { NotificationDocument } from './schemas/notification.schema';
import type { NotificationPreferenceDocument } from './schemas/notification-preference.schema';
import type { ThankYouNoteDocument } from './schemas/thank-you-note.schema';

export interface NotificationView {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  refId: string;
  read: boolean;
  createdAt: Date;
}

export interface PreferenceView {
  disabled: string[];
  timezone: string;
  quietHours: { enabled: boolean; startHour: number | null; endHour: number | null };
  thankYouAutoSend: boolean;
  unsubscribeToken: string;
}

export interface ThankYouView {
  id: string;
  giftId: string;
  gifterId: string;
  status: string;
  kind: string;
  mediaUrl: string | null;
  subject: string;
  body: string;
  context: {
    recipientName: string;
    gifterName: string;
    itemTitle: string | null;
    eventTitle: string | null;
    eventDate: Date | null;
  };
  scheduledFor: Date | null;
  sentAt: Date | null;
  editedAt: Date | null;
  createdAt: Date;
}

export const toNotificationView = (n: NotificationDocument): NotificationView => ({
  id: n._id.toString(),
  type: n.type,
  category: n.category,
  title: n.title,
  body: n.body,
  payload: n.payload,
  refId: n.refId,
  read: n.readAt !== null,
  createdAt: n.createdAt,
});

export const toPreferenceView = (p: NotificationPreferenceDocument): PreferenceView => ({
  disabled: p.disabled,
  timezone: p.timezone,
  quietHours: {
    enabled: p.quietHours.enabled,
    startHour: p.quietHours.startHour,
    endHour: p.quietHours.endHour,
  },
  thankYouAutoSend: p.thankYouAutoSend,
  unsubscribeToken: p.unsubscribeToken,
});

export const toThankYouView = (n: ThankYouNoteDocument): ThankYouView => ({
  id: n._id.toString(),
  giftId: n.giftId.toString(),
  gifterId: n.gifterId.toString(),
  status: n.status,
  kind: n.kind,
  mediaUrl: n.mediaUrl,
  subject: n.subject,
  body: n.body,
  context: {
    recipientName: n.context.recipientName,
    gifterName: n.context.gifterName,
    itemTitle: n.context.itemTitle,
    eventTitle: n.context.eventTitle,
    eventDate: n.context.eventDate,
  },
  scheduledFor: n.scheduledFor,
  sentAt: n.sentAt,
  editedAt: n.editedAt,
  createdAt: n.createdAt,
});
