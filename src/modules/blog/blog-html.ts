import sanitizeHtml from 'sanitize-html';

/**
 * What a blog body may contain, and nothing more: the editor's headings, text
 * styles, lists, quotes, code, links and our own pictures. Scripts, styles,
 * event handlers, iframes and pictures from anywhere else are stripped — the
 * body is rendered as HTML on the website, so this is the line that keeps a
 * pasted `<script>` or `onerror=` from running there.
 */
export function cleanBlogHtml(html: string, imageBase: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'h2',
      'h3',
      'h4',
      'strong',
      'em',
      'u',
      's',
      'a',
      'ul',
      'ol',
      'li',
      'blockquote',
      'code',
      'pre',
      'hr',
      'img',
      'figure',
      'figcaption',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: {
      // One page title per page: the post's own. A heading 1 in the body
      // becomes a heading 2.
      h1: 'h2',
      h5: 'h4',
      h6: 'h4',
      b: 'strong',
      i: 'em',
      strike: 's',
      del: 's',
      a: (tagName, attribs) => {
        const href = attribs.href ?? '';
        const external = /^https?:\/\//i.test(href);
        return {
          tagName,
          attribs: {
            ...(href ? { href } : {}),
            ...(attribs.title ? { title: attribs.title } : {}),
            ...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {}),
          },
        };
      },
    },
    // A picture survives only if it is one we stored.
    exclusiveFilter: (frame) =>
      frame.tag === 'img' && !(frame.attribs.src ?? '').startsWith(imageBase),
  });
}

/** The words of a body, for reading time and a fallback summary. */
export function textOf(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
}

/** About 200 words a minute, never less than one. */
export function readingMinutes(html: string): number {
  const words = textOf(html).split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** A title as an address: "Gifts under ₹500!" → "gifts-under-500". */
export function slugOf(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}
