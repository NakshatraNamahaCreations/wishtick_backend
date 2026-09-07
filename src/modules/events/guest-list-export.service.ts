import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { EventDocument } from './schemas/event.schema';
import type { InviteView } from './event.views';
import { RsvpResponse } from './event.types';

/** The formats "Download Guest List" offers (`4096:206`). */
export enum GuestListFormat {
  PDF = 'pdf',
  XLSX = 'xlsx',
  CSV = 'csv',
}

export interface GuestListFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** Column order, shared by all three formats so they cannot drift apart. */
const COLUMNS = [
  { header: 'Name', width: 28 },
  { header: 'Handle', width: 32 },
  { header: 'RSVP', width: 12 },
  { header: 'Additional guests', width: 18 },
  { header: 'Total attending', width: 16 },
  { header: 'Responded', width: 22 },
  { header: 'Message', width: 40 },
] as const;

/** The words the guest list itself uses (`4099:1256`), not the wire values. */
const RSVP_LABEL: Record<RsvpResponse, string> = {
  [RsvpResponse.YES]: 'Confirmed',
  [RsvpResponse.MAYBE]: 'Maybe',
  [RsvpResponse.NO]: 'Declined',
  [RsvpResponse.PENDING]: 'No reply',
};

@Injectable()
export class GuestListExportService {
  /**
   * Renders the guest list for download.
   *
   * All three formats are built from one [rows] projection so a column can
   * never appear in the spreadsheet but not the PDF. The file is returned as a
   * buffer rather than streamed: a guest list is capped at the event's invite
   * limit, so it is small and bounded, and buffering lets the caller set an
   * accurate Content-Length.
   */
  render(
    event: EventDocument,
    invites: InviteView[],
    format: GuestListFormat,
  ): Promise<GuestListFile> {
    const rows = invites.map((invite) => this.toRow(invite));
    const stem = this.filenameStem(event.title);

    switch (format) {
      case GuestListFormat.CSV:
        return Promise.resolve({
          buffer: Buffer.from(this.toCsv(rows), 'utf8'),
          filename: `${stem}-guest-list.csv`,
          contentType: 'text/csv; charset=utf-8',
        });
      case GuestListFormat.XLSX:
        return this.toXlsx(event, rows).then((buffer) => ({
          buffer,
          filename: `${stem}-guest-list.xlsx`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }));
      case GuestListFormat.PDF:
        return this.toPdf(event, invites, rows).then((buffer) => ({
          buffer,
          filename: `${stem}-guest-list.pdf`,
          contentType: 'application/pdf',
        }));
      default:
        throw new AppException(ErrorCode.VALIDATION_FAILED, 'Unsupported export format', 400);
    }
  }

  private toRow(invite: InviteView): string[] {
    // yes/maybe bring their plus-ones; a decline or no reply brings nobody, so
    // "total attending" must not quietly count the plus-ones of someone who
    // is not coming.
    const coming = invite.rsvp === RsvpResponse.YES || invite.rsvp === RsvpResponse.MAYBE;
    return [
      invite.person?.displayName ?? '',
      // Their handle, where an address used to go. It is what identifies a
      // guest now, and unlike an email it is theirs to publish.
      invite.person?.username ? `@${invite.person.username}` : '',
      RSVP_LABEL[invite.rsvp],
      String(invite.plusOnes),
      coming ? String(1 + invite.plusOnes) : '0',
      invite.respondedAt ? invite.respondedAt.toISOString() : '',
      invite.message ?? '',
    ];
  }

  /**
   * RFC 4180 quoting. Every field is quoted rather than only the ones that
   * need it — a guest's message routinely contains a comma, and deciding
   * per-field is how one slips through unquoted.
   *
   * A leading `=`, `+`, `-` or `@` is prefixed with a single quote: Excel
   * treats those as formulas, and a guest could otherwise put one in their
   * name or message.
   */
  private toCsv(rows: string[][]): string {
    const escape = (value: string): string => `"${this.deFormula(value).replace(/"/g, '""')}"`;
    const header = COLUMNS.map((c) => escape(c.header)).join(',');
    const body = rows.map((row) => row.map(escape).join(',')).join('\r\n');
    return `${header}\r\n${body}\r\n`;
  }

  private deFormula(value: string): string {
    return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  }

  private async toXlsx(event: EventDocument, rows: string[][]): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    book.created = new Date();
    const sheet = book.addWorksheet('Guest list');

    sheet.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
    sheet.getRow(1).font = { bold: true };
    // The same formula guard as the CSV: a spreadsheet is exactly where an
    // injected formula would run.
    rows.forEach((row) => sheet.addRow(row.map((v) => this.deFormula(v))));
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

    const data = await book.xlsx.writeBuffer();
    void event;
    return Buffer.from(data);
  }

  private toPdf(event: EventDocument, invites: InviteView[], rows: string[][]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Landscape: seven columns do not fit portrait without the message
      // column becoming unreadable.
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text(event.title, { continued: false });
      doc.fontSize(10).fillColor('#666').text(`Guest list · ${invites.length} invited`);
      doc.moveDown(1).fillColor('#000');

      const totals = this.totals(invites);
      doc
        .fontSize(11)
        .text(
          `Confirmed ${totals.yes}   Maybe ${totals.maybe}   ` +
            `Declined ${totals.no}   No reply ${totals.pending}   ` +
            `Attending ${totals.attending}`,
        );
      doc.moveDown(1);

      const left = doc.page.margins.left;
      const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const totalWidth = COLUMNS.reduce((sum, c) => sum + c.width, 0);
      const widths = COLUMNS.map((c) => (c.width / totalWidth) * usable);

      const writeRow = (cells: string[], bold: boolean): void => {
        const top = doc.y;
        // Measured before drawing: a wrapped message makes the row taller than
        // one line, and the next row has to start below the tallest cell.
        const height = Math.max(
          ...cells.map((cell, i) =>
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').heightOfString(cell, {
              width: widths[i] - 8,
            }),
          ),
        );
        if (top + height > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
        }
        const y = doc.y;
        let x = left;
        cells.forEach((cell, i) => {
          doc
            .font(bold ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(9)
            .text(cell, x + 4, y, { width: widths[i] - 8 });
          x += widths[i];
        });
        doc.y = y + height + 6;
        doc
          .moveTo(left, doc.y - 3)
          .lineTo(left + usable, doc.y - 3)
          .strokeColor('#e0e0e0')
          .stroke();
      };

      writeRow(
        COLUMNS.map((c) => c.header),
        true,
      );
      rows.forEach((row) => writeRow(row, false));

      doc.end();
    });
  }

  private totals(invites: InviteView[]): {
    yes: number;
    no: number;
    maybe: number;
    pending: number;
    attending: number;
  } {
    const totals = { yes: 0, no: 0, maybe: 0, pending: 0, attending: 0 };
    for (const invite of invites) {
      switch (invite.rsvp) {
        case RsvpResponse.YES:
          totals.yes++;
          totals.attending += 1 + invite.plusOnes;
          break;
        case RsvpResponse.MAYBE:
          totals.maybe++;
          totals.attending += 1 + invite.plusOnes;
          break;
        case RsvpResponse.NO:
          totals.no++;
          break;
        default:
          totals.pending++;
      }
    }
    return totals;
  }

  /** A filename that survives every OS: no separators, no spaces, not empty. */
  private filenameStem(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug || 'event';
  }
}
