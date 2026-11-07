import { ApiProperty } from '@nestjs/swagger';

/**
 * A UPI transaction ID (UTR): exactly twelve digits, as every bank app shows
 * it. Anything else is a typo or a different number — an order ID, a phone
 * number — and would send the host hunting for a payment they cannot find.
 *
 * Mirrored in the app and on the web, which say so before anything is sent.
 */
export const PAYMENT_REF_PATTERN = /^\d{12}$/;

export const PAYMENT_REF_EXAMPLE = '412345678901';

export const isValidPaymentRef = (value: unknown): boolean =>
  typeof value === 'string' && PAYMENT_REF_PATTERN.test(value);

/**
 * Documents the twelve-digit rule on a DTO property, for Swagger.
 *
 * Deliberately not a class-validator rule. A bad ref is refused by the
 * service with `PAYMENT_REF_INVALID` — the code both clients key their
 * inline error on — and a validator here would turn that into a generic
 * `VALIDATION_FAILED` before the service ever saw it. The service calls
 * [isValidPaymentRef]; this only tells the docs what it will accept.
 */
export function IsPaymentRef(): PropertyDecorator {
  return ApiProperty({
    pattern: PAYMENT_REF_PATTERN.source,
    minLength: 12,
    maxLength: 12,
    example: PAYMENT_REF_EXAMPLE,
  });
}
