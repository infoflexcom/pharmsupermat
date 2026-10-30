import type { ApiContext, Session } from './context';
import type { FeatureFlags } from '../../shared/types';
import type { Permission } from '../../shared/permissions';
import { AppError, validation } from '../core/errors';
import type { HandlerArgs } from './invoke';

import { activateLicense, getLicenseStatus, signLicensePayload, buildLicensePayload } from '../core/license';
import { getAppState, completeSetup, getSetupStatus } from '../services/app';
import { authenticate, changePassword } from '../core/auth';
import { audit, listAudit } from '../core/audit';
import { getAllSettings, updateSettings } from '../core/settings';
import {
  createProduct,
  getProduct,
  listCategories,
  listProducts,
  receiveProductStock,
  setProductActive,
  updateProduct,
  findProductByCode
} from '../services/products';
import { adjustStock, listBatches } from '../services/stock';
import { listInventory, listStockAlerts, stockLedger } from '../services/inventory';
import {
  createSale,
  getSale,
  listSales,
  voidSale,
  approveVoid,
  rejectVoid
} from '../services/sales';
import {
  approveReturn,
  createReturn,
  getReturn,
  listReturns,
  rejectReturn
} from '../services/returns';
import { buildReport } from '../services/reports';
import { getDashboard } from '../services/dashboard';
import {
  createUser,
  listUsers,
  resetUserPassword,
  updateUser
} from '../services/users';
import { createBackup, listBackups, restoreBackup } from '../services/backup';
import { buildCreditNoteDocument, buildSaleDocument } from '../services/documents';
import { createSession, dropSession, refreshSessionPermissions } from './context';
import { verifyVendorPassword } from '../core/license';
import { getStoreProfile } from '../core/settings';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Handler {
  channel: string;
  handler: (args: HandlerArgs) => unknown | Promise<unknown>;
  /** Permission required; checked against the live role/edition mapping. */
  permission?: Permission;
  /** Edition feature flag required (checked in the MAIN process). */
  feature?: 'pharmacy' | 'supermarket' | 'wholesale' | 'prescriptions';
  /** Defaults: auth required, licence required. */
  auth?: boolean;
  license?: boolean;
}

function actor(session: Session) {
  return { userId: session.userId, username: session.username };
}

function salesActor(session: Session) {
  return { userId: session.userId, username: session.username, permissions: session.permissions };
}

function requireSession(args: HandlerArgs): Session {
  if (!args.session) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
  return args.session;
}

function payloadOf<T>(args: HandlerArgs): T {
  if (!args.payload || typeof args.payload !== 'object') {
    throw validation('Missing request details.');
  }
  return args.payload as T;
}

export const HANDLERS: Handler[] = [
  /* ---------------- application state & licensing ---------------- */
  {
    channel: 'app.state',
    auth: false,
    license: false,
    handler: (args) => getAppState(args.ctx, args.license, args.session)
  },
  {
    channel: 'app.health',
    auth: false,
    license: false,
    handler: (args) => ({
      ok: true,
      version: args.ctx.version,
      dataDir: args.ctx.dataDir,
      licensed: args.license.state
    })
  },
  {
    channel: 'license.status',
    auth: false,
    license: false,
    handler: (args) => getLicenseStatus(args.ctx.db, args.ctx.now())
  },
  {
    channel: 'license.verifyMaster',
    auth: false,
    license: false,
    handler: (args) => {
      const { masterPassword } = payloadOf<{ masterPassword: string }>(args);
      const ok = verifyVendorPassword(masterPassword ?? '');
      audit(args.ctx.db, {
        action: ok ? 'license.master.verify.ok' : 'license.master.verify.failed',
        entity: 'license',
        severity: ok ? 'SECURITY' : 'SECURITY',
        username: args.session?.username ?? 'vendor'
      });
      if (!ok) throw new AppError('FORBIDDEN', 'The vendor master password is not correct.');
      return { ok: true };
    }
  },
  {
    channel: 'license.activate',
    auth: false,
    license: false,
    handler: (args) => {
      const payload = payloadOf<{
        masterPassword: string;
        activationCode?: string;
        edition?: 'PHARMACY' | 'SUPERMARKET' | 'BOTH';
        customerName?: string;
        expiresAt?: string;
        note?: string;
      }>(args);
      const before = getLicenseStatus(args.ctx.db);
      const status = activateLicense(args.ctx.db, {
        ...payload,
        activatedBy: args.session?.username ?? 'vendor'
      });
      refreshSessionPermissions(args.ctx, status);
      audit(args.ctx.db, {
        action: before.state === 'NONE' ? 'license.activate' : 'license.renew',
        entity: 'license',
        entityId: status.customerName,
        username: args.session?.username ?? 'vendor',
        severity: 'SECURITY',
        details: {
          edition: status.edition,
          customerName: status.customerName,
          expiresAt: status.expiresAt,
          mode: payload.activationCode ? 'activation-code' : 'vendor-issue'
        }
      });
      return status;
    }
  },
  {
    channel: 'license.issueCode',
    auth: false,
    license: false,
    handler: (args) => {
      const payload = payloadOf<{
        masterPassword: string;
        edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH';
        customerName: string;
        expiresAt: string;
        note?: string;
      }>(args);
      const licence = buildLicensePayload({
        edition: payload.edition,
        customerName: payload.customerName,
        expiresAt: payload.expiresAt,
        note: payload.note
      });
      const code = signLicensePayload(licence, payload.masterPassword);
      audit(args.ctx.db, {
        action: 'license.code.issue',
        entity: 'license',
        entityId: payload.customerName,
        username: 'vendor',
        severity: 'SECURITY',
        details: { edition: payload.edition, expiresAt: payload.expiresAt }
      });
      return { code, payload: licence };
    }
  },

  /* ---------------- first run setup ---------------- */
  {
    channel: 'setup.status',
    auth: false,
    handler: (args) => getSetupStatus(args.ctx.db, args.license)
  },
  {
    channel: 'setup.complete',
    auth: false,
    handler: (args) => {
      const payload = payloadOf<{
        storeName: string;
        storeAddress: string;
        storePhone: string;
        receiptFooter?: string;
        adminUsername: string;
        adminFullName: string;
        adminPassword: string;
      }>(args);
      return completeSetup(args.ctx.db, payload, args.license);
    }
  },

  /* ---------------- authentication ---------------- */
  {
    channel: 'auth.login',
    auth: false,
    handler: (args) => {
      const { username, password } = payloadOf<{ username: string; password: string }>(args);
      if (!username || !password) throw validation('Enter your username and password.');
      const { account } = authenticate(args.ctx.db, username, password);
      const edition = args.license.edition;
      if (!edition) throw new AppError('LICENSE_REQUIRED', 'Activate your licence first.');
      const session = createSession(
        args.ctx,
        {
          id: account.id,
          username: account.username,
          fullName: account.fullName,
          role: account.role,
          mustChangePassword: account.mustChangePassword
        },
        edition
      );
      audit(args.ctx.db, {
        action: 'auth.login',
        entity: 'user',
        entityId: account.id,
        userId: account.id,
        username: account.username,
        severity: 'SECURITY'
      });
      return {
        token: session.token,
        userId: session.userId,
        username: session.username,
        fullName: session.fullName,
        role: session.role,
        permissions: session.permissions,
        mustChangePassword: session.mustChangePassword,
        storeName: getStoreProfile(args.ctx.db).storeName
      };
    }
  },
  {
    channel: 'auth.logout',
    auth: false,
    handler: (args) => {
      if (args.session) {
        audit(args.ctx.db, {
          action: 'auth.logout',
          entity: 'user',
          entityId: args.session.userId,
          userId: args.session.userId,
          username: args.session.username
        });
        dropSession(args.ctx, args.session.token);
      }
      return { ok: true };
    }
  },
  {
    channel: 'auth.me',
    handler: (args) => {
      const session = requireSession(args);
      return {
        token: session.token,
        userId: session.userId,
        username: session.username,
        fullName: session.fullName,
        role: session.role,
        permissions: session.permissions,
        mustChangePassword: session.mustChangePassword,
        storeName: getStoreProfile(args.ctx.db).storeName
      };
    }
  },
  {
    channel: 'auth.changePassword',
    handler: (args) => {
      const session = requireSession(args);
      const { currentPassword, newPassword } = payloadOf<{
        currentPassword?: string;
        newPassword: string;
      }>(args);
      changePassword(
        args.ctx.db,
        session.userId,
        session.mustChangePassword ? null : (currentPassword ?? ''),
        newPassword
      );
      session.mustChangePassword = false;
      audit(args.ctx.db, {
        action: 'auth.password.change',
        entity: 'user',
        entityId: session.userId,
        userId: session.userId,
        username: session.username,
        severity: 'SECURITY'
      });
      return { ok: true };
    }
  },

  /* ---------------- settings ---------------- */
  {
    channel: 'settings.read',
    handler: (args) => getAllSettings(args.ctx.db)
  },
  {
    channel: 'settings.update',
    permission: 'settings.manage',
    handler: (args) => {
      const session = requireSession(args);
      const patch = payloadOf<Record<string, unknown>>(args);
      const updated = updateSettings(args.ctx.db, patch as never);
      audit(args.ctx.db, {
        action: 'settings.update',
        entity: 'settings',
        userId: session.userId,
        username: session.username,
        severity: 'SECURITY',
        details: patch
      });
      return updated;
    }
  },
  {
    channel: 'audit.list',
    permission: 'audit.view',
    handler: (args) =>
      listAudit(args.ctx.db, payloadOf<{ from?: string; to?: string; limit?: number; search?: string }>(args))
  },

  /* ---------------- products ---------------- */
  {
    channel: 'products.list',
    permission: 'products.view',
    handler: (args) =>
      listProducts(args.ctx.db, payloadOf<{ search?: string; includeInactive?: boolean; lowStock?: boolean }>(args) ?? {})
  },
  {
    channel: 'products.get',
    permission: 'products.view',
    handler: (args) => getProduct(args.ctx.db, payloadOf<{ id: number }>(args).id)
  },
  {
    channel: 'products.lookup',
    permission: 'products.view',
    handler: (args) => findProductByCode(args.ctx.db, payloadOf<{ code: string }>(args).code ?? '')
  },
  {
    channel: 'products.categories',
    permission: 'products.view',
    handler: (args) => listCategories(args.ctx.db)
  },
  {
    channel: 'products.create',
    permission: 'products.manage',
    handler: (args) => {
      const session = requireSession(args);
      const input = payloadOf<Parameters<typeof createProduct>[1]>(args);
      return createProduct(
        args.ctx.db,
        {
          ...input,
          rxRequired: args.features.prescriptions ? input.rxRequired : false,
          openingExpiry: args.features.pharmacy ? input.openingExpiry : null
        },
        actor(session)
      );
    }
  },
  {
    channel: 'products.update',
    permission: 'products.manage',
    handler: (args) => {
      const session = requireSession(args);
      const input = payloadOf<Parameters<typeof updateProduct>[1]>(args);
      return updateProduct(
        args.ctx.db,
        { ...input, rxRequired: args.features.prescriptions ? input.rxRequired : false },
        actor(session)
      );
    }
  },
  {
    channel: 'products.setActive',
    permission: 'products.manage',
    handler: (args) => {
      const session = requireSession(args);
      const { id, active } = payloadOf<{ id: number; active: boolean }>(args);
      return setProductActive(args.ctx.db, id, active, actor(session));
    }
  },

  /* ---------------- stock ---------------- */
  {
    channel: 'stock.batches',
    permission: 'products.view',
    handler: (args) => listBatches(args.ctx.db, payloadOf<{ productId: number }>(args).productId)
  },
  {
    channel: 'stock.receive',
    permission: 'stock.receive',
    handler: (args) => {
      const session = requireSession(args);
      const input = payloadOf<Parameters<typeof receiveProductStock>[1]>(args);
      return receiveProductStock(
        args.ctx.db,
        {
          ...input,
          batchNo: args.features.pharmacy ? input.batchNo : undefined,
          expiryDate: args.features.pharmacy ? input.expiryDate : null
        },
        actor(session)
      );
    }
  },
  {
    channel: 'stock.adjust',
    permission: 'stock.adjust',
    handler: (args) => {
      const session = requireSession(args);
      const input = payloadOf<{ productId: number; batchId?: number; newQty: number; reason: string }>(
        args
      );
      return args.ctx.db.transaction(() => {
        adjustStock(args.ctx.db, input, actor(session));
        audit(args.ctx.db, {
          action: 'stock.adjust',
          entity: 'product',
          entityId: input.productId,
          userId: session.userId,
          username: session.username,
          severity: 'WARN',
          details: input
        });
        return listBatches(args.ctx.db, input.productId);
      });
    }
  },
  {
    channel: 'stock.alerts',
    permission: 'products.view',
    handler: (args) =>
      listStockAlerts(args.ctx.db, args.features.pharmacy ? 90 : 0)
  },
  {
    channel: 'stock.ledger',
    permission: 'products.view',
    handler: (args) => {
      const { productId, limit } = payloadOf<{ productId: number; limit?: number }>(args);
      return stockLedger(args.ctx.db, productId, limit);
    }
  },
  {
    // Pharmacy-only module: batches and expiry. Blocked in the MAIN process for
    // supermarket licences, independent of what the renderer shows.
    channel: 'inventory.expiryWatch',
    permission: 'products.view',
    feature: 'pharmacy',
    handler: (args) => listStockAlerts(args.ctx.db, 90)
  },
  {
    channel: 'prescriptions.log',
    permission: 'prescriptions.manage',
    feature: 'prescriptions',
    handler: (args) => {
      const { from, to } = (args.payload ?? {}) as { from?: string; to?: string };
      return listSales(args.ctx.db, {
        from,
        to,
        limit: 300,
        search: undefined
      });
    }
  },
  {
    channel: 'inventory.list',
    permission: 'products.view',
    handler: (args) => listInventory(args.ctx.db, payloadOf<{ search?: string }>(args)?.search)
  },

  /* ---------------- sales ---------------- */
  {
    channel: 'sales.create',
    permission: 'pos.sell',
    handler: (args) => {
      const session = requireSession(args);
      return createSale(
        args.ctx.db,
        payloadOf<Parameters<typeof createSale>[1]>(args),
        salesActor(session),
        args.features
      );
    }
  },
  {
    channel: 'sales.list',
    handler: (args) => {
      const session = requireSession(args);
      const payload = (args.payload ?? {}) as {
        from?: string;
        to?: string;
        search?: string;
        status?: 'COMPLETED' | 'VOIDED';
        docType?: 'RECEIPT' | 'INVOICE';
        pendingVoids?: boolean;
      };
      const canSeeAll = session.permissions.includes('sales.view.all');
      return listSales(args.ctx.db, {
        ...payload,
        userId: canSeeAll ? (payload as { userId?: number }).userId : session.userId
      });
    }
  },
  {
    channel: 'sales.get',
    handler: (args) => {
      const session = requireSession(args);
      const sale = getSale(args.ctx.db, payloadOf<{ id: number }>(args).id);
      if (sale.userId !== session.userId && !session.permissions.includes('sales.view.all')) {
        throw new AppError('FORBIDDEN', 'You can only view your own sales.');
      }
      return sale;
    }
  },
  {
    channel: 'sales.void',
    permission: 'sales.void.request',
    handler: (args) => {
      const session = requireSession(args);
      const { id, reason } = payloadOf<{ id: number; reason: string }>(args);
      return voidSale(args.ctx.db, id, reason, salesActor(session));
    }
  },
  {
    channel: 'sales.approveVoid',
    permission: 'sales.void.approve',
    handler: (args) => {
      const session = requireSession(args);
      return approveVoid(args.ctx.db, payloadOf<{ id: number }>(args).id, salesActor(session));
    }
  },
  {
    channel: 'sales.rejectVoid',
    permission: 'sales.void.approve',
    handler: (args) => {
      const session = requireSession(args);
      return rejectVoid(args.ctx.db, payloadOf<{ id: number }>(args).id, salesActor(session));
    }
  },
  {
    channel: 'sales.document',
    handler: (args) => {
      const session = requireSession(args);
      const sale = getSale(args.ctx.db, payloadOf<{ id: number }>(args).id);
      if (sale.userId !== session.userId && !session.permissions.includes('sales.view.all')) {
        throw new AppError('FORBIDDEN', 'You can only print your own sales.');
      }
      const html = buildSaleDocument(sale, getStoreProfile(args.ctx.db), args.features.productName);
      return { html, sale };
    }
  },

  /* ---------------- returns ---------------- */
  {
    channel: 'returns.create',
    permission: 'returns.create',
    handler: (args) => {
      const session = requireSession(args);
      return createReturn(
        args.ctx.db,
        payloadOf<Parameters<typeof createReturn>[1]>(args),
        salesActor(session),
        getStoreProfile(args.ctx.db)
      );
    }
  },
  {
    channel: 'returns.list',
    handler: (args) => {
      const session = requireSession(args);
      const payload = payloadOf<{ from?: string; to?: string; status?: 'PENDING' | 'COMPLETED' | 'REJECTED' }>(
        args
      );
      if (!session.permissions.includes('reports.view.all')) {
        return listReturns(args.ctx.db, payload).filter(
          (r) => r.requestedBy === session.userId || r.approvedBy === session.userId
        );
      }
      return listReturns(args.ctx.db, payload);
    }
  },
  {
    channel: 'returns.get',
    handler: (args) => {
      requireSession(args);
      return getReturn(args.ctx.db, payloadOf<{ id: number }>(args).id);
    }
  },
  {
    channel: 'returns.approve',
    permission: 'returns.approve',
    handler: (args) => {
      const session = requireSession(args);
      return approveReturn(args.ctx.db, payloadOf<{ id: number }>(args).id, salesActor(session));
    }
  },
  {
    channel: 'returns.reject',
    permission: 'returns.approve',
    handler: (args) => {
      const session = requireSession(args);
      const { id, reason } = payloadOf<{ id: number; reason: string }>(args);
      return rejectReturn(args.ctx.db, id, reason, salesActor(session));
    }
  },
  {
    channel: 'returns.document',
    handler: (args) => {
      requireSession(args);
      const ret = getReturn(args.ctx.db, payloadOf<{ id: number }>(args).id);
      const html = buildCreditNoteDocument(ret, getStoreProfile(args.ctx.db), args.features.productName);
      return { html, creditNote: ret };
    }
  },

  /* ---------------- reports & dashboard ---------------- */
  {
    channel: 'dashboard.get',
    handler: (args) => {
      const session = requireSession(args);
      const canSeeAll = session.permissions.includes('reports.view.all');
      return getDashboard(args.ctx.db, {
        scopeUserId: canSeeAll ? undefined : session.userId,
        expiryWindowDays: args.features.pharmacy ? 90 : 0
      });
    }
  },
  {
    channel: 'reports.build',
    permission: 'reports.view.own',
    handler: (args) => {
      const session = requireSession(args);
      const request = payloadOf<{ kind: Parameters<typeof buildReport>[1]['kind']; from?: string; to?: string; limit?: number }>(args);
      const canSeeAll = session.permissions.includes('reports.view.all');
      if (request.kind === 'AUDIT' && !session.permissions.includes('audit.view')) {
        throw new AppError('FORBIDDEN', 'You cannot view the audit trail.');
      }
      const today = new Date().toISOString().slice(0, 10);
      return buildReport(
        {
          db: args.ctx.db,
          store: getStoreProfile(args.ctx.db),
          productName: args.features.productName,
          scopeUserId: canSeeAll ? undefined : session.userId
        },
        {
          ...request,
          from: canSeeAll ? request.from : today,
          to: canSeeAll ? request.to : today
        }
      );
    }
  },

  /* ---------------- users ---------------- */
  {
    channel: 'users.list',
    permission: 'users.manage',
    handler: (args) => listUsers(args.ctx.db)
  },
  {
    channel: 'users.create',
    permission: 'users.manage',
    handler: (args) => {
      const session = requireSession(args);
      if (!args.license.edition) throw new AppError('LICENSE_REQUIRED', 'Licence required.');
      return createUser(
        args.ctx.db,
        payloadOf<Parameters<typeof createUser>[1]>(args),
        actor(session),
        args.license.edition
      );
    }
  },
  {
    channel: 'users.update',
    permission: 'users.manage',
    handler: (args) => {
      const session = requireSession(args);
      if (!args.license.edition) throw new AppError('LICENSE_REQUIRED', 'Licence required.');
      return updateUser(
        args.ctx.db,
        payloadOf<Parameters<typeof updateUser>[1]>(args),
        actor(session),
        args.license.edition
      );
    }
  },
  {
    channel: 'users.resetPassword',
    permission: 'users.manage',
    handler: (args) => {
      const session = requireSession(args);
      resetUserPassword(args.ctx.db, payloadOf<{ id: number; newPassword: string }>(args), actor(session));
      return { ok: true };
    }
  },

  /* ---------------- backup & documents ---------------- */
  {
    channel: 'backup.create',
    permission: 'backup.manage',
    handler: (args) => {
      const session = requireSession(args);
      const info = createBackup(args.ctx.db, args.ctx.backupsDir, payloadOf<{ label?: string }>(args)?.label);
      audit(args.ctx.db, {
        action: 'backup.create',
        entity: 'backup',
        entityId: info.name,
        userId: session.userId,
        username: session.username,
        severity: 'SECURITY'
      });
      return info;
    }
  },
  {
    channel: 'backup.list',
    permission: 'backup.manage',
    handler: (args) => listBackups(args.ctx.backupsDir)
  },
  {
    channel: 'backup.restore',
    permission: 'backup.manage',
    handler: (args) => {
      const session = requireSession(args);
      const { path } = payloadOf<{ path: string }>(args);
      const result = restoreBackup(args.ctx.db, args.ctx.backupsDir, path);
      audit(args.ctx.db, {
        action: 'backup.restore',
        entity: 'backup',
        entityId: path,
        userId: session.userId,
        username: session.username,
        severity: 'SECURITY',
        details: result
      });
      // Sessions are invalidated: the restored file has its own users.
      args.ctx.sessions.clear();
      return result;
    }
  },
  {
    channel: 'documents.saveHtml',
    handler: (args) => {
      requireSession(args);
      const { html, filename } = payloadOf<{ html: string; filename: string }>(args);
      if (!html || !filename) throw validation('Nothing to save.');
      const exportsDir = join(args.ctx.dataDir, 'exports');
      mkdirSync(exportsDir, { recursive: true });
      const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      const path = join(exportsDir, safe.endsWith('.html') ? safe : `${safe}.html`);
      writeFileSync(path, html, 'utf8');
      audit(args.ctx.db, {
        action: 'document.save',
        entity: 'document',
        entityId: safe,
        userId: args.session?.userId ?? null,
        username: args.session?.username ?? null
      });
      return { path };
    }
  },
  {
    channel: 'print.document',
    handler: async (args) => {
      const session = requireSession(args);
      const { html, title } = payloadOf<{ html: string; title?: string }>(args);
      if (!args.ctx.print) {
        throw new AppError(
          'INTERNAL',
          'Printing is only available inside the desktop app. Use "Save" to export the document instead.'
        );
      }
      const result = await args.ctx.print({ html, title: title ?? 'Infoflex document' });
      audit(args.ctx.db, {
        action: 'document.print',
        entity: 'document',
        entityId: title ?? null,
        userId: session.userId,
        username: session.username
      });
      return result;
    }
  }
];

/** Channels that stay available while a forced password change is pending. */
export const PASSWORD_CHANGE_ALLOWLIST = new Set([
  'app.state',
  'auth.me',
  'auth.logout',
  'auth.changePassword'
]);

export const HANDLER_MAP = new Map(HANDLERS.map((h) => [h.channel, h]));

export const FEATURE_FLAGS: Array<keyof FeatureFlags> = [
  'pharmacy',
  'supermarket',
  'wholesale',
  'prescriptions'
];

export function describeHandlers(): { channel: string; permission?: string; feature?: string }[] {
  return HANDLERS.map((h) => ({ channel: h.channel, permission: h.permission, feature: h.feature }));
}

export type { ApiContext };
