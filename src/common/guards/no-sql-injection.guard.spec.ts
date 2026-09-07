import { type ExecutionContext } from '@nestjs/common';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { NoSqlInjectionGuard } from './no-sql-injection.guard';

const httpContext = (req: unknown): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('NoSqlInjectionGuard', () => {
  const guard = new NoSqlInjectionGuard();

  it('allows an ordinary request through', () => {
    const ctx = httpContext({ body: { email: 'a@b.com', name: 'Ada' }, query: { page: '1' } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects an operator object in the body', () => {
    const ctx = httpContext({ body: { email: { $gt: '' } }, query: {} });
    expect(() => guard.canActivate(ctx)).toThrow(AppException);
    try {
      guard.canActivate(ctx);
    } catch (e) {
      expect((e as AppException).errorCode).toBe(ErrorCode.SUSPECT_INPUT_REJECTED);
      expect((e as AppException).getStatus()).toBe(400);
    }
  });

  it('rejects a nested operator key', () => {
    const ctx = httpContext({
      body: { filter: { nested: { $where: 'sleep(1000)' } } },
      query: {},
    });
    expect(() => guard.canActivate(ctx)).toThrow(AppException);
  });

  it('rejects an operator key inside an array element', () => {
    const ctx = httpContext({ body: { items: [{ id: 1 }, { $ne: null }] }, query: {} });
    expect(() => guard.canActivate(ctx)).toThrow(AppException);
  });

  it('rejects an operator smuggled in the query string', () => {
    const ctx = httpContext({ body: {}, query: { status: { $ne: 'deleted' } } });
    expect(() => guard.canActivate(ctx)).toThrow(AppException);
  });

  it('does not choke on a null or primitive body', () => {
    expect(guard.canActivate(httpContext({ body: null, query: undefined }))).toBe(true);
    expect(guard.canActivate(httpContext({ body: 'raw-string', query: {} }))).toBe(true);
  });

  it('allows a legitimate value that merely contains a $ mid-string', () => {
    // The dollar sign is only dangerous as a KEY prefix; a value is fine.
    const ctx = httpContext({ body: { note: 'costs $5', price: '$10' }, query: {} });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('ignores non-http execution contexts (ws/rpc)', () => {
    const ctx = { getType: () => 'ws' } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
