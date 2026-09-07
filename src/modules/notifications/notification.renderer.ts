import { Injectable } from '@nestjs/common';
import mjml2html from 'mjml';
import { NotificationType } from './notification.types';

export interface RenderedNotification {
  subject: string;
  /** In-app headline. */
  title: string;
  /** Plain-text body — the in-app body and the email text part. */
  text: string;
  /** Short one-liner for SMS. */
  sms: string;
  /** Responsive HTML for email, compiled from MJML. */
  html: string;
}

interface Content {
  subject: string;
  title: string;
  lines: string[];
  cta?: { label: string; url: string };
}

const s = (p: Record<string, unknown>, key: string, fallback = ''): string => {
  const v = p[key];
  return typeof v === 'string' && v.trim() ? v : fallback;
};

const money = (p: Record<string, unknown>, key: string): string => {
  const minor = p[key];
  const currency = s(p, 'currency', 'INR');
  if (typeof minor !== 'number') return '';
  return `${currency} ${(minor / 100).toFixed(2)}`;
};

/** Someone/anonymous-safe name. */
const who = (p: Record<string, unknown>, key: string): string => s(p, key, 'Someone');

/**
 * The per-type copy. Pure functions of the (already-resolved) payload, so they
 * are trivially snapshot-tested and the renderer never reaches back into the
 * database. Adding a type is adding an entry, matching the registry.
 */
const CONTENT: Record<NotificationType, (p: Record<string, unknown>) => Content> = {
  [NotificationType.WELCOME]: (p) => ({
    subject: 'Welcome to Wishtick 🎁',
    title: `Welcome, ${s(p, 'name', 'friend')}!`,
    lines: [
      `Welcome to Wishtick, ${s(p, 'name', 'friend')}.`,
      'Create a wishlist, share it, and let the gifting begin.',
    ],
    cta: { label: 'Open Wishtick', url: s(p, 'appUrl') },
  }),
  [NotificationType.GIFT_RESERVED]: (p) => ({
    subject: `You reserved ${s(p, 'itemTitle', 'a gift')}`,
    title: 'Reservation confirmed',
    lines: [
      `You reserved ${s(p, 'itemTitle', 'a gift')} on ${s(p, 'wishlistTitle', 'a wishlist')}.`,
      "We'll keep it held for you until you buy it.",
    ],
    cta: { label: 'View your gift', url: s(p, 'url') },
  }),
  [NotificationType.GIFT_PURCHASED]: (p) => ({
    subject: `Your gift is on its way`,
    title: 'Gift purchased',
    lines: [`${s(p, 'itemTitle', 'Your gift')} is marked as purchased.`],
  }),
  [NotificationType.GIFT_FULFILLED]: (p) => ({
    subject: `A gift arrived for you 🎁`,
    title: 'A gift was delivered',
    lines: [
      `${s(p, 'itemTitle', 'A gift')} from your wishlist has been delivered.`,
      'You can send a thank-you note from your gifts.',
    ],
    cta: { label: 'See the gift', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_FUNDED]: (p) => ({
    subject: `Goal reached: ${s(p, 'itemTitle', 'your group gift')} 🎉`,
    title: 'The group gift is funded!',
    lines: [
      `The group gift for ${s(p, 'itemTitle', 'an item')} reached its goal of ${money(p, 'targetAmountMinor')}.`,
      'It can now be purchased.',
    ],
    cta: { label: 'View the group gift', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_CONTRIBUTION]: (p) => ({
    subject: `A new contribution`,
    title: 'Someone chipped in',
    lines: [
      `${who(p, 'contributorName')} contributed ${money(p, 'amountMinor')} to ${s(p, 'itemTitle', 'the group gift')}.`,
      `Collected so far: ${money(p, 'collectedAmountMinor')} of ${money(p, 'targetAmountMinor')}.`,
    ],
  }),
  [NotificationType.GROUP_GIFT_INVITE]: (p) => ({
    subject: `${who(p, 'inviterName')} asked you to chip in`,
    title: 'Join a group gift',
    lines: [`${who(p, 'inviterName')} invited you to chip in for ${s(p, 'itemTitle', 'a gift')}.`],
    cta: { label: 'See the invitation', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_JOINED]: (p) => ({
    subject: `A new member joined`,
    title: 'Someone joined the group gift',
    lines: [`${who(p, 'joinerName')} joined the group gift for ${s(p, 'itemTitle', 'an item')}.`],
  }),
  [NotificationType.GROUP_GIFT_PURCHASED]: (p) => ({
    subject: `The group gift was purchased`,
    title: 'Group gift purchased',
    lines: [`${s(p, 'itemTitle', 'The group gift')} has been purchased.`],
    cta: { label: 'View the group gift', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_FULFILLED]: (p) => ({
    subject: `The group gift was delivered 🎁`,
    title: 'Group gift delivered',
    lines: [`${s(p, 'itemTitle', 'The group gift')} has been delivered.`],
    cta: { label: 'View the group gift', url: s(p, 'url') },
  }),
  [NotificationType.EVENT_REMINDER]: (p) => ({
    subject: `Reminder: ${s(p, 'eventTitle', 'your event')} ${s(p, 'whenText', 'soon')}`,
    title: `${s(p, 'eventTitle', 'Your event')} is ${s(p, 'whenText', 'coming up')}`,
    lines: [`${s(p, 'eventTitle', 'Your event')} is ${s(p, 'whenText', 'coming up')}.`],
    cta: { label: 'View the event', url: s(p, 'url') },
  }),
  [NotificationType.EVENT_WISHLIST_OFFERED]: (p) => ({
    subject: `${who(p, 'guestName')} offered a wishlist for ${s(p, 'eventTitle', 'your event')}`,
    title: 'A guest offered a wishlist',
    lines: [
      `${who(p, 'guestName')} offered ${s(p, 'wishlistTitle', 'their wishlist')} for ${s(p, 'eventTitle', 'your event')}.`,
      'It shows on the invitation once you accept it.',
    ],
    cta: { label: 'Review it', url: s(p, 'url') },
  }),
  [NotificationType.EVENT_WISHLIST_ANSWERED]: (p) => ({
    subject: p.approved
      ? `Your wishlist is on ${s(p, 'eventTitle', 'the event')}`
      : `Your wishlist was not added to ${s(p, 'eventTitle', 'the event')}`,
    title: p.approved ? 'Your wishlist was accepted' : 'Your wishlist was declined',
    lines: [
      p.approved
        ? `${s(p, 'wishlistTitle', 'Your wishlist')} is now showing on ${s(p, 'eventTitle', 'the event')}.`
        : `The host did not add ${s(p, 'wishlistTitle', 'your wishlist')} to ${s(p, 'eventTitle', 'the event')}.`,
    ],
    cta: { label: 'View the event', url: s(p, 'url') },
  }),
  [NotificationType.ITEM_PRICE_DROP]: (p) => ({
    subject: `Price drop: ${s(p, 'itemTitle', 'a wishlist item')}`,
    title: 'A wishlist item dropped in price',
    lines: [
      `${s(p, 'itemTitle', 'An item')} is now ${money(p, 'currentAmountMinor')} (was ${money(p, 'snapshotAmountMinor')}).`,
    ],
  }),
  [NotificationType.ITEM_OUT_OF_STOCK]: (p) => ({
    subject: `Out of stock: ${s(p, 'itemTitle', 'a wishlist item')}`,
    title: 'A wishlist item is out of stock',
    lines: [`${s(p, 'itemTitle', 'An item')} on your wishlist is currently out of stock.`],
  }),
  [NotificationType.THANK_YOU]: (p) => ({
    subject: s(p, 'subject', `A thank-you from ${s(p, 'recipientName', 'a friend')}`),
    title: 'A thank-you note',
    lines: [s(p, 'body', 'Thank you so much for the gift!')],
  }),
  [NotificationType.ACCOUNT_SECURITY]: (p) => ({
    subject: s(p, 'subject', 'A security update on your Wishtick account'),
    title: s(p, 'title', 'Security update'),
    lines: [s(p, 'message', 'There was a security-related change on your account.')],
  }),
  [NotificationType.REEL_RELEASED]: (p) => ({
    subject: `Your birthday reel is here 🎂`,
    title: 'Your reel is ready!',
    lines: [
      `Your friends came together — ${s(p, 'wishCount', 'a few')} wishes are waiting for you.`,
      'Tap to watch your birthday reel.',
    ],
    cta: { label: 'Watch your reel', url: s(p, 'url') },
  }),
  [NotificationType.MEMORY_UNLOCKED]: (p) => ({
    subject: `A memory just opened 💜`,
    title: `${s(p, 'title', 'Your memory')} is open`,
    lines: [
      `${s(p, 'wishCount', 'A few')} wishes were waiting inside.`,
      'Tap to open it and read them.',
    ],
    cta: { label: 'Open the memory', url: s(p, 'url') },
  }),
  [NotificationType.MEMORY_REPLY]: (p) => ({
    subject: `${s(p, 'authorName', 'Someone')} replied to your memory 💌`,
    title: `${s(p, 'authorName', 'Someone')} wrote back`,
    lines: [
      `They replied to ${s(p, 'capsuleTitle', 'the memory')} you sent them.`,
      'Tap to see what they said.',
    ],
    cta: { label: 'Read the reply', url: s(p, 'url') },
  }),
  [NotificationType.CONTENT_REMOVED]: (p) => ({
    subject: 'A note about your content',
    title: 'Your content was removed',
    lines: [
      `Some content you posted (${s(p, 'targetType', 'an item')}) was removed after review.`,
      s(p, 'reason', 'It did not meet our community guidelines.'),
    ],
  }),
};

const escapeHtml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The shared Wishtick email shell — header, body, optional CTA, and a footer
 * carrying the one-click unsubscribe link every non-critical email must have.
 */
const layout = (content: Content, unsubscribeUrl: string | null): string => {
  const paragraphs = content.lines
    .map(
      (l) =>
        `<mj-text font-size="15px" line-height="1.5" color="#3f3f46">${escapeHtml(l)}</mj-text>`,
    )
    .join('');
  const cta =
    content.cta && content.cta.url
      ? `<mj-button href="${escapeHtml(content.cta.url)}" background-color="#7c3aed" border-radius="8px" font-size="15px">${escapeHtml(content.cta.label)}</mj-button>`
      : '';
  const unsub = unsubscribeUrl
    ? `<mj-text font-size="12px" color="#a1a1aa" align="center">You're receiving this from Wishtick. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#a1a1aa;">Unsubscribe</a>.</mj-text>`
    : '';
  return `<mjml>
  <mj-body background-color="#f4f4f5">
    <mj-section padding="24px 0"><mj-column><mj-text align="center" font-size="22px" font-weight="700" color="#7c3aed">Wishtick</mj-text></mj-column></mj-section>
    <mj-section background-color="#ffffff" border-radius="12px" padding="8px 16px"><mj-column>
      <mj-text font-size="19px" font-weight="700" color="#18181b">${escapeHtml(content.title)}</mj-text>
      ${paragraphs}
      ${cta}
    </mj-column></mj-section>
    <mj-section padding="16px 0"><mj-column>${unsub}</mj-column></mj-section>
  </mj-body>
</mjml>`;
};

@Injectable()
export class NotificationRenderer {
  /** In-app title/body (and SMS one-liner) — synchronous, no MJML compilation. */
  content(
    type: NotificationType,
    payload: Record<string, unknown>,
  ): {
    subject: string;
    title: string;
    text: string;
    sms: string;
  } {
    const c = CONTENT[type](payload);
    const text = c.lines.join('\n\n') + (c.cta?.url ? `\n\n${c.cta.label}: ${c.cta.url}` : '');
    // SMS: the headline plus a link if there is one — kept to one line.
    const sms = c.cta?.url ? `${c.title} — ${c.cta.url}` : c.title;
    return { subject: c.subject, title: c.title, text, sms };
  }

  /** Full render including the MJML-compiled HTML for email. Async (MJML v5). */
  async render(
    type: NotificationType,
    payload: Record<string, unknown>,
    opts: { unsubscribeUrl?: string | null } = {},
  ): Promise<RenderedNotification> {
    const c = CONTENT[type](payload);
    const flat = this.content(type, payload);
    const { html } = await mjml2html(layout(c, opts.unsubscribeUrl ?? null), {
      validationLevel: 'skip',
    });
    return { ...flat, html };
  }
}
