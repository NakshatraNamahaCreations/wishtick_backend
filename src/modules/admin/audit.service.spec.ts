import { AuditService } from './audit.service';

describe('AuditService.diff — the readable audit diff', () => {
  it('reports only the fields that actually changed', () => {
    const diff = AuditService.diff(
      { status: 'active', suspendedReason: null },
      { status: 'suspended', suspendedReason: 'spam' },
    );
    expect(diff).toEqual([
      { field: 'status', before: 'active', after: 'suspended' },
      { field: 'suspendedReason', before: null, after: 'spam' },
    ]);
  });

  it('omits fields whose value is unchanged', () => {
    const diff = AuditService.diff(
      { status: 'active', roles: ['user'] },
      { status: 'suspended', roles: ['user'] },
    );
    expect(diff).toHaveLength(1);
    expect(diff[0].field).toBe('status');
  });

  it('detects a change inside an array or object by value, not reference', () => {
    const diff = AuditService.diff({ roles: ['user'] }, { roles: ['user', 'vip'] });
    expect(diff).toEqual([{ field: 'roles', before: ['user'], after: ['user', 'vip'] }]);
  });

  it('captures a newly-added field (before is undefined → null)', () => {
    const diff = AuditService.diff({}, { tokensInvalidBefore: '2026-07-18T00:00:00.000Z' });
    expect(diff).toEqual([
      { field: 'tokensInvalidBefore', before: null, after: '2026-07-18T00:00:00.000Z' },
    ]);
  });

  it('returns an empty diff when nothing changed', () => {
    expect(AuditService.diff({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
  });
});
