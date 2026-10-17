import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  NotificationWording,
  type NotificationWordingDocument,
} from './schemas/notification-wording.schema';

export interface SavedWording {
  title: string;
  body: string;
  updatedAt: Date | null;
  updatedByEmail: string | null;
}

/** How often each process picks up wording saved by another one. */
const REFRESH_MS = 30_000;

/**
 * The wording admins wrote, held in memory so rendering stays synchronous.
 *
 * The API and the notification workers are separate processes, so each one
 * re-reads every [REFRESH_MS]; the process that saved a change has it at once.
 */
@Injectable()
export class NotificationWordingStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWordingStore.name);
  private saved = new Map<string, SavedWording>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(NotificationWording.name)
    private readonly model: Model<NotificationWordingDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload().catch((err: unknown) =>
      this.logger.warn(`Could not load notification wording: ${String(err)}`),
    );
    this.timer = setInterval(() => {
      this.reload().catch(() => undefined);
    }, REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(type: string): SavedWording | null {
    return this.saved.get(type) ?? null;
  }

  types(): string[] {
    return [...this.saved.keys()];
  }

  async save(
    type: string,
    wording: { title: string; body: string },
    by: { id: string; email: string },
  ): Promise<void> {
    await this.model
      .updateOne(
        { type },
        {
          $set: {
            title: wording.title,
            body: wording.body,
            updatedById: Types.ObjectId.isValid(by.id) ? new Types.ObjectId(by.id) : null,
            updatedByEmail: by.email,
          },
        },
        { upsert: true },
      )
      .exec();
    await this.reload();
  }

  /** Back to the built-in wording. True when there was saved wording to drop. */
  async reset(type: string): Promise<boolean> {
    const { deletedCount } = await this.model.deleteOne({ type }).exec();
    await this.reload();
    return deletedCount > 0;
  }

  private async reload(): Promise<void> {
    const rows = await this.model.find().lean().exec();
    this.saved = new Map(
      rows.map((r) => [
        r.type,
        {
          title: r.title,
          body: r.body,
          updatedAt: r.updatedAt ?? null,
          updatedByEmail: r.updatedByEmail ?? null,
        },
      ]),
    );
  }
}
