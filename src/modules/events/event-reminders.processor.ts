import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { EVENT_REMINDER_JOB, type EventReminderJobData } from './event-reminders.service';
import { EventStatus } from './event.types';
import { Event, type EventDocument } from './schemas/event.schema';
import { EventInvite, type EventInviteDocument } from './schemas/event-invite.schema';

/** Emitted per reminder. Sprint 9 turns these into the actual emails/SMS. */
export const EVENT_REMINDER_DUE = 'event.reminder_due';

export interface EventReminderDueEvent {
  eventId: string;
  offset: string;
  title: string;
  startsAt: Date;
  timezone: string;
  recipients: { userId: string | null }[];
}

export interface ReminderResult {
  sent: boolean;
  reason?: string;
  recipients?: number;
}

/**
 * Fires event reminders, registered on the shared scheduler queue.
 *
 * Every guard here exists because a delayed job is a message from the past: it
 * was queued days ago, against facts that may since have changed. Reminding
 * people about a cancelled party — or about the *old* date after the host moved
 * it — is worse than not reminding them at all.
 *
 * Registers with SchedulerRegistry rather than being its own `@Processor`; see
 * that file for why.
 */
@Injectable()
export class EventRemindersRegistrar implements OnModuleInit {
  private readonly logger = new Logger(EventRemindersRegistrar.name);

  constructor(
    @InjectModel(Event.name) private readonly events: Model<EventDocument>,
    @InjectModel(EventInvite.name) private readonly invites: Model<EventInviteDocument>,
    private readonly emitter: EventEmitter2,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(EVENT_REMINDER_JOB, (data) => this.fire(data as EventReminderJobData));
  }

  private async fire(data: EventReminderJobData): Promise<ReminderResult> {
    const event = await this.events.findById(data.eventId).exec();
    if (!event) return { sent: false, reason: 'event-deleted' };

    if (event.status === EventStatus.CANCELLED) return { sent: false, reason: 'event-cancelled' };
    if (event.status !== EventStatus.PUBLISHED)
      return { sent: false, reason: 'event-not-published' };

    // The date moved after this job was queued. Rescheduling cancels and re-adds
    // the jobs, but a cancel can fail and a job can survive a queue migration —
    // this check makes those harmless rather than a wrong-date reminder.
    if (event.startsAt.toISOString() !== data.startsAtIso) {
      this.logger.log(`Reminder ${data.offset} for ${data.eventId} is stale; skipping`);
      return { sent: false, reason: 'date-changed' };
    }
    if (event.startsAt.getTime() <= Date.now()) {
      return { sent: false, reason: 'event-already-started' };
    }

    // Only people who might turn up. Someone who declined does not need a
    // countdown to a party they already said no to.
    const recipients = await this.invites
      .find({ eventId: event._id, revokedAt: null, rsvp: { $ne: 'no' } })
      .select('invitedUserId')
      .exec();

    this.emitter.emit(EVENT_REMINDER_DUE, {
      eventId: event._id.toString(),
      offset: data.offset,
      title: event.title,
      startsAt: event.startsAt,
      timezone: event.timezone,
      recipients: recipients.map((r) => ({
        userId: r.invitedUserId?.toString() ?? null,
      })),
    } satisfies EventReminderDueEvent);

    this.logger.log(
      `Reminder ${data.offset} due for event ${event._id.toString()} → ${recipients.length} recipient(s)`,
    );
    return { sent: true, recipients: recipients.length };
  }
}
