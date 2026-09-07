export enum UserRole {
  USER = 'user',
  /**
   * Admin roles are modelled in Sprint 11 on a separate `Admin` collection with
   * its own JWT audience. This value exists only so RolesGuard has something to
   * assert against before then — it is never granted to a signup.
   */
  ADMIN = 'admin',
}

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
}
