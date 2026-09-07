import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CONTENT_FLAGGED, type ContentFlaggedEvent } from 'src/common/events/domain-events';
import { ModerationService } from './moderation.service';
import { ReportTargetType } from './moderation.types';

const VALID_TARGETS = new Set<string>(Object.values(ReportTargetType));

/**
 * Turns an auto-flag (chat profanity today; the media safety provider later)
 * into a moderation-queue row. Best-effort — a flag that fails to enqueue never
 * breaks the action that raised it — and idempotent via the report dedupe index.
 */
@Injectable()
export class ModerationListener {
  private readonly logger = new Logger(ModerationListener.name);

  constructor(private readonly moderation: ModerationService) {}

  @OnEvent(CONTENT_FLAGGED)
  async onFlagged(e: ContentFlaggedEvent): Promise<void> {
    if (!VALID_TARGETS.has(e.targetType)) return;
    try {
      await this.moderation.autoFlag({
        targetType: e.targetType as ReportTargetType,
        targetId: e.targetId,
        reason: e.reason,
      });
    } catch (err) {
      this.logger.error(
        `Auto-flag listener failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
