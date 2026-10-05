import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, type mongo } from 'mongoose';
import {
  GROUP_GIFT_DRIFT_DETECTED,
  type GroupGiftDriftDetectedEvent,
} from 'src/common/events/domain-events';
import { DRIFT_EVENT_TYPE } from './admin-money.service';

/** How long an operational record is kept. */
const KEEP_DAYS = 365;

/**
 * Keeps the operational events an admin needs to look back on — today, a group
 * gift whose collected total drifted from its contributions — in
 * `ops_events`, rather than only in a log line that is gone by morning.
 *
 * Best-effort: a record that fails to write never breaks the job that raised it.
 */
@Injectable()
export class OpsEventsListener {
  private readonly logger = new Logger(OpsEventsListener.name);
  private indexed = false;

  constructor(@InjectConnection() private readonly conn: Connection) {}

  private get events(): mongo.Collection {
    return (this.conn.db as mongo.Db).collection('ops_events');
  }

  @OnEvent(GROUP_GIFT_DRIFT_DETECTED)
  async onDrift(e: GroupGiftDriftDetectedEvent): Promise<void> {
    try {
      await this.ensureIndexes();
      await this.events.insertOne({
        type: DRIFT_EVENT_TYPE,
        refId: Types.ObjectId.isValid(e.groupGiftId) ? new Types.ObjectId(e.groupGiftId) : null,
        data: {
          cachedAmountMinor: e.cachedAmountMinor,
          summedAmountMinor: e.summedAmountMinor,
          driftMinor: e.driftMinor,
        },
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Could not record drift for ${e.groupGiftId}: ${String(err)}`);
    }
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexed) return;
    await this.events.createIndex({ type: 1, createdAt: -1 });
    await this.events.createIndex({ type: 1, refId: 1 });
    await this.events.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: KEEP_DAYS * 24 * 60 * 60 },
    );
    this.indexed = true;
  }
}
