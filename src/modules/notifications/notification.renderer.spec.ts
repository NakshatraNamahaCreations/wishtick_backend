import { NotificationRenderer } from './notification.renderer';
import { NOTIFICATION_SPECS, NotificationType, isCritical, isDigest } from './notification.types';

/**
 * The copy is data, tested as data. Snapshotting the rendered content pins every
 * template so a wording change is a visible diff, not a silent one, and proves
 * each type has a builder.
 */
describe('NotificationRenderer', () => {
  const renderer = new NotificationRenderer();

  // A single rich payload; each builder reads the fields it needs and ignores
  // the rest, so one object exercises them all deterministically.
  const payload = {
    name: 'Aarav',
    itemTitle: 'Noise-cancelling headphones',
    wishlistTitle: 'Birthday list',
    contributorName: 'Priya',
    joinerName: 'Rohan',
    hostName: 'Rohan',
    recipientName: 'Siya',
    otherName: 'Priya',
    amountMinor: 50_000,
    collectedAmountMinor: 150_000,
    targetAmountMinor: 200_000,
    shortMinor: 50_000,
    owesMinor: 25_000,
    snapshotAmountMinor: 249_900,
    currentAmountMinor: 199_900,
    currency: 'INR',
    day: 3,
    stillToPay: 2,
    deadlineText: '24 Oct',
    hostUpiId: 'rohan@upi',
    upiId: 'priya@upi',
    note: 'For the speaker',
    paymentRef: '123456789012',
    direction: 'top_up',
    eventTitle: "Aarav's Birthday",
    whenText: 'in 2 days',
    subject: 'Thank you!',
    body: 'Thank you so much for the wonderful gift.',
    message: 'Your password was changed.',
    title: 'Password changed',
    url: 'https://app.wishtick.test/x',
    appUrl: 'https://app.wishtick.test',
  };

  it('renders in-app/text/sms content for every notification type', () => {
    for (const type of Object.values(NotificationType)) {
      expect(renderer.content(type, payload)).toMatchSnapshot(type);
    }
  });

  /** To a group gift's host: the shop's price moved under their bill. */
  describe('a group gift price change', () => {
    const changed = (over: Record<string, unknown>) =>
      renderer.content(NotificationType.GROUP_GIFT_PRICE_CHANGED, {
        title: 'Speaker for Siya',
        itemTitle: 'Smart Speaker',
        fromMinor: 349_900,
        currency: 'INR',
        url: 'https://app.wishtick.test/x',
        ...over,
      });

    it('says a drop is a drop, with both prices', () => {
      const c = changed({ toMinor: 299_900 });
      expect(c.subject).toBe('Price dropped on Smart Speaker');
      expect(c.text).toContain('is now INR 2999.00, down from INR 3499.00');
    });

    it('says a rise is a rise', () => {
      expect(changed({ toMinor: 399_900 }).subject).toBe('Price went up on Smart Speaker');
    });

    const updated = (over: Record<string, unknown>) =>
      renderer.content(NotificationType.GROUP_GIFT_PRICE_UPDATED, {
        title: 'Speaker for Siya',
        itemTitle: 'Smart Speaker',
        hostName: 'Rohan',
        fromMinor: 349_900,
        toMinor: 299_900,
        targetAmountMinor: 299_900,
        currency: 'INR',
        url: 'https://app.wishtick.test/x',
        ...over,
      });

    it('tells members money is coming back after a drop', () => {
      const c = updated({ refundMinor: 50_000 });
      expect(c.title).toBe('Money is coming back');
      expect(c.text).toContain('Rohan will refund INR 500.00 to the group');
    });

    it('tells members no refund is needed when the price came back', () => {
      const c = updated({ toMinor: 349_900, targetAmountMinor: 349_900, refundCancelled: true });
      expect(c.subject).toBe('Speaker for Siya: no refund needed after all');
    });

    it('asks members for more when the price rose after a refund', () => {
      const c = updated({ toMinor: 349_900, targetAmountMinor: 349_900, shortfallMinor: 50_000 });
      expect(c.subject).toBe('Speaker for Siya: INR 500.00 more is needed');
      expect(c.title).toBe('The price went up');
    });

    it('says out of stock when there is no price', () => {
      expect(changed({ toMinor: null, outOfStock: true }).subject).toBe(
        'Smart Speaker is out of stock',
      );
    });
  });

  /**
   * The deadline passed short of the goal, and what follows from it. The
   * same type reads differently to the host, who has a decision to make, and
   * to a member, who has not.
   */
  describe('a closed collection', () => {
    const closed = (over: Record<string, unknown>) =>
      renderer.content(NotificationType.GROUP_GIFT_CLOSED, {
        title: 'Speaker for Siya',
        hostName: 'Rohan',
        shortMinor: 50_000,
        currency: 'INR',
        url: 'https://app.wishtick.test/x',
        ...over,
      });

    it('asks the host to decide, and says what happens if they do not', () => {
      const c = closed({ isHost: true });
      expect(c.subject).toBe('Speaker for Siya: the deadline has passed');
      expect(c.text).toContain('closed INR 500.00 short of its goal');
      expect(c.text).toContain('Settle up, extend the deadline or cancel it');
      expect(c.text).toContain("it's cancelled in a week");
      expect(c.text).toContain('Decide what to do: https://app.wishtick.test/x');
    });

    it('tells a member the host decides what next', () => {
      const c = closed({ isHost: false });
      expect(c.subject).toBe('Speaker for Siya has closed');
      expect(c.text).toContain('Rohan will settle up, extend the deadline or cancel it.');
      expect(c.text).not.toContain('short');
    });

    const remind = (over: Record<string, unknown>) =>
      renderer.content(NotificationType.GROUP_GIFT_DEADLINE_REMINDER, {
        title: 'Speaker for Siya',
        deadlineText: '24 Oct',
        currency: 'INR',
        url: 'https://app.wishtick.test/x',
        ...over,
      });

    it('counts the days down for a member who owes', () => {
      expect(remind({ day: 3, owesMinor: 25_000 }).title).toBe(
        '3 days left to chip in for Speaker for Siya',
      );
      const last = remind({ day: 1, owesMinor: 25_000 });
      expect(last.title).toBe('Last day to chip in for Speaker for Siya');
      expect(last.text).toContain('Your INR 250.00 share for Speaker for Siya is due by 24 Oct.');
    });

    it('names no share on a custom split', () => {
      expect(remind({ day: 3, owesMinor: null }).text).toContain(
        'Speaker for Siya closes on 24 Oct. Chip in before then.',
      );
    });

    it('gives the host a head count instead', () => {
      const c = remind({ day: 1, isHost: true, stillToPay: 1 });
      expect(c.title).toBe('1 person still to pay');
      expect(c.text).toContain('Speaker for Siya closes tomorrow, and 1 person');
      expect(remind({ day: 3, isHost: true, stillToPay: 4 }).title).toBe('4 people still to pay');
    });

    it('says which way a settlement runs', () => {
      const raised = (direction: string) =>
        renderer.content(NotificationType.SETTLEMENT_RAISED, {
          title: 'Speaker for Siya',
          otherName: 'Priya',
          amountMinor: 20_000,
          currency: 'INR',
          direction,
          url: 'https://app.wishtick.test/x',
        });
      expect(raised('return').title).toBe('Return INR 200.00 to Priya');
      expect(raised('top_up').title).toBe('INR 200.00 more for Speaker for Siya');
      expect(raised('top_up').text).toContain('Priya asked you for INR 200.00 more');
    });

    it('offers a link on every one of the new types', () => {
      const types = [
        NotificationType.GROUP_GIFT_CLOSED,
        NotificationType.GROUP_GIFT_CLOSE_REMINDER,
        NotificationType.GROUP_GIFT_DEADLINE_REMINDER,
        NotificationType.GROUP_GIFT_DEADLINE_EXTENDED,
        NotificationType.GROUP_GIFT_UPI_CHANGED,
        NotificationType.GROUP_GIFT_UNSENT_PLEDGE,
        NotificationType.GROUP_GIFT_BUY_REMINDER,
        NotificationType.GROUP_GIFT_NUDGE,
        NotificationType.GROUP_GIFT_WITHDRAWN,
        NotificationType.GROUP_GIFT_THANK_YOU,
        NotificationType.GROUP_GIFT_THANK_YOU_PROMPT,
        NotificationType.GROUP_GIFT_DELIVERED_RECIPIENT,
        NotificationType.SETTLEMENT_RAISED,
        NotificationType.SETTLEMENT_UPI_SHARED,
        NotificationType.SETTLEMENT_SENT,
        NotificationType.SETTLEMENT_CONFIRMED,
      ];
      for (const type of types) {
        expect(renderer.content(type, payload).sms).toContain('— https://app.wishtick.test/x');
      }
    });
  });

  /** A reply, to the host: the answer is the headline. */
  describe('an RSVP', () => {
    const rsvp = (over: Record<string, unknown>) =>
      renderer.content(NotificationType.EVENT_RSVP, {
        guestName: 'Priya',
        eventTitle: 'Diwali Night',
        ...over,
      }).title;

    it('says who is coming, and how many they bring', () => {
      expect(rsvp({ response: 'yes', plusOnes: 2 })).toBe('Priya is coming to Diwali Night (+2)');
      expect(rsvp({ response: 'yes', plusOnes: 0 })).toBe('Priya is coming to Diwali Night');
    });

    it('says maybe as not sure, and no as no', () => {
      expect(rsvp({ response: 'maybe' })).toBe("Priya isn't sure about coming to Diwali Night");
      expect(rsvp({ response: 'no', plusOnes: 3 })).toBe("Priya can't make it to Diwali Night");
    });

    it('a first reply reads as before', () => {
      expect(rsvp({ response: 'yes', plusOnes: 1, previousResponse: 'pending' })).toBe(
        'Priya is coming to Diwali Night (+1)',
      );
    });

    describe('a changed reply', () => {
      const changed = (over: Record<string, unknown>) => {
        const c = renderer.content(NotificationType.EVENT_RSVP, {
          guestName: 'Priya',
          eventTitle: 'Diwali Night',
          ...over,
        });
        return { title: c.title, line: c.text.split('\n')[0] };
      };

      it('names the old and new answer', () => {
        expect(
          changed({ previousResponse: 'maybe', previousPlusOnes: 0, response: 'yes', plusOnes: 0 }),
        ).toEqual({
          title: 'Priya changed their RSVP: Maybe → Going',
          line: 'Diwali Night · Going · 1 person.',
        });
        expect(
          changed({ previousResponse: 'yes', previousPlusOnes: 2, response: 'no', plusOnes: 0 }),
        ).toEqual({
          title: 'Priya changed their RSVP: Going → Not going',
          line: 'Diwali Night · Not going.',
        });
      });

      it('names the old and new head count, in people including the guest', () => {
        expect(
          changed({ previousResponse: 'yes', previousPlusOnes: 1, response: 'yes', plusOnes: 3 }),
        ).toEqual({
          title: 'Priya changed their head count: 2 → 4',
          line: 'Diwali Night · Going · 2 → 4 people.',
        });
      });

      it('shows both when the answer and the count move together', () => {
        expect(
          changed({ previousResponse: 'maybe', previousPlusOnes: 0, response: 'yes', plusOnes: 2 }),
        ).toEqual({
          title: 'Priya changed their RSVP: Maybe → Going',
          line: 'Diwali Night · Going · 1 → 3 people.',
        });
      });

      it('does not compare a count from a "no"', () => {
        expect(
          changed({ previousResponse: 'no', previousPlusOnes: 0, response: 'yes', plusOnes: 2 }),
        ).toEqual({
          title: 'Priya changed their RSVP: Not going → Going',
          line: 'Diwali Night · Going · 3 people.',
        });
      });
    });
  });

  /** A change, to the guests: what moved, with its new value. */
  describe('an event update', () => {
    const update = (changes: string[], venue: string | null = 'The Leela, Bengaluru') =>
      renderer.content(NotificationType.EVENT_UPDATED, {
        eventTitle: 'Diwali Night',
        hostName: 'Rohan',
        whenText: 'Sat, 24 Oct · 7:00 PM',
        venue,
        changes,
        url: 'https://app.wishtick.test/i/t',
      });

    it('a new time names it', () => {
      const c = update(['time']);
      expect(c.title).toBe('Diwali Night has moved');
      expect(c.text).toContain("It's now on Sat, 24 Oct · 7:00 PM.");
      expect(c.text).not.toContain('venue');
    });

    it('a new venue names it', () => {
      const c = update(['venue']);
      expect(c.title).toBe('Diwali Night has a new venue');
      expect(c.text).toContain('New venue: The Leela, Bengaluru.');
    });

    it('both at once say both', () => {
      const c = update(['time', 'venue']);
      expect(c.title).toBe('Diwali Night has a new time and place');
      expect(c.text).toContain("It's now on");
      expect(c.text).toContain('New venue:');
    });

    it('a venue taken away is said as that, not as a blank', () => {
      expect(update(['venue'], null).text).toContain(
        'The venue has been taken off the invitation.',
      );
    });
  });

  /** To a WishMate the host asked to add a wish to a sealed memory. */
  describe('an invitation to add a wish', () => {
    const invited = (over: Record<string, unknown> = {}) =>
      renderer.content(NotificationType.MEMORY_WISH_INVITED, {
        hostName: 'Priya',
        title: "Ananya's Birthday",
        url: 'https://app.wishtick.test/memories/m1/wishes/kind',
        ...over,
      });

    it('names who asked, and what to add a wish to', () => {
      const out = invited();
      expect(out.title).toBe('Priya invited you to add a wish');
      expect(out.text).toContain("Add your wish to Ananya's Birthday — it opens on the day.");
    });

    it('still reads without a name or a title', () => {
      const out = invited({ hostName: undefined, title: undefined });
      expect(out.title).toBe('Someone invited you to add a wish');
      expect(out.text).toContain('Add your wish to their wishes');
    });
  });

  it('a cancellation names the party that is off', () => {
    const c = renderer.content(NotificationType.EVENT_CANCELLED, {
      eventTitle: 'Diwali Night',
      hostName: 'Rohan',
      whenText: 'Sat, 24 Oct · 7:00 PM',
    });
    expect(c.title).toBe('Diwali Night has been cancelled');
    expect(c.text).toContain('Rohan cancelled Diwali Night, planned for Sat, 24 Oct · 7:00 PM.');
  });

  /** The invitation went with the event, so there is nothing to link to. */
  describe('a deleted event', () => {
    it('names the party that is gone, and offers no link to it', () => {
      const c = renderer.content(NotificationType.EVENT_DELETED, {
        eventTitle: 'Diwali Night',
        hostName: 'Rohan',
        whenText: 'Sat, 24 Oct · 7:00 PM',
        url: 'https://app.wishtick.test/i/t',
      });
      expect(c.subject).toBe('Diwali Night has been deleted');
      expect(c.title).toBe('Diwali Night has been deleted');
      expect(c.text).toBe('Rohan deleted Diwali Night, planned for Sat, 24 Oct · 7:00 PM.');
      expect(c.sms).toBe('Diwali Night has been deleted');
    });

    it('still reads without a date', () => {
      const c = renderer.content(NotificationType.EVENT_DELETED, {
        eventTitle: 'Diwali Night',
        hostName: 'Rohan',
      });
      expect(c.text).toBe('Rohan deleted Diwali Night.');
    });
  });

  /**
   * The age is the thing worth knowing — it is what a card would say — but a
   * saved date need not carry a real year, and "turns NaN" is not a sentence.
   */
  describe('a celebration reminder', () => {
    const remind = (over: Record<string, unknown>) =>
      renderer.content(NotificationType.CELEBRATION_REMINDER, {
        personName: 'Siya',
        occasionLabel: 'Birthday',
        whenText: 'in a week',
        ...over,
      }).title;

    it('counts the years when the year saved is a real one', () => {
      expect(remind({ turningAge: 25 })).toBe('Siya turns 25 in a week');
    });

    it('names the occasion instead when it is not', () => {
      expect(remind({ turningAge: null })).toBe("Siya's Birthday is in a week");
      expect(remind({})).toBe("Siya's Birthday is in a week");
    });

    // An occasion somebody named themselves arrives as the label.
    it('uses the name they gave an occasion of their own', () => {
      expect(remind({ turningAge: null, occasionLabel: 'Naming ceremony' })).toBe(
        "Siya's Naming ceremony is in a week",
      );
    });

    // A WishMate reminded of somebody's shared date: "Siya" alone is a
    // stranger to them, so the body says whose she is.
    describe('to a WishMate who asked to be reminded', () => {
      const text = (over: Record<string, unknown>) =>
        renderer.content(NotificationType.CELEBRATION_REMINDER, {
          personName: 'Siya',
          occasionLabel: 'Birthday',
          whenText: 'in 3 days',
          ownerName: 'Suma',
          ...over,
        }).text;

      it('names whose person it is', () => {
        expect(text({ relation: 'Mother' })).toContain(
          "Siya's Birthday is in 3 days — Suma's Mother.",
        );
      });

      it('names whose dates it came from when there is no relation', () => {
        expect(text({ relation: '' })).toContain("— from Suma's dates.");
      });

      it("says nothing of the sort on the owner's own reminder", () => {
        expect(text({ ownerName: null, relation: 'Mother' })).not.toContain('Suma');
      });
    });
  });

  it('compiles responsive HTML with the unsubscribe footer', async () => {
    const rendered = await renderer.render(NotificationType.GIFT_FULFILLED, payload, {
      unsubscribeUrl: 'https://app.wishtick.test/unsubscribe?token=abc&category=gifts',
    });
    expect(rendered.subject).toContain('A gift arrived');
    expect(rendered.html).toContain('<!doctype html>');
    expect(rendered.html).toContain('A gift was delivered');
    expect(rendered.html).toContain('unsubscribe?token=abc');
  });

  it('escapes user content in the HTML body', async () => {
    const rendered = await renderer.render(NotificationType.THANK_YOU, {
      subject: 'Thanks',
      body: 'Loved it <script>alert(1)</script> & more',
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

describe('NOTIFICATION_SPECS registry', () => {
  it('has a spec for every type', () => {
    for (const type of Object.values(NotificationType)) {
      expect(NOTIFICATION_SPECS[type]).toBeDefined();
      expect(NOTIFICATION_SPECS[type].channels.length).toBeGreaterThan(0);
    }
  });

  it('marks only security as critical and the low-signal types as digest', () => {
    expect(isCritical(NotificationType.ACCOUNT_SECURITY)).toBe(true);
    expect(isCritical(NotificationType.GIFT_FULFILLED)).toBe(false);
    expect(isDigest(NotificationType.GROUP_GIFT_CONTRIBUTION)).toBe(true);
    expect(isDigest(NotificationType.ITEM_PRICE_DROP)).toBe(true);
    expect(isDigest(NotificationType.GIFT_FULFILLED)).toBe(false);
  });
});
