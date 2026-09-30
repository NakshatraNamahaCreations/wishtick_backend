import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * A UPI ID (VPA): a name, one `@`, and the bank's handle — `rohan.r@okaxis`.
 *
 * The name is 2–256 letters, digits, dots, hyphens and underscores, as the
 * banks issue them. The handle is 2–64 letters: `okaxis`, `ybl`, `paytm`. A second `@`, a dot in the handle or a space is not a UPI ID
 * and never will be, and taking one would hand every member of a group an
 * address their payment app refuses.
 *
 * Mirrored in the app (`isValidUpiId`), which says so before anything is sent.
 */
export const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;

export const isValidUpiId = (value: unknown): boolean =>
  typeof value === 'string' && UPI_ID_PATTERN.test(value);

export function IsUpiId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isUpiId',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown): boolean => isValidUpiId(value),
        defaultMessage: () => 'Enter a valid UPI ID, like name@okaxis',
      },
    });
  };
}
