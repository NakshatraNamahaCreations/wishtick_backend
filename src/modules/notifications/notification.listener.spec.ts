import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { EventReminderDueEvent } from 'src/modules/events/event-reminders.processor';
import { NotificationListener } from './notification.listener';
import type { NotificationService } from './notification.service';
import { NotificationType } from './notification.types';

/**
 * What the listener hands the renderer.
 *
 * `reminderWhenText` has its own tests, but a correct function nobody calls
 * renders nothing: the defect this covers was the listener passing the raw
 * scheduling key straight through, so an event reminder read "Diwali Party is
 * t-1d" on a lock screen, by SMS, and in an email subject line.
 */
describe('NotificationListener', () => {
  /** Records what would have been enqueued. */
  const build = () => {
    const enqueued: { type: NotificationType; payload: Record<string, unknown> }[] = [];
    const notifications = {
      enqueue: (req: { type: NotificationType; payload: Record<string, unknown> }) => {
        enqueued.push(req);
        return Promise.resolve();
      },
    } as unknown as NotificationService;
    const config = {
      get: () => 'https://app.wishtick.test',
    } as unknown as ConfigService<AppConfig, true>;

    // The reminder path touches only these two of the six dependencies; the
    // rest would be dead weight to stand up, and a null one fails loudly if
    // this path ever starts reaching for them.
    const listener = new NotificationListener(
      null as never,
      null as never,
      null as never,
      notifications,
      null as never,
      config,
    );
    return { listener, enqueued };
  };

  const due = (offset: string): EventReminderDueEvent => ({
    eventId: 'ev_1',
    offset,
    title: 'Diwali Party',
    startsAt: new Date('2026-11-08T18:00:00.000Z'),
    timezone: 'Asia/Kolkata',
    recipients: [{ userId: 'u_1' }],
  });

  it('tells the reader when the event is, in words', async () => {
    const { listener, enqueued } = build();

    await listener.onEventReminder(due('t-1d'));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe(NotificationType.EVENT_REMINDER);
    expect(enqueued[0].payload.whenText).toBe('tomorrow');
  });

  it('never lets a scheduling key reach the copy', async () => {
    const { listener, enqueued } = build();

    for (const offset of ['t-7d', 't-1d', 't-2h', 't-30d']) {
      await listener.onEventReminder(due(offset));
    }

    for (const req of enqueued) {
      expect(req.payload.whenText).not.toMatch(/^t-/);
    }
  });

  it('skips a recipient the invite never matched to an account', async () => {
    const { listener, enqueued } = build();
    const event = { ...due('t-1d'), recipients: [{ userId: null }] } as EventReminderDueEvent;

    await listener.onEventReminder(event);

    expect(enqueued).toHaveLength(0);
  });
});
