import { EventRemindersService, reminderJobId, reminderWhenText } from './event-reminders.service';
import type { EventDocument } from './schemas/event.schema';
import { Types } from 'mongoose';

/** A queue that records adds and removes, like the e2e FakeQueue but local. */
class RecordingQueue {
  added: { name: string; data: unknown; opts: { delay?: number; jobId?: string } }[] = [];
  removed: string[] = [];

  add(name: string, data: unknown, opts: { delay?: number; jobId?: string }): Promise<unknown> {
    if (opts.jobId?.includes(':')) throw new Error('Custom Id cannot contain :');
    this.added.push({ name, data, opts });
    return Promise.resolve({ id: opts.jobId });
  }

  getJob(jobId: string): Promise<{ remove: () => Promise<void> } | undefined> {
    const found = this.added.find((j) => j.opts.jobId === jobId);
    if (!found) return Promise.resolve(undefined);
    return Promise.resolve({
      remove: () => {
        this.added = this.added.filter((j) => j !== found);
        this.removed.push(jobId);
        return Promise.resolve();
      },
    });
  }
}

describe('EventRemindersService', () => {
  let queue: RecordingQueue;
  let service: EventRemindersService;

  const makeEvent = (startsAt: Date): EventDocument =>
    ({ _id: new Types.ObjectId(), startsAt }) as unknown as EventDocument;

  beforeEach(() => {
    queue = new RecordingQueue();
    service = new EventRemindersService(queue as never);
  });

  it('schedules the three offsets for a far-future event', async () => {
    const event = makeEvent(new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000));
    const scheduled = await service.schedule(event);

    expect(scheduled).toEqual(['t-7d', 't-1d', 't-2h']);
    expect(queue.added).toHaveLength(3);

    // Delays INCREASE across the three: t-7d fires soonest (7 days before the
    // event, so the smallest wait from now), t-2h fires last.
    const delays = queue.added.map((j) => j.opts.delay!);
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
  });

  it('skips offsets already in the past', async () => {
    // Three days out: the "one week before" moment has already passed and must
    // NOT fire immediately.
    const event = makeEvent(new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000));
    const scheduled = await service.schedule(event);

    expect(scheduled).toEqual(['t-1d', 't-2h']);
    expect(queue.added.every((j) => j.opts.delay! > 0)).toBe(true);
  });

  it('schedules nothing for an event inside two hours', async () => {
    const event = makeEvent(new Date(Date.now() + 30 * 60 * 1_000));
    expect(await service.schedule(event)).toEqual([]);
  });

  /**
   * The reschedule exit criterion.
   *
   * schedule() must cancel then re-add, not rely on "existing jobId is a
   * no-op" — that would keep the OLD delay after a date change, which is the
   * exact bug the test guards.
   */
  it('cancels and re-adds when rescheduled, keeping the new delay', async () => {
    const event = makeEvent(new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000));
    await service.schedule(event);
    const firstDelays = queue.added.map((j) => j.opts.delay!);

    // The host moves the event closer.
    event.startsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000);
    await service.schedule(event);

    // Old jobs were removed...
    expect(queue.removed).toContain(reminderJobId(event._id.toString(), 't-7d'));
    // ...and there are still exactly three, now with smaller delays because the
    // event is nearer.
    expect(queue.added).toHaveLength(3);
    const secondDelays = queue.added.map((j) => j.opts.delay!);
    expect(secondDelays[0]).toBeLessThan(firstDelays[0]);
  });

  it('cancel removes every reminder', async () => {
    const event = makeEvent(new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000));
    await service.schedule(event);
    const removed = await service.cancel(event._id.toString());
    expect(removed).toBe(3);
    expect(queue.added).toHaveLength(0);
  });

  // The offsets are scheduling identifiers, not English. Interpolated raw the
  // reminder read "Diwali Party is t-1d" — on a lock screen, by SMS, and in an
  // email subject line.
  describe('reminderWhenText', () => {
    it('says the offset the way a person would', () => {
      expect(reminderWhenText('t-7d')).toBe('in a week');
      expect(reminderWhenText('t-1d')).toBe('tomorrow');
      expect(reminderWhenText('t-2h')).toBe('in 2 hours');
    });

    it('never lets a scheduling key reach the copy', () => {
      // A job written by an older deploy can carry an offset this build has
      // never heard of. Whatever comes back must still read as English.
      for (const offset of ['t-30d', '', 'nonsense']) {
        expect(reminderWhenText(offset)).not.toContain('t-');
        expect(reminderWhenText(offset)).toBe('soon');
      }
    });
  });

  it('uses a colon-free job id', async () => {
    // BullMQ rejects a custom job id containing ':'. The RecordingQueue enforces
    // it, so this asserts the id shape rather than just trusting it.
    const event = makeEvent(new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000));
    await service.schedule(event);
    for (const job of queue.added) {
      expect(job.opts.jobId).not.toContain(':');
    }
  });
});
