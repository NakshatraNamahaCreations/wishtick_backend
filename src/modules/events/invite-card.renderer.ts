import { Injectable } from '@nestjs/common';
import { Resvg } from '@resvg/resvg-js';
import type { ColorVariant, InviteTemplate } from './invite-templates.data';

export interface CardContent {
  headline: string;
  subtitle: string | null;
  hostLine: string | null;
  venue: string | null;
  note: string | null;
  /** Already formatted in the event's own timezone by the caller. */
  dateLine: string;
}

/** 1200×630 is the Open Graph standard, and what WhatsApp crops to. */
const WIDTH = 1200;
const HEIGHT = 630;

@Injectable()
export class InviteCardRenderer {
  /**
   * Renders the share card as a PNG.
   *
   * PNG rather than the SVG we compose it from: unfurlers (WhatsApp, iMessage,
   * Slack) do not render SVG, so an SVG og:image simply shows no preview — and
   * serving user-influenced SVG from our own origin would be stored XSS besides.
   */
  render(template: InviteTemplate, variant: ColorVariant, content: CardContent): Buffer {
    const svg = InviteCardRenderer.buildSvg(template, variant, content);
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: WIDTH },
      // No `loadSystemFonts: false` gymnastics and no remote font fetching: the
      // renderer must never make a network request while drawing a card from
      // user input.
      font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
    })
      .render()
      .asPng();

    return Buffer.from(png);
  }

  private static buildSvg(template: InviteTemplate, v: ColorVariant, c: CardContent): string {
    const serif = template.id === 'romantic';
    const family = serif ? 'Georgia, Times New Roman, serif' : 'Arial, Helvetica, sans-serif';
    const centred = template.id !== 'modern';
    const x = centred ? WIDTH / 2 : 90;
    const anchor = centred ? 'middle' : 'start';

    const headline = InviteCardRenderer.fit(c.headline, 28);
    const subtitle = c.subtitle ? InviteCardRenderer.fit(c.subtitle, 46) : null;
    const venue = c.venue ? InviteCardRenderer.fit(c.venue, 52) : null;
    const note = c.note ? InviteCardRenderer.fit(c.note, 64) : null;
    const hostLine = c.hostLine ? InviteCardRenderer.fit(c.hostLine, 40) : null;

    // Every interpolation below goes through esc(). The values are host-supplied
    // copy, and an unescaped `</text><script>` would break out of the node — the
    // rasterizer would refuse the malformed SVG at best, and at worst we would
    // be composing markup from user input.
    const esc = InviteCardRenderer.escape;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${esc(v.background)}"/>
  <rect x="0" y="0" width="${WIDTH}" height="12" fill="${esc(v.accent)}"/>
  ${
    centred
      ? `<circle cx="${WIDTH / 2}" cy="118" r="34" fill="none" stroke="${esc(v.accent)}" stroke-width="3"/>
         <text x="${WIDTH / 2}" y="130" font-family="${family}" font-size="34" fill="${esc(v.accent)}" text-anchor="middle">✦</text>`
      : `<rect x="90" y="86" width="64" height="6" fill="${esc(v.accent)}"/>`
  }
  <text x="${x}" y="${centred ? 236 : 214}" font-family="${family}" font-size="66" font-weight="bold"
        fill="${esc(v.text)}" text-anchor="${anchor}">${esc(headline)}</text>
  ${
    subtitle
      ? `<text x="${x}" y="${centred ? 294 : 272}" font-family="${family}" font-size="30"
              fill="${esc(v.muted)}" text-anchor="${anchor}">${esc(subtitle)}</text>`
      : ''
  }
  <rect x="${centred ? WIDTH / 2 - 210 : 90}" y="${centred ? 336 : 316}" width="420" height="64" rx="32"
        fill="${esc(v.accent)}"/>
  <text x="${centred ? WIDTH / 2 : 300}" y="${centred ? 377 : 357}" font-family="${family}" font-size="27"
        font-weight="bold" fill="${esc(v.background)}" text-anchor="middle">${esc(c.dateLine)}</text>
  ${
    venue
      ? `<text x="${x}" y="${centred ? 448 : 428}" font-family="${family}" font-size="26"
              fill="${esc(v.text)}" text-anchor="${anchor}">${esc(venue)}</text>`
      : ''
  }
  ${
    note
      ? `<text x="${x}" y="${centred ? 492 : 472}" font-family="${family}" font-size="22"
              fill="${esc(v.muted)}" text-anchor="${anchor}">${esc(note)}</text>`
      : ''
  }
  ${
    hostLine
      ? `<text x="${x}" y="${centred ? 552 : 532}" font-family="${family}" font-size="24"
              fill="${esc(v.muted)}" text-anchor="${anchor}">${esc(hostLine)}</text>`
      : ''
  }
  <text x="${WIDTH - 40}" y="${HEIGHT - 32}" font-family="${family}" font-size="20"
        fill="${esc(v.muted)}" text-anchor="end">wishtick</text>
</svg>`;
  }

  /**
   * Truncates to what fits on one line at the card's font size.
   *
   * Wrapping would be better, but SVG `<text>` does not wrap and laying out
   * lines by hand needs font metrics we do not have. The slot maxLengths in the
   * template are the real guard; this is the backstop that keeps a long word
   * from running off the canvas.
   */
  private static fit(text: string, maxChars: number): string {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
  }

  /**
   * XML-escapes text for interpolation into an SVG node.
   *
   * `this: void` because it is pulled off the class into a local `esc` above;
   * it uses no instance state, and the annotation says so to the linter.
   */
  private static escape(this: void, text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
