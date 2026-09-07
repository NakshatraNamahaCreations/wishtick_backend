import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * True if the runtime can actually resolve the zone.
 *
 * Deliberately NOT `Intl.supportedValuesOf('timeZone').includes(tz)`. That list
 * is one ICU build's opinion about canonical names, and it disagrees with what
 * browsers send: on this runtime it contains the legacy `Asia/Calcutta`,
 * `Europe/Kiev`, and `Asia/Saigon` while EXCLUDING the modern `Asia/Kolkata`,
 * `Europe/Kyiv`, and `Asia/Ho_Chi_Minh` that `Intl.DateTimeFormat().resolvedOptions()`
 * reports in a browser. An allowlist built from it rejects the timezone of a
 * large share of real users — India especially — and the exact set shifts with
 * the ICU version bundled in the Node image.
 *
 * Asking ICU whether it can use the zone accepts both spellings and cannot
 * drift, because it is the same resolution the app will perform later.
 */
export const isValidTimezone = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    // Throws RangeError on an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** Accepts any IANA zone this runtime can resolve, canonical or alias. */
export function IsTimezone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isTimezone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown): boolean => isValidTimezone(value),
        defaultMessage: () => `${propertyName} must be a valid IANA timezone, e.g. Asia/Kolkata`,
      },
    });
  };
}
