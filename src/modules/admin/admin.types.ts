export enum AdminRole {
  SUPER_ADMIN = 'super_admin',
  MODERATOR = 'moderator',
  SUPPORT = 'support',
  ANALYST = 'analyst',
}

/**
 * Fine-grained capabilities. Routes assert a permission, not a role, so the
 * role→permission mapping can change without touching a single guard.
 */
export enum AdminPermission {
  ADMINS_MANAGE = 'admins:manage',
  USERS_VIEW = 'users:view',
  USERS_MANAGE = 'users:manage',
  MODERATION_VIEW = 'moderation:view',
  MODERATION_ACT = 'moderation:act',
  ANALYTICS_VIEW = 'analytics:view',
  AUDIT_VIEW = 'audit:view',
  /** Wishlists, events, memories, reels, chats, media — read. */
  CONTENT_VIEW = 'content:view',
  /** …and archive, cancel, remove, restore. */
  CONTENT_MANAGE = 'content:manage',
  /** Gifts, orders, group gifts, settlements, affiliate — read. */
  MONEY_VIEW = 'money:view',
  /** …and the manual overrides, each with a reason. */
  MONEY_MANAGE = 'money:manage',
  NOTIFICATIONS_VIEW = 'notifications:view',
  NOTIFICATIONS_SEND = 'notifications:send',
  /** Queues, health, provider quota, cache. */
  OPS_VIEW = 'ops:view',
  OPS_MANAGE = 'ops:manage',
  /** Taxonomy and the product catalogue. */
  CATALOG_MANAGE = 'catalog:manage',
  /**
   * Reveal what is masked by default — private chats and memories, addresses,
   * UPI IDs, full phone and email. Every reveal is audited with a reason.
   */
  SENSITIVE_VIEW = 'sensitive:view',
  /** The raw stored document, for debugging. */
  DEBUG_VIEW = 'debug:view',
  /** Server-side CSV exports. */
  EXPORT_DATA = 'export:data',
}

/**
 * THE permission matrix. Super admin has everything; the rest are least-privilege
 * for their job. Read by AdminGuard and nothing else decides what a role can do.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  [AdminRole.SUPER_ADMIN]: Object.values(AdminPermission),
  [AdminRole.MODERATOR]: [
    AdminPermission.MODERATION_VIEW,
    AdminPermission.MODERATION_ACT,
    AdminPermission.USERS_VIEW,
    AdminPermission.AUDIT_VIEW,
    AdminPermission.CONTENT_VIEW,
    AdminPermission.CONTENT_MANAGE,
    AdminPermission.SENSITIVE_VIEW,
  ],
  [AdminRole.SUPPORT]: [
    AdminPermission.USERS_VIEW,
    AdminPermission.USERS_MANAGE,
    AdminPermission.MODERATION_VIEW,
    AdminPermission.AUDIT_VIEW,
    AdminPermission.CONTENT_VIEW,
    AdminPermission.MONEY_VIEW,
    AdminPermission.NOTIFICATIONS_VIEW,
    AdminPermission.SENSITIVE_VIEW,
  ],
  [AdminRole.ANALYST]: [
    AdminPermission.ANALYTICS_VIEW,
    AdminPermission.USERS_VIEW,
    AdminPermission.MONEY_VIEW,
    AdminPermission.EXPORT_DATA,
  ],
};

/** The union of permissions granted by a set of roles. */
export function permissionsFor(roles: AdminRole[]): AdminPermission[] {
  return [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []))];
}

export function hasPermission(roles: AdminRole[], permission: AdminPermission): boolean {
  return roles.some((r) => (ROLE_PERMISSIONS[r] ?? []).includes(permission));
}

export enum AdminStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

/** What a verified admin JWT resolves to on the request. */
export interface AuthenticatedAdmin {
  id: string;
  email: string;
  name: string;
  /** False until two-factor sign-in is set up — see AdminGuard. */
  totpEnabled: boolean;
  roles: AdminRole[];
  permissions: AdminPermission[];
  jti: string;
}

/** The signed admin-token claims. `ims` is the ms issue time (logout-all cutoff). */
export interface AdminTokenPayload {
  sub: string;
  jti: string;
  email: string;
  roles: AdminRole[];
  ims: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}
