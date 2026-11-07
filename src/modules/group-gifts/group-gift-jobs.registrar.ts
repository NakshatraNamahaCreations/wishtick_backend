import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import {
  GROUP_GIFT_FULFILLED,
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_PLEDGED,
  type GroupGiftFulfilledEvent,
  type GroupGiftFundedEvent,
  type GroupGiftPledgedEvent,
} from 'src/common/events/domain-events';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { GroupGiftService } from './group-gift.service';

const HOUR_MS = 60 * 60_000;

/** A pledge left unsent for a day: its contributor is reminded. */
export const UNSENT_PLEDGE_JOB = 'group-gift-unsent-pledge';
/** Funded two days ago and not bought: the host is reminded. */
export const BUY_REMINDER_JOB = 'group-gift-buy-reminder';
/** Delivered a day ago with no thank-you: the recipient is prompted. */
export const THANK_YOU_PROMPT_JOB = 'group-gift-thank-you-prompt';

export const UNSENT_PLEDGE_DELAY_MS = 24 * HOUR_MS;
export const BUY_REMINDER_DELAY_MS = 48 * HOUR_MS;
export const THANK_YOU_PROMPT_DELAY_MS = 24 * HOUR_MS;

/**
 * Job ids, one per thing being chased, so a redelivered event schedules it
 * once. With `-` and never `:` — BullMQ refuses a custom id containing one.
 */
export const unsentPledgeJobId = (contributionId: string): string => `gg-unsent-${contributionId}`;
export const buyReminderJobId = (groupGiftId: string, fundedCount: number): string =>
  `gg-buy-${groupGiftId}-${fundedCount}`;
export const thankYouPromptJobId = (groupGiftId: string): string => `gg-thanks-${groupGiftId}`;

interface UnsentPledgeJobData {
  contributionId: string;
}
interface BuyReminderJobData {
  groupGiftId: string;
  fundedCount: number;
}
interface ThankYouPromptJobData {
  groupGiftId: string;
}

/**
 * The three things a group gift chases later rather than now: a pledge
 * nobody sent, a funded gift nobody bought, a delivered gift nobody thanked
 * the group for.
 *
 * Each is a delayed job scheduled off the event that starts the clock, and
 * each handler asks the service, which looks again before saying anything:
 * a job is a decision made a day ago, and the pledge may have been sent, the
 * gift bought, the note written since. A job that finds nothing to do does
 * nothing — so a lost or duplicated job costs at most one reminder.
 */
@Injectable()
export class GroupGiftJobsRegistrar implements OnModuleInit {
  private readonly logger = new Logger(GroupGiftJobsRegistrar.name);

  constructor(
    private readonly groupGifts: GroupGiftService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  onModuleInit(): void {
    this.registry.register(UNSENT_PLEDGE_JOB, (data) =>
      this.groupGifts.remindUnsentPledge((data as UnsentPledgeJobData).contributionId),
    );
    this.registry.register(BUY_REMINDER_JOB, (data) => {
      const { groupGiftId, fundedCount } = data as BuyReminderJobData;
      return this.groupGifts.remindToBuy(groupGiftId, fundedCount);
    });
    this.registry.register(THANK_YOU_PROMPT_JOB, (data) =>
      this.groupGifts.promptThankYou((data as ThankYouPromptJobData).groupGiftId),
    );
  }

  @OnEvent(GROUP_GIFT_PLEDGED)
  async onPledged(e: GroupGiftPledgedEvent): Promise<void> {
    await this.schedule(
      UNSENT_PLEDGE_JOB,
      { contributionId: e.contributionId } satisfies UnsentPledgeJobData,
      unsentPledgeJobId(e.contributionId),
      UNSENT_PLEDGE_DELAY_MS,
    );
  }

  @OnEvent(GROUP_GIFT_FUNDED)
  async onFunded(e: GroupGiftFundedEvent): Promise<void> {
    await this.schedule(
      BUY_REMINDER_JOB,
      { groupGiftId: e.groupGiftId, fundedCount: e.fundedCount } satisfies BuyReminderJobData,
      buyReminderJobId(e.groupGiftId, e.fundedCount),
      BUY_REMINDER_DELAY_MS,
    );
  }

  /** Not for a gift with nobody else to thank: kept for a name, or the host's own. */
  @OnEvent(GROUP_GIFT_FULFILLED)
  async onFulfilled(e: GroupGiftFulfilledEvent): Promise<void> {
    if (e.forName || e.recipientId === e.hostId) return;
    await this.schedule(
      THANK_YOU_PROMPT_JOB,
      { groupGiftId: e.groupGiftId } satisfies ThankYouPromptJobData,
      thankYouPromptJobId(e.groupGiftId),
      THANK_YOU_PROMPT_DELAY_MS,
    );
  }

  /** Best-effort: a reminder that fails to schedule is never why the action failed. */
  private async schedule(name: string, data: object, jobId: string, delay: number): Promise<void> {
    try {
      await this.scheduler.add(name, data, {
        delay,
        jobId,
        removeOnComplete: true,
        removeOnFail: 50,
      });
    } catch (err) {
      this.logger.warn(
        `Could not schedule ${name} (${jobId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
