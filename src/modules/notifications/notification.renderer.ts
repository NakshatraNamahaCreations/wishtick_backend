import { Injectable, Optional } from '@nestjs/common';
import mjml2html from 'mjml';
import { NotificationWordingStore } from './notification-wording.store';
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

/**
 * A payload that writes each detail out as its fill-in — `{itemTitle}`, or
 * `{itemTitle|a gift}` with its fallback — so rendering the built-in copy with
 * it gives that copy as an editable template.
 */
const PROBE = Symbol('wording-probe');
type Payload = Record<string | symbol, unknown>;

const s = (p: Payload, key: string, fallback = ''): string => {
  if (p[PROBE]) return fallback ? `{${key}|${fallback}}` : `{${key}}`;
  const v = p[key];
  return typeof v === 'string' && v.trim() ? v : fallback;
};

const money = (p: Payload, key: string): string => {
  if (p[PROBE]) return `{${key}}`;
  const minor = p[key];
  const currency = s(p, 'currency', 'INR');
  if (typeof minor !== 'number') return '';
  return `${currency} ${(minor / 100).toFixed(2)}`;
};

/** A fill-in in saved wording: `{key}` or `{key|fallback}`. */
const FILL_IN = /\{([a-zA-Z][a-zA-Z0-9]*)(?:\|([^{}]*))?\}/g;

/** Details that are links, not words: never offered as a fill-in. */
const NOT_WORDS = new Set(['url', 'appUrl', 'currency', 'imageUrl']);

/** Saved wording with [payload]'s details put in; a missing one takes its fallback. */
export function fillWording(
  template: string,
  payload: Record<string, unknown>,
  /** Each detail's stand-in when it is missing, for fill-ins written without one. */
  fallbacks: Record<string, string> = {},
): string {
  return template
    .replace(FILL_IN, (_, key: string, written?: string) => {
      const fallback = written ?? fallbacks[key] ?? '';
      if (/Minor$/.test(key)) return money(payload, key) || fallback;
      const v = payload[key];
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      return s(payload, key, fallback);
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** The fill-ins a piece of wording uses. */
export function fillInsOf(template: string): string[] {
  return [...template.matchAll(FILL_IN)].map((m) => m[1]);
}

/** Someone/anonymous-safe name. */
const who = (p: Payload, key: string): string => s(p, key, 'Someone');

/**
 * The per-type copy. Pure functions of the (already-resolved) payload, so they
 * are trivially snapshot-tested and the renderer never reaches back into the
 * database. Adding a type is adding an entry, matching the registry.
 */
const CONTENT: Record<NotificationType, (p: Payload) => Content> = {
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
          : Number(p.pendingMinor ?? 0) > 0
            ? `${who(p, 'hostName')} hadn't confirmed your ${money(p, 'pendingMinor')} yet — if you sent it, ask them for it back.`
            : "You don't owe anything for it now.",
      ].join(' '),
    ],
    cta: { label: 'See the group gift', url: s(p, 'url') },
  }),
  // In-app and push show the first line only, so each says it all in one.
  [NotificationType.GROUP_GIFT_PAYMENT_TO_CONFIRM]: (p) => ({
    subject: `Did ${who(p, 'contributorName')}'s ${money(p, 'amountMinor')} arrive?`,
    title: `Confirm ${who(p, 'contributorName')}'s payment`,
    lines: [
      `${who(p, 'contributorName')} says they sent you ${money(p, 'amountMinor')} for ${s(p, 'title', 'the group gift')}. Check it arrived and confirm.`,
    ],
    cta: { label: 'Confirm the payment', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_PAYMENT_REVIEWED]: (p) => {
    const received = Number(p.receivedMinor ?? 0);
    const claimed = Number(p.claimedMinor ?? 0);
    const host = who(p, 'hostName');
    const gift = s(p, 'title', 'the group gift');
    return received >= claimed
      ? {
          subject: `${host} received your payment`,
          title: 'Payment confirmed',
          lines: [`${host} received your ${money(p, 'receivedMinor')} for ${gift}.`],
          cta: { label: 'See the group gift', url: s(p, 'url') },
        }
      : received > 0
        ? {
            subject: `${host} received ${money(p, 'receivedMinor')} of your ${money(p, 'claimedMinor')}`,
            title: 'Part of your payment arrived',
            lines: [
              `${host} received ${money(p, 'receivedMinor')} of the ${money(p, 'claimedMinor')} you sent for ${gift}. If you sent it all, tell them in the app.`,
            ],
            cta: { label: 'See your payment', url: s(p, 'url') },
          }
        : {
            subject: `${host} hasn't received your payment`,
            title: 'Your payment has not arrived',
            lines: [
              `${host} hasn't received the ${money(p, 'claimedMinor')} you sent for ${gift}. If you did send it, tell them in the app.`,
            ],
            cta: { label: 'See your payment', url: s(p, 'url') },
          };
  },
  [NotificationType.GROUP_GIFT_PAYMENT_DISPUTED]: (p) => ({
    subject: `${who(p, 'contributorName')} says they paid`,
    title: `${who(p, 'contributorName')} says they sent ${money(p, 'claimedMinor')}`,
    lines: [
      [
        `${who(p, 'contributorName')} says they sent ${money(p, 'claimedMinor')} for ${s(p, 'title', 'the group gift')}; you recorded ${money(p, 'receivedMinor')}.`,
        ...(s(p, 'paymentRef') ? [`UPI ref: ${s(p, 'paymentRef')}.`] : []),
        ...(s(p, 'note') ? [`"${s(p, 'note')}"`] : []),
      ].join(' '),
    ],
    cta: { label: 'Check the payment', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_CONFIRM_REMINDER]: (p) => ({
    subject: `Payments waiting for you on ${s(p, 'title', 'your group gift')}`,
    title:
      Number(p.count ?? 0) === 1
        ? '1 payment to confirm'
        : `${p[PROBE] ? '{count}' : Number(p.count ?? 0)} payments to confirm`,
    lines: [
      `${money(p, 'totalMinor')} for ${s(p, 'title', 'your group gift')} is waiting for you to confirm it arrived. It doesn't count until you do.`,
    ],
    cta: { label: 'Confirm payments', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_CHARGE_ADDED]: (p) => ({
    subject: `${who(p, 'hostName')} added ${s(p, 'label', 'a charge')} to ${s(p, 'title', 'the group gift')}`,
    title: `${s(p, 'label', 'A charge')} added: ${money(p, 'amountMinor')}`,
    lines: [
      `${who(p, 'hostName')} added ${s(p, 'label', 'a charge')} of ${money(p, 'amountMinor')} to ${s(p, 'title', 'the group gift')}. Reason: ${s(p, 'reason', 'not given')}. The total is now ${money(p, 'targetAmountMinor')}.`,
    ],
    cta: { label: 'See the group gift', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_SETTLED]: (p) => ({
    subject: `${s(p, 'title', 'The group gift')} is fully funded`,
    title: 'Nothing more to pay',
    lines: [
      `${who(p, 'hostName')} paid the remaining ${money(p, 'amountMinor')} for ${s(p, 'title', 'the group gift')}. It's fully funded — nothing more is needed from you.`,
    ],
    cta: { label: 'See the group gift', url: s(p, 'url') },
  }),
  [NotificationType.GROUP_GIFT_PRICE_CHANGED]: (p) => {
    const item = s(p, 'itemTitle', 'a gift');
    const group = s(p, 'title', 'your group gift');
    if (typeof p.toMinor !== 'number') {
      return {
        subject: `${item} is out of stock`,
        title: 'Out of stock at the shop',
        lines: [
          `${item} in ${group} is out of stock at the shop. Open the group gift to add another gift or decide what to do.`,
        ],
        cta: { label: 'See the group gift', url: s(p, 'url') },
      };
    }
    const cheaper = p.toMinor < Number(p.fromMinor ?? 0);
    return {
      subject: `Price ${cheaper ? 'dropped' : 'went up'} on ${item}`,
      title: `${cheaper ? 'Price dropped' : 'Price went up'}: ${money(p, 'toMinor')}`,
      lines: [
        `${item} in ${group} is now ${money(p, 'toMinor')}, ${cheaper ? 'down' : 'up'} from ${money(p, 'fromMinor')}. Open the group gift to use the new price or keep the goal as it is.`,
      ],
      cta: { label: 'See the group gift', url: s(p, 'url') },
    };
  },
  [NotificationType.GROUP_GIFT_PRICE_UPDATED]: (p) => {
    const host = who(p, 'hostName');
    const moved = `${host} updated ${s(p, 'itemTitle', 'a gift')} to the shop's new price, ${money(p, 'toMinor')} (was ${money(p, 'fromMinor')}). The goal is now ${money(p, 'targetAmountMinor')}.`;
    const short = Number(p.shortfallMinor ?? 0);
    const refund = Number(p.refundMinor ?? 0);
    // What it means for the reader's money, which is why they are being told.
    const [title, then] =
      short > 0
        ? [
            'The price went up',
            ` ${money(p, 'shortfallMinor')} more is needed — open the group gift to see your part.`,
          ]
        : refund > 0
          ? [
              'Money is coming back',
              ` More has been collected than that, so ${host} will refund ${money(p, 'refundMinor')} to the group.`,
            ]
          : p.refundCancelled === true
            ? [
                'No refund needed',
                ' The price is back, so the refund you were expecting is no longer needed.',
              ]
            : [`New goal: ${money(p, 'targetAmountMinor')}`, ''];
    const gift = s(p, 'title', 'The group gift');
    const subject =
      short > 0
        ? `${gift}: ${money(p, 'shortfallMinor')} more is needed`
        : refund > 0
          ? `${gift}: money is coming back to the group`
          : p.refundCancelled === true
            ? `${gift}: no refund needed after all`
            : `${gift}: the goal is now ${money(p, 'targetAmountMinor')}`;
    return {
      subject,
      title,
      lines: [moved + then],
      cta: { label: 'See the group gift', url: s(p, 'url') },
    };
  },
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
    // A WishMate reminded of somebody's shared date is told whose it is —
    // "Ananya" alone is a stranger to them; "Suma's Mother" is not.
    const owner = s(p, 'ownerName', '');
    const relation = s(p, 'relation', '');
    const whose = owner
      ? relation
        ? ` — ${owner}'s ${relation}`
        : ` — from ${owner}'s dates`
      : '';
    return {
      subject: headline,
      title: headline,
      lines: [`${headline}${whose}. Time to find something.`],
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

    // A change to an earlier answer says what moved, in the app's own words
    // (Going / Maybe / Not going) and in people including the guest — the
    // "2 of you" the guest picked — so the host sees "2 → 4", not "+1 → +3".
    // A first reply, or a row queued before this existed, has no earlier
    // answer and falls through to the plain headline below.
    const label: Record<string, string> = { yes: 'Going', maybe: 'Maybe', no: 'Not going' };
    const prev = typeof p.previousResponse === 'string' ? p.previousResponse : '';
    const now = typeof p.response === 'string' ? p.response : '';
    if (label[prev] && label[now]) {
      const heads = (plusOnes: unknown): number => {
        const n = Number(plusOnes);
        return (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0) + 1;
      };
      const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;
      const before = heads(p.previousPlusOnes);
      const after = heads(p.plusOnes);
      // A "no" carries no head count, so there is nothing to compare from it.
      const countMoved = prev !== 'no' && now !== 'no' && before !== after;

      const title =
        prev !== now
          ? `${guest} changed their RSVP: ${label[prev]} → ${label[now]}`
          : `${guest} changed their head count: ${before} → ${after}`;
      const detail =
        now === 'no'
          ? `${event} · ${label[now]}`
          : `${event} · ${label[now]} · ${countMoved ? `${before} → ${people(after)}` : people(after)}`;
      return {
        subject: title,
        title,
        lines: [`${detail}.`],
        cta: { label: 'See the guest list', url: s(p, 'url') },
      };
    }

    // Each answer named outright, and anything else left neutral: a missing
    // response reading as "can't make it" would tell a host a guest declined.
    const headline =
      p.response === 'yes'
        ? `${guest} is coming to ${event}${plus}`
        : p.response === 'maybe'
          ? `${guest} isn't sure about coming to ${event}${plus}`
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
   * No link: the invitation was deleted with the event, so there is nothing
   * left to open, and a button to a dead page is worse than none.
   */
  [NotificationType.EVENT_DELETED]: (p) => {
    const event = s(p, 'eventTitle', 'The event');
    const when = s(p, 'whenText');
    return {
      subject: `${event} has been deleted`,
      title: `${event} has been deleted`,
      lines: [
        when
          ? `${who(p, 'hostName')} deleted ${event}, planned for ${when}.`
          : `${who(p, 'hostName')} deleted ${event}.`,
      ],
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
   * "Priya shared wishes from 3 occasions with you" — the count is of
   * occasions, not of single wishes.
   */
  [NotificationType.MEMORY_SHARED]: (p) => {
    const owner = who(p, 'ownerName');
    const count = Number(p.count);
    const headline =
      Number.isFinite(count) && count > 1
        ? `${owner} shared wishes from ${count} occasions with you`
        : `${owner} shared ${s(p, 'title', 'some wishes')} with you`;
    return {
      subject: headline,
      title: headline,
      lines: ['Open them to watch every wish inside.'],
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
    subject: `The wishes just opened 💜`,
    // "Suma's Birthday is open" — the title is one thing; without it, the
    // wishes are many.
    title: s(p, 'title') ? `${s(p, 'title')} is open` : 'Your wishes are open',
    lines: [
      `${s(p, 'wishCount', 'A few')} wishes were waiting inside.`,
      'Tap to open it and read them.',
    ],
    cta: { label: 'Open the wishes', url: s(p, 'url') },
  }),
  [NotificationType.MEMORY_REPLY]: (p) => ({
    subject: `${s(p, 'authorName', 'Someone')} replied to your wishes 💌`,
    title: `${s(p, 'authorName', 'Someone')} wrote back`,
    lines: [
      `They replied to ${s(p, 'capsuleTitle', 'the wishes')} you sent them.`,
      'Tap to see what they said.',
    ],
    cta: { label: 'Read the reply', url: s(p, 'url') },
  }),
  [NotificationType.MEMORY_WISH_LOVED]: (p) => ({
    subject: `${s(p, 'lovedByName', 'Someone')} loved your wish ❤️`,
    title: `${s(p, 'lovedByName', 'Someone')} loved your wish ❤️`,
    lines: [
      s(p, 'capsuleTitle')
        ? `Your wish in ${s(p, 'capsuleTitle')} made their day.`
        : 'Your wish made their day.',
    ],
    cta: { label: 'See your wish', url: s(p, 'url') },
  }),
  /**
   * "Priya invited you to add a wish" — the capsule's title and that it is
   * sealed, and nothing else. What anybody else wrote is not the invitee's to
   * read, now or after it opens.
   */
  [NotificationType.MEMORY_WISH_INVITED]: (p) => {
    const headline = `${who(p, 'hostName')} invited you to add a wish`;
    return {
      subject: headline,
      title: headline,
      lines: [`Add your wish to ${s(p, 'title', 'their wishes')} — it opens on the day.`],
      cta: { label: 'Add your wish', url: s(p, 'url') },
    };
  },
  [NotificationType.ADMIN_ANNOUNCEMENT]: (p) => ({
    subject: s(p, 'title', 'News from Wishtick'),
    title: s(p, 'title', 'News from Wishtick'),
    lines: [s(p, 'body')].filter(Boolean),
    ...(s(p, 'url') ? { cta: { label: s(p, 'ctaLabel', 'Take a look'), url: s(p, 'url') } } : {}),
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

/** Details that say yes or no, which read as nothing in a sentence. */
const FLAGS = new Set(['approved', 'refundCancelled']);

/**
 * One notification's built-in wording as a template, and the details it can
 * use: rendered with a payload that answers every question with its fill-in
 * and remembers what was asked.
 */
export function builtInWording(type: NotificationType): {
  title: string;
  body: string;
  fillIns: string[];
  /** What the built-in copy says when a detail is missing — "Someone", "a gift". */
  fallbacks: Record<string, string>;
} {
  const asked = new Set<string>();
  const probe = new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === PROBE) return true;
        if (typeof key === 'string') asked.add(key);
        return undefined;
      },
    },
  );
  const c = CONTENT[type](probe);
  const title = c.title;
  const body = c.lines[0] ?? '';
  const fillIns = [...new Set([...fillInsOf(title), ...fillInsOf(body), ...asked])].filter(
    (k) => !NOT_WORDS.has(k) && !FLAGS.has(k),
  );
  const fallbacks: Record<string, string> = {};
  for (const m of [title, ...c.lines].join('\n').matchAll(FILL_IN)) {
    if (m[2] && !(m[1] in fallbacks)) fallbacks[m[1]] = m[2];
  }
  return { title, body, fillIns, fallbacks };
}

/** Built-in fallbacks per type, worked out once. */
const FALLBACKS = new Map<NotificationType, Record<string, string>>();
const fallbacksOf = (type: NotificationType): Record<string, string> => {
  let f = FALLBACKS.get(type);
  if (!f) {
    f = builtInWording(type).fallbacks;
    FALLBACKS.set(type, f);
  }
  return f;
};

@Injectable()
export class NotificationRenderer {
  constructor(@Optional() private readonly wording?: NotificationWordingStore) {}

  /** The copy for [type], with an admin's saved wording in place of the built-in one. */
  private contentOf(type: NotificationType, payload: Record<string, unknown>): Content {
    const c = CONTENT[type](payload);
    const saved = this.wording?.get(type);
    if (!saved) return c;
    const fallbacks = fallbacksOf(type);
    return {
      ...c,
      title: fillWording(saved.title, payload, fallbacks) || c.title,
      lines: [fillWording(saved.body, payload, fallbacks) || (c.lines[0] ?? '')],
    };
  }

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
    const c = this.contentOf(type, payload);
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
    const c = this.contentOf(type, payload);
    const flat = this.content(type, payload);
    const { html } = await mjml2html(layout(c, opts.unsubscribeUrl ?? null), {
      validationLevel: 'skip',
    });
    return { ...flat, html };
  }
}
