import { EventType } from './event.types';

export interface TemplateSlot {
  key: string;
  label: string;
  /** Shown when the host leaves it blank. */
  placeholder: string;
  maxLength: number;
  required: boolean;
}

export interface ColorVariant {
  key: string;
  label: string;
  background: string;
  /** Accent used for the headline and the date chip. */
  accent: string;
  text: string;
  muted: string;
}

export interface InviteTemplate {
  id: string;
  name: string;
  description: string;
  /** Which occasions this design is offered for. */
  eventTypes: EventType[];
  slots: TemplateSlot[];
  variants: ColorVariant[];
}

const slot = (
  key: string,
  label: string,
  placeholder: string,
  maxLength: number,
  required = false,
): TemplateSlot => ({ key, label, placeholder, maxLength, required });

/**
 * Shared slot vocabulary.
 *
 * Every template exposes the same keys where it can, so switching design does
 * not throw away the copy the host already wrote.
 */
const COMMON_SLOTS: TemplateSlot[] = [
  slot('headline', 'Headline', "You're invited", 60, true),
  slot('subtitle', 'Subtitle', 'Join us to celebrate', 90),
  slot('hostLine', 'Hosted by', 'Hosted by Aarav', 60),
  slot('venue', 'Venue', 'The Terrace, Bengaluru', 120),
  slot('note', 'Note to guests', 'Dress code: whatever makes you happy', 160),
];

/**
 * Six variants per template, as the scope asks.
 *
 * Palettes are fixed rather than free-form hex: these are rasterized into a
 * share card, and a host-chosen colour pair can easily be unreadable (white on
 * yellow) or off-brand. Choosing from a curated set means every generated
 * invite is legible.
 */
const variants = (entries: [string, string, string, string, string, string][]): ColorVariant[] =>
  entries.map(([key, label, background, accent, text, muted]) => ({
    key,
    label,
    background,
    accent,
    text,
    muted,
  }));

const CELEBRATION_VARIANTS = variants([
  ['blush', 'Blush', '#FFF1F3', '#E5397B', '#2B1B20', '#8A6B74'],
  ['midnight', 'Midnight', '#141A2E', '#F2C94C', '#F7F8FC', '#9AA3BD'],
  ['sage', 'Sage', '#EEF4EC', '#3F7D58', '#1D2A22', '#6E8878'],
  ['sunset', 'Sunset', '#FFF4E8', '#E2622B', '#33200F', '#9A7458'],
  ['lilac', 'Lilac', '#F4F0FB', '#7B4BD1', '#241833', '#7C6E96'],
  ['ink', 'Ink', '#F5F5F4', '#1F1F1F', '#1F1F1F', '#6B6B6B'],
]);

const ROMANTIC_VARIANTS = variants([
  ['rose', 'Rose', '#FFF0F0', '#C4304B', '#2D1418', '#8C666C'],
  ['gold', 'Gold', '#FBF6EC', '#B08423', '#2B2313', '#8B7B5C'],
  ['ivory', 'Ivory', '#FCFBF7', '#4A5D4E', '#22271F', '#7B8479'],
  ['claret', 'Claret', '#2A1119', '#E8B4B8', '#FBF1F2', '#B78E95'],
  ['dusk', 'Dusk', '#EDF1F7', '#3D5A80', '#161E2B', '#6E7F96'],
  ['pearl', 'Pearl', '#F7F7FA', '#8E7CC3', '#22202B', '#7E7A90'],
]);

const MODERN_VARIANTS = variants([
  ['mono', 'Mono', '#FFFFFF', '#111111', '#111111', '#767676'],
  ['electric', 'Electric', '#0B1020', '#4CC9F0', '#EAF2FF', '#8CA0C6'],
  ['citrus', 'Citrus', '#FEFCE8', '#CA8A04', '#2A2408', '#8B7F4B'],
  ['forest', 'Forest', '#0F1F16', '#7BD389', '#EAF7EE', '#8DAF98'],
  ['coral', 'Coral', '#FFF5F2', '#FF6B4A', '#33170F', '#9C7166'],
  ['slate', 'Slate', '#F1F5F9', '#334155', '#0F172A', '#64748B'],
]);

/**
 * The three launch designs.
 *
 * Held in code rather than seeded into Mongo: unlike the taxonomy (which admins
 * edit in Sprint 11), these are design assets whose slots and palettes the
 * renderer depends on. A template whose slot list drifts from the SVG that
 * renders it produces a broken share card, so they version with the code that
 * draws them. They are still served over the API, so clients never hardcode
 * them either.
 */
export const INVITE_TEMPLATES: InviteTemplate[] = [
  {
    id: 'celebration',
    name: 'Celebration',
    description: 'Bold headline over a soft wash. Made for birthdays.',
    eventTypes: [EventType.BIRTHDAY, EventType.GENERIC, EventType.SPECIAL],
    slots: COMMON_SLOTS,
    variants: CELEBRATION_VARIANTS,
  },
  {
    id: 'romantic',
    name: 'Romantic',
    description: 'Quiet, centred, serif. Made for anniversaries.',
    eventTypes: [EventType.ANNIVERSARY, EventType.SPECIAL],
    slots: COMMON_SLOTS,
    variants: ROMANTIC_VARIANTS,
  },
  {
    id: 'modern',
    name: 'Modern',
    description: 'Flat, high-contrast, left-aligned. Made for anything.',
    eventTypes: [EventType.GENERIC, EventType.BIRTHDAY, EventType.ANNIVERSARY, EventType.SPECIAL],
    slots: COMMON_SLOTS,
    variants: MODERN_VARIANTS,
  },
];

export const findTemplate = (id: string): InviteTemplate | undefined =>
  INVITE_TEMPLATES.find((t) => t.id === id);

export const findVariant = (template: InviteTemplate, key: string): ColorVariant | undefined =>
  template.variants.find((v) => v.key === key);

export const templatesForType = (type?: EventType): InviteTemplate[] =>
  type ? INVITE_TEMPLATES.filter((t) => t.eventTypes.includes(type)) : INVITE_TEMPLATES;
