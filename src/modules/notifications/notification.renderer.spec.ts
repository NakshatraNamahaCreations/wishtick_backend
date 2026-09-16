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
    amountMinor: 50_000,
    collectedAmountMinor: 150_000,
    targetAmountMinor: 200_000,
    snapshotAmountMinor: 249_900,
    currentAmountMinor: 199_900,
    currency: 'INR',
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
