import type { SettlementDirection, SettlementStatus } from './group-gift.types';
import type { SettlementDocument } from './schemas/settlement.schema';

/**
 * One row of the settle-up ledger, as the client sees it.
 *
 * An explicit allowlist, like every other view in this codebase — a settlement
 * carries a UPI ID, which is a real-world payment handle, and redaction by
 * subtraction is how one of those eventually leaks.
 */
export interface SettlementView {
  id: string;
  groupGiftId: string;
  contributorId: string;
  hostId: string;
  direction: SettlementDirection;
  amountMinor: number;
  currency: string;
  status: SettlementStatus;
  /**
   * Shown so the payer knows where to send it. The receiver set it themselves,
   * and only the two parties to this settlement can read the row at all.
   */
  upiId: string | null;
  sentAt: Date | null;
  confirmedAt: Date | null;
  note: string | null;
  createdAt: Date;
}

export const toSettlementView = (row: SettlementDocument): SettlementView => ({
  id: row._id.toString(),
  groupGiftId: row.groupGiftId.toString(),
  contributorId: row.contributorId.toString(),
  hostId: row.hostId.toString(),
  direction: row.direction,
  amountMinor: row.amountMinor,
  currency: row.currency,
  status: row.status,
  upiId: row.upiId,
  sentAt: row.sentAt,
  confirmedAt: row.confirmedAt,
  note: row.note,
  createdAt: row.createdAt,
});
