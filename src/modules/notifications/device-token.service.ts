import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { RegisterDeviceDto } from './dto/notification.dto';
import { DeviceToken, type DeviceTokenDocument } from './schemas/device-token.schema';

/** Nobody carries more than a handful; beyond this the oldest are dropped. */
const MAX_DEVICES_PER_USER = 10;

@Injectable()
export class DeviceTokenService {
  private readonly logger = new Logger(DeviceTokenService.name);

  constructor(
    @InjectModel(DeviceToken.name)
    private readonly model: Model<DeviceTokenDocument>,
  ) {}

  /**
   * Registers (or re-registers) this install's push token.
   *
   * Upserts on the token rather than on (user, token): a handset handed to a
   * second account keeps the same FCM token, and inserting a second row would
   * deliver the first person's notifications to the second. Re-pointing it is
   * the correct answer — the token belongs to the install, not the account.
   */
  async register(userId: string, dto: RegisterDeviceDto): Promise<{ id: string }> {
    const owner = new Types.ObjectId(userId);
    const doc = await this.model
      .findOneAndUpdate(
        { token: dto.token },
        {
          $set: {
            userId: owner,
            platform: dto.platform,
            deviceName: dto.deviceName ?? null,
            lastSeenAt: new Date(),
            // A token that comes back after a revoke is alive again — the app
            // was reinstalled, or FCM reissued it.
            revokedAt: null,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.pruneBeyondCap(owner);
    return { id: doc._id.toString() };
  }

  /**
   * Drops a token — what the client calls on sign-out.
   *
   * Scoped to the caller: a token is a delivery address, and letting anyone
   * unregister an arbitrary one would be a way to silence someone else.
   */
  async unregister(userId: string, token: string): Promise<void> {
    await this.model.deleteOne({ token, userId: new Types.ObjectId(userId) }).exec();
  }

  /** Every live token for one person — what a push fan-out sends to. */
  async liveTokensFor(userId: string): Promise<string[]> {
    const docs = await this.model
      .find({ userId: new Types.ObjectId(userId), revokedAt: null })
      .select({ token: 1 })
      .exec();
    return docs.map((d) => d.token);
  }

  /**
   * Marks tokens the provider rejected as no longer registered.
   *
   * Revoked rather than deleted: a deleted row would be re-created by the next
   * open of a client that has not noticed it is dead, and we would pay for the
   * same failed delivery forever.
   */
  async revoke(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    const result = await this.model
      .updateMany({ token: { $in: tokens } }, { $set: { revokedAt: new Date() } })
      .exec();
    if (result.modifiedCount > 0) {
      this.logger.log(`Revoked ${result.modifiedCount} dead push token(s)`);
    }
  }

  /** Keeps the newest [MAX_DEVICES_PER_USER]; older rows are someone's old phone. */
  private async pruneBeyondCap(userId: Types.ObjectId): Promise<void> {
    const stale = await this.model
      .find({ userId })
      .sort({ lastSeenAt: -1 })
      .skip(MAX_DEVICES_PER_USER)
      .select({ _id: 1 })
      .exec();
    if (stale.length === 0) return;
    await this.model.deleteMany({ _id: { $in: stale.map((d) => d._id) } }).exec();
  }
}
