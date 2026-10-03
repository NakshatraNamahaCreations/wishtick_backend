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
  [NotificationType.GROUP_GIFT_INVITE]: (p) =>
    // Added, with a share: say what it is, and that they can opt out.
    Number(p.shareMinor ?? 0) > 0
      ? {
          subject: `${who(p, 'inviterName')} added you to a group gift`,
          title: `Your share is ${money(p, 'shareMinor')}`,
          lines: [
            `${who(p, 'inviterName')} added you to the group gift for ${s(p, 'itemTitle', 'a gift')}, split equally.`,
            'Not interested? You can opt out, and the shares are worked out again.',
          ],
          cta: { label: 'See the group gift', url: s(p, 'url') },
        }
      : {
          subject: `${who(p, 'inviterName')} asked you to chip in`,
          title: 'Join a group gift',
          lines: [
            `${who(p, 'inviterName')} invited you to chip in for ${s(p, 'itemTitle', 'a gift')}.`,
          ],
          cta: { label: 'See the invitation', url: s(p, 'url') },
        },
  [NotificationType.GROUP_GIFT_SHARE_REMINDER]: (p) => ({
    subject: `Your share for ${s(p, 'title', 'the group gift')}`,
    title: `${money(p, 'owesMinor')} left to chip in`,
    lines: [
      Number(p.paidMinor ?? 0) > 0
        ? `You've paid ${money(p, 'paidMinor')} of your ${money(p, 'shareMinor')} share for ${s(p, 'title', 'the group gift')}.`
        : `Your share for ${s(p, 'title', 'the group gift')} is ${money(p, 'shareMinor')}.`,
      'Chip in today so the gift can be bought in time.',
    ],
    cta: { label: 'Chip in', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_INVITE_REMINDER]: (p) => ({
    subject: `You're invited to chip in for ${s(p, 'title', 'a group gift')}`,
    title: `Your share is ${money(p, 'owesMinor')}`,
    lines: [
      `Split equally, your share for ${s(p, 'title', 'the group gift')} is ${money(p, 'shareMinor')}.`,
      'Chip in to join the group.',
    ],
    cta: { label: 'See the invitation', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_CANCELLED]: (p) => ({
    subject: `${who(p, 'hostName')} cancelled the group gift`,
    title: `${s(p, 'title', 'A group gift')} was cancelled`,
    // One line: in-app and push show only the first, and the reason and the
    // money are the two things each person needs to read.
    lines: [
      [
        `${who(p, 'hostName')} cancelled the group gift for ${s(p, 'title', 'a gift')}.`,
        ...(s(p, 'reason') ? [`Reason: ${s(p, 'reason')}.`] : []),
        Number(p.refundedMinor ?? 0) > 0
          ? `Your ${money(p, 'refundedMinor')} is counted as refunded to you.`
          : "You don't owe anything for it now.",
      ].join(' '),
    ],
    cta: { label: 'See the group gift', url: s(p, 'url') },
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
  [NotificationType.WISHMATE_REQUEST]: (p) => ({
    subject: `${who(p, 'requesterName')} wants to be your WishMate`,
    title: `${who(p, 'requesterName')} wants to be your WishMate`,
    lines: [`Accept to share wishlists, events and gifts with them.`],
    cta: { label: 'View the request', url: s(p, 'url') },
  }),
  [NotificationType.WISHMATE_ACCEPTED]: (p) => ({
    subject: `${who(p, 'accepterName')} is now your WishMate`,
    title: `${who(p, 'accepterName')} accepted your request`,
    lines: [`You can now share wishlists, events and gifts with each other.`],
    cta: { label: 'View their profile', url: s(p, 'url') },
  }),
  [NotificationType.CHAT_MESSAGE]: (p) => ({
    subject: `${who(p, 'senderName')} sent you a message`,
    title: `${who(p, 'senderName')}${s(p, 'chatTitle') ? ` in ${s(p, 'chatTitle')}` : ''}`,
    // The message itself, so it can be read without opening anything — the
    // point of a chat notification. Trimmed by the emitter, not here.
    lines: [s(p, 'preview', 'Sent you a message.')],
    cta: { label: 'Open the chat', url: s(p, 'url') },
  }),
  [NotificationType.EVENT_REMINDER]: (p) => ({
    subject: `Reminder: ${s(p, 'eventTitle', 'your event')} ${s(p, 'whenText', 'soon')}`,
    title: `${s(p, 'eventTitle', 'Your event')} is ${s(p, 'whenText', 'coming up')}`,
    lines: [`${s(p, 'eventTitle', 'Your event')} is ${s(p, 'whenText', 'coming up')}.`],
    cta: { label: 'View the event', url: s(p, 'url') },
  }),
  /**
   * "Siya's Birthday is in a week" — or, when the year they were born is a
   * real one, "Siya turns 25 in a week", which is the thing worth knowing and
   * the thing a card would say.
   *
   * No CTA: this type has no email, and a push carries its destination in its
   * data rather than in its words.
   */
  [NotificationType.CELEBRATION_REMINDER]: (p) => {
    const person = who(p, 'personName');
    const when = s(p, 'whenText', 'soon');
    const age = Number(p.turningAge);
    const headline =
      Number.isFinite(age) && age > 0
        ? `${person} turns ${age} ${when}`
        : `${person}'s ${s(p, 'occasionLabel', 'celebration')} is ${when}`;
    return {
      subject: headline,
      title: headline,
      lines: [`${headline}. Time to find something.`],
    };
  },
  [NotificationType.EVENT_INVITE]: (p) => ({
    subject: `${who(p, 'hostName')} invited you to ${s(p, 'eventTitle', 'an event')}`,
    title: `You're invited to ${s(p, 'eventTitle', 'an event')}`,
    lines: [
      `${who(p, 'hostName')} invited you to ${s(p, 'eventTitle', 'their event')}.`,
      'Open the invitation to RSVP.',
    ],
    cta: { label: 'View the invitation', url: s(p, 'url') },
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
  [NotificationType.EVENT_JOIN_REQUESTED]: (p) => ({
    subject: `${who(p, 'requesterName')} asked to join ${s(p, 'eventTitle', 'your event')}`,
    title: `${who(p, 'requesterName')} asked to join`,
    lines: [
      `${who(p, 'requesterName')} opened the link to ${s(p, 'eventTitle', 'your event')} and asked to come.`,
      'Accept or decline them from the event.',
    ],
    cta: { label: 'Review the request', url: s(p, 'url') },
  }),
  [NotificationType.EVENT_JOIN_ACCEPTED]: (p) => ({
    subject: `You're in — ${s(p, 'eventTitle', 'the event')}`,
    title: 'Your request was accepted',
    lines: [
      `The host accepted your request to join ${s(p, 'eventTitle', 'their event')}.`,
      'Open the invitation to RSVP.',
    ],
    cta: { label: 'View the invitation', url: s(p, 'url') },
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
  /**
   * "Priya is coming to Diwali Night (+2)" — the answer first, since that is
   * the whole of what the host wants from it.
   */
  [NotificationType.EVENT_RSVP]: (p) => {
    const guest = who(p, 'guestName');
    const event = s(p, 'eventTitle', 'your event');
    const extra = Number(p.plusOnes);
    const plus = Number.isFinite(extra) && extra > 0 ? ` (+${extra})` : '';
    // Each answer named outright, and anything else left neutral: a missing
    // response reading as "can't make it" would tell a host a guest declined.
    const headline =
      p.response === 'yes'
        ? `${guest} is coming to ${event}${plus}`
        : p.response === 'maybe'
          ? `${guest} might come to ${event}${plus}`
          : p.response === 'no'
            ? `${guest} can't make it to ${event}`
            : `${guest} replied to ${event}`;
    return {
      subject: headline,
      title: headline,
      lines: [`${headline}.`],
      cta: { label: 'See the guest list', url: s(p, 'url') },
    };
  },
  [NotificationType.EVENT_CANCELLED]: (p) => {
    const event = s(p, 'eventTitle', 'The event');
    const when = s(p, 'whenText');
    return {
      subject: `${event} has been cancelled`,
      title: `${event} has been cancelled`,
      lines: [
        when
          ? `${who(p, 'hostName')} cancelled ${event}, planned for ${when}.`
          : `${who(p, 'hostName')} cancelled ${event}.`,
      ],
      cta: { label: 'View the invitation', url: s(p, 'url') },
    };
  },
  /**
   * What moved, with its new value — "It's now on Sat, 19 Sep · 7:00 PM" —
   * so the notice is enough on its own and nobody has to open the invitation
   * to find out what "changed" meant.
   */
  [NotificationType.EVENT_UPDATED]: (p) => {
    const event = s(p, 'eventTitle', 'Your event');
    const changes = Array.isArray(p.changes) ? (p.changes as string[]) : [];
    const moved = changes.includes('time');
    const venueMoved = changes.includes('venue');
    const venue = s(p, 'venue');
    const title =
      moved && venueMoved
        ? `${event} has a new time and place`
        : moved
          ? `${event} has moved`
          : venueMoved
            ? `${event} has a new venue`
            : `${event} has been updated`;
    // One line, not one per change: a push and a notification-centre row
    // both show only the first, and a new time with the venue cut off below
    // it is half the news.
    const said = [
      ...(moved ? [`It's now on ${s(p, 'whenText', 'a new date')}.`] : []),
      ...(venueMoved
        ? [venue ? `New venue: ${venue}.` : 'The venue has been taken off the invitation.']
        : []),
    ].join(' ');
    return {
      subject: title,
      title,
      lines: [said || `${who(p, 'hostName')} updated ${event}.`],
      cta: { label: 'View the invitation', url: s(p, 'url') },
    };
  },
  /**
   * "Priya shared Priya's Birthday with you" — or, for several at once,
   * "Priya shared 3 memories with you".
   */
  [NotificationType.MEMORY_SHARED]: (p) => {
    const owner = who(p, 'ownerName');
    const count = Number(p.count);
    const headline =
      Number.isFinite(count) && count > 1
        ? `${owner} shared ${count} memories with you`
        : `${owner} shared ${s(p, 'title', 'a memory')} with you`;
    return {
      subject: headline,
      title: headline,
      lines: ['Open it to watch the wishes inside.'],
      cta: { label: 'Watch it', url: s(p, 'url') },
    };
  },
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
