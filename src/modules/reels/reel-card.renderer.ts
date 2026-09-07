import { Injectable } from '@nestjs/common';
import { Resvg } from '@resvg/resvg-js';
import { REEL_VIDEO } from './reel.types';

const W = REEL_VIDEO.width; // 720
const H = REEL_VIDEO.height; // 1280
const BG = '#1e1b4b';
const ACCENT = '#f9a8d4';
const TEXT = '#faf5ff';
const MUTED = '#c4b5fd';
const FAMILY = 'Arial, Helvetica, sans-serif';

/**
 * Renders the still cards a reel is built from — text wishes, an author card for
 * audio wishes, the intro, the outro, and the overlay watermark — to PNGs the
 * ffmpeg compositor turns into clips.
 *
 * PNG, not SVG, and every user string XML-escaped, for the same reason as the
 * other card renderers: the bytes are composed from author names and wish text.
 */
@Injectable()
export class ReelCardRenderer {
  textWish(input: { authorName: string; text: string }): Buffer {
    const esc = ReelCardRenderer.escape;
    const lines = ReelCardRenderer.wrap(input.text, 26, 8);
    const startY = H / 2 - (lines.length * 58) / 2;
    const body = lines
      .map(
        (l, i) =>
          `<text x="${W / 2}" y="${startY + i * 58}" font-family="${FAMILY}" font-size="44" fill="${TEXT}" text-anchor="middle">${esc(l)}</text>`,
      )
      .join('\n  ');
    return this.raster(`
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <text x="${W / 2}" y="160" font-family="${FAMILY}" font-size="34" font-weight="bold" fill="${ACCENT}" text-anchor="middle">${esc(ReelCardRenderer.fit(input.authorName, 28))}</text>
  ${body}
  ${ReelCardRenderer.watermarkNode()}`);
  }

  audioWish(input: { authorName: string }): Buffer {
    const esc = ReelCardRenderer.escape;
    return this.raster(`
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <text x="${W / 2}" y="${H / 2 - 60}" font-family="${FAMILY}" font-size="120" text-anchor="middle">🎤</text>
  <text x="${W / 2}" y="${H / 2 + 40}" font-family="${FAMILY}" font-size="46" font-weight="bold" fill="${TEXT}" text-anchor="middle">${esc(ReelCardRenderer.fit(input.authorName, 28))}</text>
  <text x="${W / 2}" y="${H / 2 + 100}" font-family="${FAMILY}" font-size="30" fill="${MUTED}" text-anchor="middle">sent an audio wish</text>
  ${ReelCardRenderer.watermarkNode()}`);
  }

  intro(input: { recipientName: string }): Buffer {
    const esc = ReelCardRenderer.escape;
    return this.raster(`
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <text x="${W / 2}" y="${H / 2 - 60}" font-family="${FAMILY}" font-size="150" text-anchor="middle">🎂</text>
  <text x="${W / 2}" y="${H / 2 + 60}" font-family="${FAMILY}" font-size="42" fill="${MUTED}" text-anchor="middle">Happy Birthday</text>
  <text x="${W / 2}" y="${H / 2 + 130}" font-family="${FAMILY}" font-size="60" font-weight="bold" fill="${ACCENT}" text-anchor="middle">${esc(ReelCardRenderer.fit(input.recipientName, 22))}</text>
  ${ReelCardRenderer.watermarkNode()}`);
  }

  outro(): Buffer {
    return this.raster(`
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <text x="${W / 2}" y="${H / 2 - 20}" font-family="${FAMILY}" font-size="120" text-anchor="middle">💛</text>
  <text x="${W / 2}" y="${H / 2 + 80}" font-family="${FAMILY}" font-size="44" font-weight="bold" fill="${TEXT}" text-anchor="middle">With love, from everyone</text>
  <text x="${W / 2}" y="${H - 80}" font-family="${FAMILY}" font-size="30" fill="${MUTED}" text-anchor="middle">Made with Wishtick</text>`);
  }

  /** A transparent PNG carrying just the watermark, for the final overlay pass. */
  watermark(caption: string): Buffer {
    const esc = ReelCardRenderer.escape;
    return this.raster(
      `<text x="${W / 2}" y="${H - 44}" font-family="${FAMILY}" font-size="26" fill="#ffffff" fill-opacity="0.55" text-anchor="middle">${esc(caption)}</text>`,
    );
  }

  private raster(inner: string): Buffer {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: W },
      font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
    })
      .render()
      .asPng();
    return Buffer.from(png);
  }

  private static watermarkNode(): string {
    return `<text x="${W / 2}" y="${H - 44}" font-family="${FAMILY}" font-size="24" fill="${MUTED}" fill-opacity="0.7" text-anchor="middle">Wishtick</text>`;
  }

  /** Word-wrap into at most `maxLines` lines of ~`maxChars`, ellipsizing overflow. */
  private static wrap(text: string, maxChars: number, maxLines: number): string[] {
    const words = text.trim().replace(/\s+/g, ' ').split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxChars && line) {
        lines.push(line);
        line = word;
        if (lines.length === maxLines) break;
      } else {
        line = candidate;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length === maxLines && line && lines[maxLines - 1] !== line) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxChars - 1)}…`;
    }
    return lines.length ? lines : [''];
  }

  private static fit(text: string, maxChars: number): string {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
  }

  private static escape(this: void, text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
