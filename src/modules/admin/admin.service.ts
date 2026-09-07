import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { PasswordService } from 'src/modules/auth/services/password.service';
import { AdminTokenService } from './admin-token.service';
import { AdminRole, AdminStatus, type AuthenticatedAdmin, permissionsFor } from './admin.types';
import { Admin, type AdminDocument } from './schemas/admin.schema';
import { TotpService } from './totp.service';

export interface AdminView {
  id: string;
  email: string;
  name: string;
  roles: AdminRole[];
  permissions: string[];
  status: string;
  totpEnabled: boolean;
  ipAllowlist: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class AdminService implements OnModuleInit {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectModel(Admin.name) private readonly adminModel: Model<AdminDocument>,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly tokens: AdminTokenService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Seeds the first super-admin from env if none exists — the only bootstrap. */
  async onModuleInit(): Promise<void> {
    const { bootstrapEmail, bootstrapPassword } = this.config.get('admin', { infer: true });
    if (!bootstrapEmail || !bootstrapPassword) return;
    const email = bootstrapEmail.toLowerCase();
    if (await this.adminModel.exists({ email })) return;
    await this.create({
      email,
      password: bootstrapPassword,
      name: 'Bootstrap Super Admin',
      roles: [AdminRole.SUPER_ADMIN],
    });
    this.logger.log(`Bootstrapped super-admin ${email}`);
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  /**
   * Password + (mandatory once enrolled) TOTP. Every failure returns the same
   * generic credential error so login is not a probe for which admins exist.
   * A brand-new admin has no TOTP yet, so their first login is password-only and
   * flags `setupRequired` — enrolling 2FA is then mandatory.
   */
  async login(
    input: { email: string; password: string; totp?: string },
    ip: string | null,
  ): Promise<{
    accessToken: string;
    expiresInSeconds: number;
    admin: AdminView;
    setupRequired: boolean;
  }> {
    const admin = await this.adminModel.findOne({ email: input.email.toLowerCase() }).exec();
    if (!admin || admin.status !== AdminStatus.ACTIVE) {
      throw new AppException(ErrorCode.ADMIN_CREDENTIALS_INVALID, 'Invalid credentials', 401);
    }
    this.assertIpAllowed(admin, ip);
    if (!(await this.passwords.verify(admin.passwordHash, input.password))) {
      throw new AppException(ErrorCode.ADMIN_CREDENTIALS_INVALID, 'Invalid credentials', 401);
    }
    if (admin.totpEnabled) {
      if (!input.totp) {
        throw new AppException(ErrorCode.ADMIN_TOTP_REQUIRED, 'A 2FA code is required', 401);
      }
      if (!admin.totpSecret || !(await this.totp.verify(input.totp, admin.totpSecret))) {
        throw new AppException(ErrorCode.ADMIN_TOTP_INVALID, 'Invalid 2FA code', 401);
      }
    }
    admin.lastLoginAt = new Date();
    await admin.save();
    const token = await this.tokens.mint(admin);
    return { ...token, admin: AdminService.toView(admin), setupRequired: !admin.totpEnabled };
  }

  async logout(jti: string): Promise<void> {
    // Denylist for the full session length — the jti is single-use, so
    // over-covering costs nothing and there is no exp to read off the payload.
    const ttlSeconds = this.config.get('admin.accessTtlHours', { infer: true }) * 3600;
    await this.tokens.denylist(jti, Math.floor(Date.now() / 1000) + ttlSeconds);
  }

  // ── TOTP enrollment ─────────────────────────────────────────────────────────

  async setupTotp(adminId: string): Promise<{ secret: string; keyUri: string }> {
    const admin = await this.findActive(adminId);
    if (admin.totpEnabled) {
      throw new AppException(ErrorCode.ADMIN_TOTP_ALREADY_ENABLED, '2FA is already enabled', 409);
    }
    const secret = this.totp.generateSecret();
    admin.totpSecret = secret; // pending until verified
    await admin.save();
    return { secret, keyUri: this.totp.keyUri(admin.email, secret) };
  }

  async enableTotp(adminId: string, token: string): Promise<void> {
    const admin = await this.findActive(adminId);
    if (admin.totpEnabled) {
      throw new AppException(ErrorCode.ADMIN_TOTP_ALREADY_ENABLED, '2FA is already enabled', 409);
    }
    if (!admin.totpSecret || !(await this.totp.verify(token, admin.totpSecret))) {
      throw new AppException(ErrorCode.ADMIN_TOTP_INVALID, 'Invalid 2FA code', 401);
    }
    admin.totpEnabled = true;
    await admin.save();
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  async create(input: {
    email: string;
    password: string;
    name: string;
    roles: AdminRole[];
    ipAllowlist?: string[];
  }): Promise<AdminDocument> {
    const passwordHash = await this.passwords.hash(input.password);
    try {
      return await this.adminModel.create({
        email: input.email.toLowerCase(),
        passwordHash,
        name: input.name,
        roles: input.roles,
        ipAllowlist: input.ipAllowlist ?? [],
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        throw new AppException(ErrorCode.CONFLICT, 'An admin with this email already exists', 409);
      }
      throw err;
    }
  }

  /**
   * Update an admin's name, roles, status, or IP allowlist.
   *
   * Two lockout guards, both of which have to live here rather than in the UI:
   * an operator must not be able to disable or demote *themselves* out of the
   * panel, and the last active super-admin must not be removable — either one
   * leaves nobody who can administer the platform, and the only recovery is a
   * manual database write.
   */
  async update(
    adminId: string,
    input: {
      name?: string;
      roles?: AdminRole[];
      status?: AdminStatus;
      ipAllowlist?: string[];
    },
    actor: AuthenticatedAdmin,
  ): Promise<AdminDocument> {
    const admin = await this.findAny(adminId);
    const isSelf = admin._id.toString() === actor.id;

    if (isSelf && input.status === AdminStatus.DISABLED) {
      throw new AppException(ErrorCode.ADMIN_FORBIDDEN, 'You cannot disable your own account', 403);
    }
    if (isSelf && input.roles && !input.roles.includes(AdminRole.SUPER_ADMIN)) {
      throw new AppException(
        ErrorCode.ADMIN_FORBIDDEN,
        'You cannot remove your own super-admin role',
        403,
      );
    }

    const losesSuperAdmin =
      (input.roles && !input.roles.includes(AdminRole.SUPER_ADMIN)) ||
      input.status === AdminStatus.DISABLED;
    if (admin.roles.includes(AdminRole.SUPER_ADMIN) && losesSuperAdmin) {
      await this.assertNotLastSuperAdmin(admin._id.toString());
    }

    if (input.name !== undefined) admin.name = input.name;
    if (input.roles !== undefined) admin.roles = input.roles;
    if (input.ipAllowlist !== undefined) admin.ipAllowlist = input.ipAllowlist;
    if (input.status !== undefined) {
      admin.status = input.status;
      // Disabling must end their live sessions, not just block the next login.
      if (input.status === AdminStatus.DISABLED) admin.tokensInvalidBefore = new Date();
    }

    await admin.save();
    return admin;
  }

  /**
   * Set a new password for an admin, ending every session they hold.
   *
   * Leaving old tokens valid after a credential reset would mean a compromised
   * session survives the very action taken to stop it.
   */
  async resetPassword(adminId: string, password: string): Promise<AdminDocument> {
    const admin = await this.findAny(adminId);
    admin.passwordHash = await this.passwords.hash(password);
    admin.tokensInvalidBefore = new Date();
    await admin.save();
    return admin;
  }

  /**
   * The auditable fields of an admin, before a mutation.
   *
   * The audit diff is computed over these snapshots, so an update records
   * `roles: [moderator] -> [support]` rather than "something changed". Secrets
   * (passwordHash, totpSecret) are deliberately absent — an audit log that
   * quotes a credential is a credential leak with a timestamp.
   */
  async snapshot(adminId: string): Promise<Record<string, unknown>> {
    const admin = await this.findAny(adminId);
    return AdminService.snapshotOf(admin);
  }

  static snapshotOf(admin: AdminDocument): Record<string, unknown> {
    return {
      name: admin.name,
      roles: [...admin.roles],
      status: admin.status,
      ipAllowlist: [...admin.ipAllowlist],
    };
  }

  /** Unlike `findActive`, this returns disabled admins too — they are editable. */
  private async findAny(adminId: string): Promise<AdminDocument> {
    if (!Types.ObjectId.isValid(adminId)) {
      throw new AppException(ErrorCode.ADMIN_NOT_FOUND, 'Admin not found', 404);
    }
    const admin = await this.adminModel.findById(adminId).exec();
    if (!admin) throw new AppException(ErrorCode.ADMIN_NOT_FOUND, 'Admin not found', 404);
    return admin;
  }

  private async assertNotLastSuperAdmin(excludingId: string): Promise<void> {
    const others = await this.adminModel.countDocuments({
      _id: { $ne: new Types.ObjectId(excludingId) },
      roles: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE,
    });
    if (others === 0) {
      throw new AppException(
        ErrorCode.ADMIN_FORBIDDEN,
        'This is the last active super-admin. Promote another account first.',
        409,
      );
    }
  }

  async list(): Promise<AdminDocument[]> {
    return this.adminModel.find().sort({ createdAt: -1 }).limit(200).exec();
  }

  async findActive(adminId: string): Promise<AdminDocument> {
    if (!Types.ObjectId.isValid(adminId)) {
      throw new AppException(ErrorCode.ADMIN_NOT_FOUND, 'Admin not found', 404);
    }
    const admin = await this.adminModel.findById(adminId).exec();
    if (!admin) throw new AppException(ErrorCode.ADMIN_NOT_FOUND, 'Admin not found', 404);
    if (admin.status !== AdminStatus.ACTIVE) {
      throw new AppException(ErrorCode.ADMIN_DISABLED, 'This admin account is disabled', 403);
    }
    return admin;
  }

  assertIpAllowed(admin: AdminDocument, ip: string | null): void {
    if (admin.ipAllowlist.length > 0 && (!ip || !admin.ipAllowlist.includes(ip))) {
      throw new AppException(ErrorCode.ADMIN_IP_NOT_ALLOWED, 'Your IP is not allowed', 403);
    }
  }

  static toView(admin: AdminDocument): AdminView {
    return {
      id: admin._id.toString(),
      email: admin.email,
      name: admin.name,
      roles: admin.roles,
      permissions: permissionsFor(admin.roles),
      status: admin.status,
      totpEnabled: admin.totpEnabled,
      ipAllowlist: admin.ipAllowlist,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    };
  }
}
