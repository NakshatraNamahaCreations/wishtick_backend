import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  describe('hashing', () => {
    it('produces an argon2id hash that verifies', async () => {
      const hash = await service.hash('correct-horse-battery-staple');
      expect(hash.startsWith('$argon2id$')).toBe(true);
      await expect(service.verify(hash, 'correct-horse-battery-staple')).resolves.toBe(true);
    });

    it('rejects a wrong password', async () => {
      const hash = await service.hash('correct-horse-battery-staple');
      await expect(service.verify(hash, 'wrong-horse-battery-staple')).resolves.toBe(false);
    });

    it('salts, so the same password hashes differently every time', async () => {
      const [a, b] = await Promise.all([
        service.hash('same-password'),
        service.hash('same-password'),
      ]);
      expect(a).not.toBe(b);
      await expect(service.verify(a, 'same-password')).resolves.toBe(true);
      await expect(service.verify(b, 'same-password')).resolves.toBe(true);
    });

    it('returns false rather than throwing on a malformed hash', async () => {
      // A corrupt row must fail the login, not 500 the endpoint.
      await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
    });
  });

  describe('assertStrong', () => {
    const expectWeak = (password: string, context = {}): void => {
      try {
        service.assertStrong(password, context);
        throw new Error(`Expected "${password}" to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.WEAK_PASSWORD);
      }
    };

    it('accepts a long, unremarkable passphrase', () => {
      expect(() =>
        service.assertStrong('purple-monkey-dishwasher', { email: 'aarav@example.com' }),
      ).not.toThrow();
    });

    it('rejects common passwords regardless of case', () => {
      expectWeak('password123');
      expectWeak('PASSWORD123');
      expectWeak('Welcome123');
    });

    it('rejects a single repeated character', () => {
      expectWeak('aaaaaaaaaaaa');
    });

    it('rejects a password containing the email local part', () => {
      expectWeak('aarav-is-great', { email: 'aarav@example.com' });
    });

    it('rejects a password containing the name', () => {
      expectWeak('sharma-family-2024', { name: 'Sharma' });
    });

    it('rejects a password containing the phone number', () => {
      expectWeak('my-number-+919876543210', { phone: '+919876543210' });
    });

    it('ignores personal fragments too short to be meaningful', () => {
      // A 2-character name would otherwise ban most of the dictionary.
      expect(() => service.assertStrong('jovial-turnip-parade', { name: 'Jo' })).not.toThrow();
    });
  });
});
