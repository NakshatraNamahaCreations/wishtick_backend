import {
  AdminPermission,
  AdminRole,
  ROLE_PERMISSIONS,
  hasPermission,
  permissionsFor,
} from './admin.types';
import { ReportSource, ReportTargetType, severityFor } from './moderation.types';

describe('admin permission matrix', () => {
  it('grants the super admin every permission', () => {
    const all = Object.values(AdminPermission);
    expect(permissionsFor([AdminRole.SUPER_ADMIN]).sort()).toEqual([...all].sort());
    for (const perm of all) {
      expect(hasPermission([AdminRole.SUPER_ADMIN], perm)).toBe(true);
    }
  });

  it('keeps a moderator away from analytics and admin management', () => {
    expect(hasPermission([AdminRole.MODERATOR], AdminPermission.MODERATION_ACT)).toBe(true);
    expect(hasPermission([AdminRole.MODERATOR], AdminPermission.USERS_VIEW)).toBe(true);
    expect(hasPermission([AdminRole.MODERATOR], AdminPermission.ANALYTICS_VIEW)).toBe(false);
    expect(hasPermission([AdminRole.MODERATOR], AdminPermission.ADMINS_MANAGE)).toBe(false);
    // A moderator can view users but not suspend them — that is support's job.
    expect(hasPermission([AdminRole.MODERATOR], AdminPermission.USERS_MANAGE)).toBe(false);
  });

  it('gives support user management but no moderation actions', () => {
    expect(hasPermission([AdminRole.SUPPORT], AdminPermission.USERS_MANAGE)).toBe(true);
    expect(hasPermission([AdminRole.SUPPORT], AdminPermission.MODERATION_VIEW)).toBe(true);
    expect(hasPermission([AdminRole.SUPPORT], AdminPermission.MODERATION_ACT)).toBe(false);
    expect(hasPermission([AdminRole.SUPPORT], AdminPermission.ANALYTICS_VIEW)).toBe(false);
  });

  it('limits the analyst to read-only analytics + users', () => {
    expect(hasPermission([AdminRole.ANALYST], AdminPermission.ANALYTICS_VIEW)).toBe(true);
    expect(hasPermission([AdminRole.ANALYST], AdminPermission.USERS_VIEW)).toBe(true);
    expect(hasPermission([AdminRole.ANALYST], AdminPermission.USERS_MANAGE)).toBe(false);
    expect(hasPermission([AdminRole.ANALYST], AdminPermission.MODERATION_ACT)).toBe(false);
  });

  it('unions permissions across multiple roles without duplicates', () => {
    const perms = permissionsFor([AdminRole.MODERATOR, AdminRole.ANALYST]);
    expect(perms).toContain(AdminPermission.MODERATION_ACT);
    expect(perms).toContain(AdminPermission.ANALYTICS_VIEW);
    // USERS_VIEW is in both role sets — must appear once.
    expect(perms.filter((p) => p === AdminPermission.USERS_VIEW)).toHaveLength(1);
  });

  it('has an entry for every role (no role can silently grant nothing by omission)', () => {
    for (const role of Object.values(AdminRole)) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });
});

describe('moderation severityFor', () => {
  it('ranks a reported person above reported content', () => {
    const user = severityFor(ReportTargetType.USER, ReportSource.USER);
    const wishlist = severityFor(ReportTargetType.WISHLIST, ReportSource.USER);
    expect(user).toBeGreaterThan(wishlist);
  });

  it('bumps auto-flagged content above the same user-reported content', () => {
    const auto = severityFor(ReportTargetType.MESSAGE, ReportSource.AUTO);
    const manual = severityFor(ReportTargetType.MESSAGE, ReportSource.USER);
    expect(auto).toBe(manual + 1);
  });
});
