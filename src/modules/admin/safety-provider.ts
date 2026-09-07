import { Injectable } from '@nestjs/common';

export const SAFETY_PROVIDER = Symbol('SAFETY_PROVIDER');

export interface SafetyVerdict {
  safe: boolean;
  /** 0–1 confidence the content is unsafe. */
  score: number;
  labels: string[];
}

/**
 * The seam for an image/video safety vendor (AWS Rekognition, Hive, etc.).
 *
 * Sprint 11 ships the INTERFACE, not an implementation — the plan is explicit
 * that the media check is deferred. The text profanity hook is live (it feeds the
 * moderation queue); a real media provider drops in behind this token later
 * without any caller changing.
 */
export interface ISafetyProvider {
  scanText(text: string): Promise<SafetyVerdict>;
  scanMedia(input: { storageKey: string; contentType: string }): Promise<SafetyVerdict>;
}

/** A tiny illustrative profanity list, the same shape chat already used. */
const FLAGGED_WORDS = ['badword'];

/**
 * The default provider: a live text profanity check, and a media check that
 * always passes (no vendor wired). Deliberately conservative — it flags, it does
 * not auto-remove; a human decides in the queue.
 */
@Injectable()
export class NoopSafetyProvider implements ISafetyProvider {
  scanText(text: string): Promise<SafetyVerdict> {
    const lower = text.toLowerCase();
    const hit = FLAGGED_WORDS.filter((w) => lower.includes(w));
    return Promise.resolve({ safe: hit.length === 0, score: hit.length ? 1 : 0, labels: hit });
  }

  scanMedia(): Promise<SafetyVerdict> {
    // No media vendor configured — pass through, never block on unknown.
    return Promise.resolve({ safe: true, score: 0, labels: [] });
  }
}
