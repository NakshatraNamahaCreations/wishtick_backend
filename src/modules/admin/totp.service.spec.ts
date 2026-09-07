import { TotpService } from './totp.service';

describe('TotpService (RFC 6238 TOTP over node:crypto)', () => {
  const totp = new TotpService();

  it('accepts the current code for its own secret', async () => {
    const secret = totp.generateSecret();
    const code = await totp.current(secret);
    expect(code).toMatch(/^\d{6}$/);
    await expect(totp.verify(code, secret)).resolves.toBe(true);
  });

  it('rejects a code generated for a different secret', async () => {
    const secretA = totp.generateSecret();
    const secretB = totp.generateSecret();
    const codeForA = await totp.current(secretA);
    await expect(totp.verify(codeForA, secretB)).resolves.toBe(false);
  });

  it('rejects anything that is not six digits without touching the secret', async () => {
    const secret = totp.generateSecret();
    await expect(totp.verify('12345', secret)).resolves.toBe(false); // too short
    await expect(totp.verify('abcdef', secret)).resolves.toBe(false); // non-numeric
    await expect(totp.verify('', secret)).resolves.toBe(false);
  });

  it('matches a known RFC 6238 test vector (secret "12345678901234567890")', () => {
    // The RFC's ASCII seed, base32-encoded, at T=59s → step 1 → code 287082.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const svc = new TotpService();
    // Reach into the private step generator via a fixed counter to pin the vector.
    const code = (
      svc as unknown as { codeForCounter(s: string, c: number): string }
    ).codeForCounter(secret, 1);
    expect(code).toBe('287082');
  });

  it('builds an otpauth URI that carries the secret and issuer', () => {
    const secret = totp.generateSecret();
    const uri = totp.keyUri('root@wishtick.test', secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Wishtick+Admin');
  });
});
