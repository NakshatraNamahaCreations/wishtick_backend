import { InviteCardRenderer } from './invite-card.renderer';
import { INVITE_TEMPLATES, findVariant } from './invite-templates.data';
import type { CardContent } from './invite-card.renderer';

describe('InviteCardRenderer', () => {
  const renderer = new InviteCardRenderer();
  const template = INVITE_TEMPLATES[0];
  const variant = template.variants[0];

  const content = (over: Partial<CardContent> = {}): CardContent => ({
    headline: "Aarav's 30th",
    subtitle: 'Come celebrate',
    hostLine: 'Hosted by Aarav',
    venue: 'The Terrace',
    note: 'Dress up!',
    dateLine: 'Sat 14 Sep, 7:00 pm',
    ...over,
  });

  it('rasterizes to a valid PNG', () => {
    const png = renderer.render(template, variant, content());
    expect(png.length).toBeGreaterThan(1_000);
    // PNG magic bytes — proof it actually rasterized rather than returned junk.
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('renders every template and variant without throwing', () => {
    // A broken palette or slot would surface as a rasterizer error here rather
    // than as a blank share card in production.
    for (const t of INVITE_TEMPLATES) {
      for (const v of t.variants) {
        expect(() => renderer.render(t, v, content())).not.toThrow();
      }
    }
  });

  it('renders with the optional lines omitted', () => {
    const png = renderer.render(
      template,
      variant,
      content({ subtitle: null, hostLine: null, venue: null, note: null }),
    );
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  /**
   * The security-relevant case.
   *
   * The card is composed as SVG from host-supplied copy. An unescaped
   * `</text>` would break out of the text node; at best the rasterizer rejects
   * the malformed document and we lose the card, at worst we are assembling
   * markup from user input. The renderer must escape, so a hostile headline
   * still produces a valid PNG.
   */
  it('does not break on markup in host copy', () => {
    const hostile = content({
      headline: '</text><script>alert(1)</script>',
      venue: 'A & B "Hall" <injected>',
      note: "O'Brien's party & friends",
    });
    const png = renderer.render(template, variant, hostile);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('produces a 1200-wide Open Graph card', () => {
    // WhatsApp crops to 1200×630; a differently-sized image unfurls wrong.
    const png = renderer.render(template, variant, content());
    // PNG width is a big-endian uint32 at byte offset 16.
    expect(png.readUInt32BE(16)).toBe(1200);
  });

  it('every template exposes the shared slot keys', () => {
    // Switching design must not throw away copy the host already wrote, so the
    // resolver depends on the keys being stable across templates.
    for (const t of INVITE_TEMPLATES) {
      const keys = t.slots.map((s) => s.key);
      expect(keys).toContain('headline');
      expect(t.variants).toHaveLength(6);
      // Every variant referenced by key must exist.
      expect(findVariant(t, t.variants[0].key)).toBeDefined();
    }
  });
});
