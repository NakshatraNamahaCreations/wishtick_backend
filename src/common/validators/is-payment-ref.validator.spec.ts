import 'reflect-metadata';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsPaymentRef, isValidPaymentRef, PAYMENT_REF_PATTERN } from './is-payment-ref.validator';

/** `DECORATORS.API_MODEL_PROPERTIES` — the package does not export its constants. */
const API_MODEL_PROPERTIES = 'swagger/apiModelProperties';

describe('isValidPaymentRef', () => {
  it.each(['412345678901', '000000000000', '999999999999'])('accepts %s', (ref) =>
    expect(isValidPaymentRef(ref)).toBe(true),
  );

  it.each([
    '41234567890',
    '4123456789012',
    '41234567890a',
    '4123 4567 8901',
    ' 412345678901',
    'T2409151234567890',
    '',
    412345678901,
    null,
    undefined,
  ])('refuses %p', (ref) => expect(isValidPaymentRef(ref)).toBe(false));
});

describe('IsPaymentRef', () => {
  class Dto {
    @ApiPropertyOptional({ description: 'The UPI transaction ID.' })
    @IsPaymentRef()
    paymentRef?: string;
  }

  it('documents the twelve-digit rule without taking over the property', () => {
    const meta = Reflect.getMetadata(API_MODEL_PROPERTIES, Dto.prototype, 'paymentRef') as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({
      description: 'The UPI transaction ID.',
      required: false,
      pattern: PAYMENT_REF_PATTERN.source,
      minLength: 12,
      maxLength: 12,
    });
  });
});
