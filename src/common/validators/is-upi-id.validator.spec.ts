import { isValidUpiId } from './is-upi-id.validator';

describe('isValidUpiId', () => {
  it.each(['rohanr1@okaxis', 'rohan.r@oksbi', 'priya_s-2@ybl', '9876543210@paytm', 'ab@upi'])(
    'accepts %s',
    (id) => expect(isValidUpiId(id)).toBe(true),
  );

  it.each([
    'xyz@sss@com',
    'xyz@sss.com',
    'xyz',
    '@okaxis',
    'x@okaxis',
    'name@',
    'name @okaxis',
    'name@ok axis',
    'name@9bank',
    'name@axis1',
    '',
    42,
    null,
  ])('refuses %p', (id) => expect(isValidUpiId(id)).toBe(false));
});
