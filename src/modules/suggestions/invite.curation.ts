import { EventType } from '../events/event.types';

/**
 * An event's kind, as an occasion the curation tables already know.
 *
 * Events have four types where occasions have a dozen terms, so this is a
 * widening, not a mapping table with gaps: `generic` says nothing about what
 * to buy and deliberately resolves to nothing, leaving the shelf to the
 * relation and then to the defaults.
 */
export const OCCASION_FOR_EVENT_TYPE: Readonly<Record<string, string | null>> = {
  [EventType.BIRTHDAY]: 'birthday',
  [EventType.ANNIVERSARY]: 'anniversary',
  [EventType.SPECIAL]: 'special_moments',
  [EventType.GENERIC]: null,
};

export const occasionForEventType = (type: string): string | null =>
  OCCASION_FOR_EVENT_TYPE[type] ?? null;

/**
 * The heading over a guest's shelf.
 *
 * Named for the person when the invitation names one, and for nobody when it
 * does not — "Gift ideas for the celebration" is honest, while inventing a
 * name or reusing the host's would not be.
 */
export function inviteShelfTitle(personName: string | null): string {
  const name = personName?.trim();
  return name ? `Gift ideas for ${name}` : 'Gift ideas for the celebration';
}
