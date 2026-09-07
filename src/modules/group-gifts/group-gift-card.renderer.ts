import { Injectable } from '@nestjs/common';
import { Resvg } from '@resvg/resvg-js';

export interface ProgressCardContent {
  /** The item / gift headline, already trimmed by the caller. */
  title: string;
  /** e.g. "₹4,500 of ₹9,000 raised" — preformatted in the group's currency. */
  amountLine: string;
  /** 0–100. */
  percent: number;
  /** e.g. "12 people have chipped in". */
  contributorLine: string;
  /** The initiator's pitch, or null. */
  message: string | null;
}

/** 1200×630 — the Open Graph standard, what WhatsApp crops to. */
const WIDTH = 1200;
const HEIGHT = 630;
const BG = '#0f172a';
const ACCENT = '#f43f5e';
const TRACK = '#1e293b';
const TEXT = '#f8fafc';
const MUTED = '#94a3b8';

@Injectable()
export class GroupGiftCardRenderer {
  /**
   * Renders the progress card as a PNG.
   *
   * PNG, not the SVG we compose it from: unfurlers do not render SVG, and
   * serving user-influenced SVG from our own origin would be stored XSS. The
   * same reasoning and the same escaping discipline as the invite card.
   */
  render(content: ProgressCardContent): Buffer {
    const svg = GroupGiftCardRenderer.buildSvg(content);
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: WIDTH },
      // Never a network request while drawing from user input.
      font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
    })
      .render()
      .asPng();
    return Buffer.from(png);
  }

  private static buildSvg(c: ProgressCardContent): string {
    const family = 'Arial, Helvetica, sans-serif';
    const esc = GroupGiftCardRenderer.escape;

    const pct = Math.max(0, Math.min(100, Math.round(c.percent)));
    const barX = 90;
    const barY = 400;
    const barW = WIDTH - 180;
    const barH = 40;
    const fillW = Math.round((barW * pct) / 100);

    const title = GroupGiftCardRenderer.fit(c.title, 34);
    const message = c.message ? GroupGiftCardRenderer.fit(c.message, 70) : null;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <rect x="0" y="0" width="${WIDTH}" height="12" fill="${ACCENT}"/>
  <text x="90" y="120" font-family="${family}" font-size="30" fill="${MUTED}">Group gift</text>
  <text x="90" y="196" font-family="${family}" font-size="58" font-weight="bold" fill="${TEXT}">${esc(title)}</text>
  ${
    message
      ? `<text x="90" y="256" font-family="${family}" font-size="26" fill="${MUTED}">${esc(message)}</text>`
      : ''
  }
  <text x="90" y="356" font-family="${family}" font-size="34" font-weight="bold" fill="${TEXT}">${esc(c.amountLine)}</text>
  <text x="${WIDTH - 90}" y="356" font-family="${family}" font-size="44" font-weight="bold" fill="${ACCENT}" text-anchor="end">${pct}%</text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="20" fill="${TRACK}"/>
  ${fillW > 0 ? `<rect x="${barX}" y="${barY}" width="${fillW}" height="${barH}" rx="20" fill="${ACCENT}"/>` : ''}
  <text x="90" y="520" font-family="${family}" font-size="28" fill="${MUTED}">${esc(c.contributorLine)}</text>
  <text x="${WIDTH - 40}" y="${HEIGHT - 32}" font-family="${family}" font-size="20" fill="${MUTED}" text-anchor="end">wishtick</text>
</svg>`;
  }

  /** Truncate to one line; SVG `<text>` does not wrap. */
  private static fit(text: string, maxChars: number): string {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
  }

  /** XML-escape for interpolation into an SVG node. `this: void` — pulled off as `esc`. */
  private static escape(this: void, text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
