import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { UserStatus } from 'src/common/enums/user-role.enum';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { MediaService } from 'src/modules/media/media.service';
import { TokenService } from 'src/modules/auth/services/token.service';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import { ProfileService } from './profile.service';

export const ANONYMIZE_JOB = 'anonymize-account';

/**
 * Deterministic job id for an account's pending erasure.
 *
 * The separator is '-' and NOT ':' because BullMQ rejects a custom job id
 * containing a colon outright ("Custom Id cannot contain :") — it uses ':' as
 * its own key separator in Redis. A colon here throws at enqueue time, which
 * means DELETE /me fails with a 500 rather than deleting the account.
 */
export const anonymizeJobId = (userId: string): string => `${ANONYMIZE_JOB}-${userId}`;

export interface AnonymizeJobData {
  userId: string;
  /** Guards against anonymizing an account restored after the job was queued. */
  deletedAtIso: string;
}

export interface DeletionReceipt {
  deletedAt: Date;
  /** Restoring after this instant is impossible — data is gone, not hidden. */
  restorableUntil: Date;
}

@Injectable()
export class AccountLifecycleService {
  private readonly logger = new Logger(AccountLifecycleService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
    private readonly profiles: ProfileService,
    private readonly media: MediaService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private graceMs(): number {
    return this.config.get('account.deletionGraceDays', { infer: true }) * 24 * 60 * 60 * 1_000;
  }

  /**
   * Soft-deletes the account and schedules irreversible erasure.
   *
   * Two-phase on purpose. Deleting immediately means an accidental tap (or a
   * hijacked session) destroys a user's gifting history with no recourse; never
   * deleting means we hold PII forever. The grace period gives the user a way
   * back and still lets us honour erasure.
   */
  async requestDeletion(userId: string, reason?: string): Promise<DeletionReceipt> {
    const _id = new Types.ObjectId(userId);
    const deletedAt = new Date();

    const result = await this.userModel
      .updateOne(
        { _id, deletedAt: null },
        { $set: { deletedAt, status: UserStatus.DELETED, deletionReason: reason ?? null } },
      )
      .exec();

    if (result.matchedCount === 0) {
      // Already deleted, or never existed. Either way there is nothing to do —
      // and this must not queue a second anonymization job.
      throw new AppException(ErrorCode.ACCOUNT_DELETED, 'This account is already deleted', 409);
    }

    // Every session dies now. A soft-deleted account that still answers to a
    // live access token is not deleted in any sense the user would recognise.
    await this.tokens.revokeAllForUser(_id, 'account_deleted');
    await this.userModel.updateOne({ _id }, { $set: { tokensInvalidBefore: new Date() } }).exec();

    const delay = this.graceMs();
    await this.scheduler.add(
      ANONYMIZE_JOB,
      { userId, deletedAtIso: deletedAt.toISOString() } satisfies AnonymizeJobData,
      {
        delay,
        // Deterministic id: re-requesting deletion cannot stack duplicate jobs,
        // and a restore→delete cycle reuses the same slot.
        jobId: anonymizeJobId(userId),
        removeOnComplete: true,
      },
    );

    this.logger.log(`Account ${userId} soft-deleted; anonymization scheduled in ${delay}ms`);
    return { deletedAt, restorableUntil: new Date(deletedAt.getTime() + delay) };
  }

  /**
   * Brings a soft-deleted account back within the grace window.
   *
   * Callers must verify credentials first — a deleted user cannot authenticate,
   * so there is no session to authorize this, and without a credential check
   * anyone who knew an email could resurrect someone else's account.
   */
  async restore(user: UserDocument): Promise<void> {
    if (!user.deletedAt) {
      throw new AppException(
        ErrorCode.ACCOUNT_NOT_PENDING_DELETION,
        'This account is not pending deletion',
        409,
      );
    }

    if (Date.now() > user.deletedAt.getTime() + this.graceMs()) {
      // The data is already gone; pretending otherwise would be a lie.
      throw new AppException(
        ErrorCode.RESTORE_WINDOW_EXPIRED,
        'The restore window for this account has passed',
        410,
      );
    }

    await this.userModel
      .updateOne(
        { _id: user._id },
        { $set: { deletedAt: null, status: UserStatus.ACTIVE, deletionReason: null } },
      )
      .exec();

    await this.cancelScheduledAnonymization(user._id.toString());
    this.logger.log(`Account ${user._id.toString()} restored`);
  }

  private async cancelScheduledAnonymization(userId: string): Promise<void> {
    try {
      const job = await this.scheduler.getJob(anonymizeJobId(userId));
      await job?.remove();
    } catch (err) {
      // The worker also re-checks deletedAt before erasing, so a job that
      // survives here is harmless — it will no-op. Log and move on rather than
      // failing the user's restore.
      this.logger.warn(
        `Could not remove anonymization job for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Irreversible erasure. Runs when the grace period lapses.
   *
   * The row survives with its _id so foreign keys elsewhere (gifts given, chat
   * authorship) do not dangle — a deleted user's past gift should still show as
   * "a deleted user", not corrupt someone else's history. Everything that
   * identifies a person is destroyed.
   */
  async anonymize(data: AnonymizeJobData): Promise<{ anonymized: boolean; reason?: string }> {
    const _id = new Types.ObjectId(data.userId);
    const user = await this.userModel.findById(_id).exec();

    if (!user) return { anonymized: false, reason: 'user-not-found' };

    // The restore path removes this job, but a race (or a failed removal) could
    // still deliver it. Re-checking here is what makes the job safe to run at
    // any time — losing a restored user's account would be unrecoverable.
    if (!user.deletedAt) return { anonymized: false, reason: 'account-restored' };
    if (user.deletedAt.toISOString() !== data.deletedAtIso) {
      return { anonymized: false, reason: 'deleted-at-changed' };
    }
    if (Date.now() < user.deletedAt.getTime() + this.graceMs()) {
      return { anonymized: false, reason: 'grace-period-active' };
    }

    await this.media.deleteAllForOwner(_id);
    await this.profiles.anonymize(_id);

    await this.userModel
      .updateOne(
        { _id },
        {
          // $unset rather than null: the partial unique indexes on email/phone
          // filter on `$type: 'string'`, so unsetting frees the address for
          // reuse while a null would too — but unset also leaves no trace of
          // the original field having existed.
          $unset: { email: '', phone: '', name: '' },
          $set: {
            passwordHash: 'ANONYMIZED',
            status: UserStatus.DELETED,
            anonymizedAt: new Date(),
            tokensInvalidBefore: new Date(),
          },
        },
      )
      .exec();

    this.logger.log(`Account ${data.userId} anonymized`);
    return { anonymized: true };
  }

  /**
   * Safety net for jobs lost to a Redis flush or a queue migration. Sweeps any
   * account whose grace period has lapsed. Idempotent.
   */
  async sweepExpired(limit = 100): Promise<number> {
    const cutoff = new Date(Date.now() - this.graceMs());
    const due = await this.userModel
      .find({ deletedAt: { $ne: null, $lte: cutoff }, anonymizedAt: null })
      .limit(limit)
      .exec();

    let count = 0;
    for (const user of due) {
      const res = await this.anonymize({
        userId: user._id.toString(),
        deletedAtIso: user.deletedAt!.toISOString(),
      });
      if (res.anonymized) count++;
    }
    if (count > 0) this.logger.warn(`Sweeper anonymized ${count} account(s) missed by the queue`);
    return count;
  }
}
