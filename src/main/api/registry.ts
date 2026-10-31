import type { ApiContext } from '../../services/session';
import type { FeatureFlags, ReportRequest } from '../../shared/types';
import type { Permission } from '../../shared/permissions';
import { AppError, notFound, validation } from '../../shared/errors';
import type { HandlerArgs } from './invoke';
import { actor, payloadOf, requireSession, salesActor } from './args';
import { EDITION_MODULES, editionHandlers } from '../../editions';

import {
  activateLicense,
  buildLicensePayload,
  checkMasterPassword,
  getLicenseHistory,
  getLicenseStatus,
  signLicensePayload,
  unlockLicense
} from '../../license/license';
import { getAppState, completeSetup, getSetupStatus } from '../../services/app';
import { authenticate, changePassword } from '../../services/auth';
import { audit, listAudit } from '../../services/audit';
import { getAllSettings, updateSettings } from '../../services/settings';
import { previewReceipt } from '../../services/receiptPreview';
import type { CompleteSetupInput, ProductInput, SettingsPayload } from '../../shared/types';
import {
  createProduct,
  getProduct,
  listCategories,
  listProducts,
  receiveProductStock,
  setProductActive,
  updateProduct,
  findProductByCode,
  scanProduct
} from '../../services/products';
import { exportProducts, exportProductsXlsx, exportTemplate, importProducts } from '../../services/imports';
import { buildPriceLabels } from '../../services/labels';
import {
  createStockCount,
  getStockCount,
  listStockCounts,
  postStockCount,
  saveStockCountEntries
} from '../../services/stocktake';
import { adjustStock, listBatches } from '../../services/stock';
import { listInventory, listStockAlerts, stockLedger } from '../../services/inventory';
import {
  createSale,
  getSale,
  listSales,
  voidSale,
  approveVoid,
  rejectVoid
} from '../../services/sales';
import {
  approveWithPin,
  type ApprovalInput
} from '../../services/approvals';
import { priceCart } from '../../services/pricing';
import {
  cancelHeldSale,
  customerBalanceSummary,
  displayState,
  getHeldSale,
  getPosConfig,
  holdSale,
  listCreditBalances,
  listCreditInvoices,
  listDocumentPrints,
  listHeldSales,
  printSaleDocument,
  recordCreditPayment,
  type HoldInput
} from '../../services/pos';
import {
  approveReturn,
  createReturn,
  getReturn,
  getWriteoff,
  listReturns,
  listWriteoffs,
  lookupSaleForReturn,
  printReturnDocument,
  rejectReturn
} from '../../services/returns';
import { assertReportAllowed, buildReport, REPORT_CATALOGUE } from '../../services/reports';
import { reportFileName, reportToCsv, reportToExcel } from '../../services/reportExport';
import { dailySummary, monthlySummary } from '../../services/accounting';
import {
  listCategoryRecords,
  listCustomerRecords,
  listSupplierRecords,
  saveCategory,
  saveCustomer,
  saveSupplier,
  type CategoryInput,
  type CustomerInput,
  type SupplierInput
} from '../../services/directory';
import {
  cancelPurchaseOrder,
  createPurchase,
  createPurchaseOrder,
  getPurchase,
  listPurchases,
  receivePurchaseOrder,
  type PurchaseInput,
  type PurchaseOrderInput
} from '../../services/purchases';
import { closeDay, computeDayTotals, dayReconciliation, listDayClosings } from '../../services/operations';
import { getDashboard } from '../../services/dashboard';
import {
  createUser,
  listUsers,
  resetUserPassword,
  unlockUser,
  updateUser
} from '../../services/users';
import {
  backupStatus,
  copyBackupTo,
  createBackup,
  listBackups,
  listBackupsIn,
  restoreBackup
} from '../../services/backup';
import { toUserAccount } from '../../services/auth';
import { buildCreditNoteDocument, buildSaleDocument } from '../../services/documents';
import { createSession, dropSession, refreshSessionPermissions } from '../../services/session';
import { getStoreProfile } from '../../services/settings';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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

/**
 * Drops fields that belong to a module the licence does not include, so a
 * supermarket install cannot store pharmacy columns (and vice versa) even if a
 * renderer sends them.
 */
function editionSafeProduct(input: ProductInput, features: FeatureFlags): ProductInput {
  return {
    ...input,
    rxRequired: features.prescriptions ? input.rxRequired : false,
    genericName: features.pharmacy ? input.genericName : null,
    departmentId: features.supermarket ? input.departmentId : null,
    shelfLocation: features.supermarket ? input.shelfLocation : null,
    pluCode: features.supermarket ? input.pluCode : null,
    pricePerKg: features.supermarket ? input.pricePerKg : null,
    isWeighed: features.supermarket ? input.isWeighed : false,
    expiryTracking: features.pharmacy ? true : features.supermarket ? input.expiryTracking : false,
    openingExpiry: features.pharmacy || features.supermarket ? input.openingExpiry : null
  };
}

/**
 * Builds a report with the caller's own scope: a cashier sees only their own
 * sales for today (the same rule as the till), supervisors and administrators
 * see the shop. Cost and profit are selected only for an administrator.
 */
function buildReportForSession(args: HandlerArgs, request: ReportRequest) {
  const session = requireSession(args);
  const entry = assertReportAllowed(request.kind, args.features);
  if (entry.permission === 'audit.view' && !session.permissions.includes('audit.view')) {
    throw new AppError('FORBIDDEN', 'You cannot view the audit trail.');
  }
  if (entry.permission === 'reports.view.all' && !session.permissions.includes('reports.view.all')) {
    throw new AppError('FORBIDDEN', 'This report is for supervisors and administrators.');
  }
  const canSeeAll = session.permissions.includes('reports.view.all');
  const today = new Date().toISOString().slice(0, 10);
  return buildReport(
    {
      db: args.ctx.db,
      store: getStoreProfile(args.ctx.db),
      productName: args.features.productName,
      includeProfit: session.role === 'ADMIN',
      features: args.features,
      ...(canSeeAll ? {} : { scopeUserId: session.userId })
    },
    canSeeAll ? request : { ...request, from: today, to: today }
  );
}

export const CORE_HANDLERS: Handler[] = [
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
      return checkMasterPassword(args.ctx.db, masterPassword ?? '', args.ctx.now());
    }
  },
  {
    channel: 'license.unlock',
    auth: false,
    license: false,
    handler: (args) => {
      const { masterPassword } = payloadOf<{ masterPassword: string }>(args);
      const status = unlockLicense(
        args.ctx.db,
        masterPassword ?? '',
        args.session?.username ?? 'vendor',
        args.ctx.now()
      );
      refreshSessionPermissions(args.ctx, status);
      return status;
    }
  },
  {
    channel: 'license.history',
    license: false,
    permission: 'license.manage',
    handler: (args) => getLicenseHistory(args.ctx.db, 50)
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
        startsOn?: string;
        endsOn?: string;
        customerName?: string;
        expiresAt?: string;
        note?: string;
      }>(args);
      const status = activateLicense(
        args.ctx.db,
        { ...payload, activatedBy: args.session?.username ?? 'vendor' },
        args.ctx.now()
      );
      refreshSessionPermissions(args.ctx, status);
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
      const payload = payloadOf<CompleteSetupInput>(args);
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
    // Renders a sample receipt with the *unsaved* draft, so the administrator
    // sees the store name, footer and VAT on the paper before saving. No write.
    channel: 'settings.preview',
    permission: 'settings.manage',
    handler: (args) => {
      const { draft } = payloadOf<{ draft?: Partial<SettingsPayload> }>(args) ?? {};
      return previewReceipt(args.ctx.db, args.features.productName, draft ?? {});
    }
  },
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
        // Only which settings changed: a logo data URL or a long footer would
        // bloat the audit table, and its values are visible in Settings anyway.
        details: {
          changed: Object.keys(patch).sort(),
          storeName: updated.storeName
        }
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
    // A scan that also understands the shop's scale barcodes: the product plus
    // the grams the scale weighed, in one round trip.
    channel: 'products.scan',
    permission: 'products.view',
    handler: (args) => scanProduct(args.ctx.db, payloadOf<{ code: string }>(args).code ?? '')
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
      return createProduct(args.ctx.db, editionSafeProduct(input, args.features), actor(session));
    }
  },
  {
    channel: 'products.update',
    permission: 'products.manage',
    handler: (args) => {
      const session = requireSession(args);
      const input = payloadOf<Parameters<typeof updateProduct>[1]>(args);
      return updateProduct(args.ctx.db, editionSafeProduct(input, args.features), actor(session));
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

  {
    channel: 'products.import',
    permission: 'products.manage',
    handler: async (args) => {
      const session = requireSession(args);
      const input = payloadOf<{
        filename: string;
        data: string;
        encoding: 'base64' | 'utf8';
        mode: 'DRY_RUN' | 'IMPORT';
      }>(args);
      return importProducts(
        args.ctx.db,
        { filename: input.filename, data: input.data, encoding: input.encoding },
        {
          mode: input.mode === 'IMPORT' ? 'IMPORT' : 'DRY_RUN',
          features: { pharmacy: args.features.pharmacy, supermarket: args.features.supermarket }
        },
        actor(session)
      );
    }
  },
  {
    channel: 'products.exportTemplate',
    permission: 'products.manage',
    handler: (args) =>
      exportTemplate({ pharmacy: args.features.pharmacy, supermarket: args.features.supermarket })
  },
  {
    channel: 'products.export',
    permission: 'products.manage',
    handler: async (args) => {
      const { format } = (payloadOf<{ format?: 'CSV' | 'XLSX' }>(args) ?? {}) as { format?: 'CSV' | 'XLSX' };
      return format === 'XLSX' ? exportProductsXlsx(args.ctx.db) : exportProducts(args.ctx.db);
    }
  },
  {
    // Bulk price labels are a supermarket workflow; printing them never changes data.
    channel: 'labels.print',
    permission: 'products.view',
    feature: 'supermarket',
    handler: (args) => {
      const session = requireSession(args);
      return buildPriceLabels(
        args.ctx.db,
        payloadOf<Parameters<typeof buildPriceLabels>[1]>(args) ?? {},
        actor(session),
        (() => {
          const store = getStoreProfile(args.ctx.db);
          return { name: store.storeName, address: store.storeAddress, phone: store.storePhone };
        })()
      );
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
    // Only an administrator holds stock.adjust; the service records the reason
    // in the ledger and the audit trail in the same transaction.
    channel: 'stock.adjust',
    permission: 'stock.adjust',
    handler: (args) => {
      const session = requireSession(args);
      const input = payloadOf<Parameters<typeof adjustStock>[1]>(args);
      const result = adjustStock(args.ctx.db, input, actor(session));
      return { ...result, batches: listBatches(args.ctx.db, input.productId) };
    }
  },
  {
    // Stocktake (count sheet + variance report) is a supermarket workflow.
    channel: 'stocktake.list',
    permission: 'stock.adjust',
    feature: 'supermarket',
    handler: (args) => listStockCounts(args.ctx.db, payloadOf<{ limit?: number }>(args)?.limit ?? 40)
  },
  {
    channel: 'stocktake.get',
    permission: 'stock.adjust',
    feature: 'supermarket',
    handler: (args) => getStockCount(args.ctx.db, payloadOf<{ id: number }>(args).id)
  },
  {
    channel: 'stocktake.create',
    permission: 'stock.adjust',
    feature: 'supermarket',
    handler: (args) =>
      createStockCount(
        args.ctx.db,
        payloadOf<{ note?: string; scope?: string }>(args) ?? {},
        actor(requireSession(args))
      )
  },
  {
    channel: 'stocktake.save',
    permission: 'stock.adjust',
    feature: 'supermarket',
    handler: (args) =>
      saveStockCountEntries(
        args.ctx.db,
        payloadOf<{ countId: number; entries: Array<{ itemId: number; countedQty: number | null }> }>(args),
        actor(requireSession(args))
      )
  },
  {
    channel: 'stocktake.post',
    permission: 'stock.adjust',
    feature: 'supermarket',
    handler: (args) =>
      postStockCount(args.ctx.db, payloadOf<{ countId: number }>(args), actor(requireSession(args)))
  },
  {
    channel: 'stock.alerts',
    permission: 'products.view',
    handler: (args) => {
      // Pharmacy tracks every batch; the supermarket only alerts on perishables
      // that opted into expiry tracking. The window comes from settings.
      const days = getAllSettings(args.ctx.db).expiryAlertDays;
      return listStockAlerts(args.ctx.db, days, { trackedOnly: !args.features.pharmacy });
    }
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
    handler: (args) => listStockAlerts(args.ctx.db, getAllSettings(args.ctx.db).expiryAlertDays)
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

  /* ---------------- directory (categories / suppliers / customers) ---------------- */
  {
    channel: 'directory.categories.list',
    permission: 'products.view',
    handler: (args) => listCategoryRecords(args.ctx.db)
  },
  {
    channel: 'directory.categories.save',
    permission: 'products.manage',
    handler: (args) => saveCategory(args.ctx.db, payloadOf<CategoryInput>(args), actor(requireSession(args)))
  },
  {
    channel: 'directory.suppliers.list',
    permission: 'products.view',
    handler: (args) => listSupplierRecords(args.ctx.db, payloadOf<{ search?: string }>(args)?.search)
  },
  {
    channel: 'directory.suppliers.save',
    permission: 'products.manage',
    handler: (args) => saveSupplier(args.ctx.db, payloadOf<SupplierInput>(args), actor(requireSession(args)))
  },
  {
    channel: 'directory.customers.list',
    permission: 'pos.sell',
    handler: (args) => listCustomerRecords(args.ctx.db, payloadOf<{ search?: string }>(args)?.search)
  },
  {
    channel: 'directory.customers.save',
    permission: 'products.manage',
    handler: (args) => saveCustomer(args.ctx.db, payloadOf<CustomerInput>(args), actor(requireSession(args)))
  },

  /* ---------------- purchases ---------------- */
  {
    channel: 'purchases.list',
    permission: 'products.view',
    handler: (args) =>
      listPurchases(args.ctx.db, payloadOf<{ from?: string; to?: string; supplierId?: number; limit?: number }>(args) ?? {})
  },
  {
    channel: 'purchases.get',
    permission: 'products.view',
    handler: (args) => getPurchase(args.ctx.db, payloadOf<{ id: number }>(args).id)
  },
  {
    channel: 'purchases.create',
    permission: 'stock.receive',
    handler: (args) => {
      const input = payloadOf<PurchaseInput>(args);
      // Batch/expiry only exist in the pharmacy module; a supermarket purchase
      // simply lands in the product's PRIMARY batch.
      const items = (input.items ?? []).map((item) => ({
        ...item,
        batchNo: args.features.pharmacy ? item.batchNo : undefined,
        expiryDate: args.features.pharmacy ? item.expiryDate : null
      }));
      return createPurchase(args.ctx.db, { ...input, items }, actor(requireSession(args)));
    }
  },
  {
    // Supplier purchase orders and goods-received notes (supermarket module).
    // Ordering fixes the buying prices, so it stays with the administrator;
    // receiving what was ordered only needs stock.receive.
    channel: 'purchases.createOrder',
    permission: 'prices.set',
    feature: 'supermarket',
    handler: (args) => {
      const input = payloadOf<PurchaseOrderInput>(args);
      const items = (input.items ?? []).map((item) => ({
        ...item,
        batchNo: args.features.pharmacy ? item.batchNo : undefined,
        expiryDate: args.features.pharmacy ? item.expiryDate : null
      }));
      return createPurchaseOrder(args.ctx.db, { ...input, items }, actor(requireSession(args)));
    }
  },
  {
    channel: 'purchases.receiveOrder',
    permission: 'stock.receive',
    feature: 'supermarket',
    handler: (args) =>
      receivePurchaseOrder(
        args.ctx.db,
        payloadOf<{ id: number; invoiceNo?: string; purchaseDate?: string; note?: string }>(args),
        actor(requireSession(args))
      )
  },
  {
    channel: 'purchases.cancelOrder',
    permission: 'stock.receive',
    feature: 'supermarket',
    handler: (args) =>
      cancelPurchaseOrder(args.ctx.db, payloadOf<{ id: number }>(args).id, actor(requireSession(args)))
  },

  /* ---------------- day closing ---------------- */
  {
    channel: 'operations.day.totals',
    permission: 'reports.view.all',
    handler: (args) => {
      const { businessDate, openingFloat } = payloadOf<{ businessDate?: string; openingFloat?: number }>(args) ?? {};
      const date = businessDate?.trim() || new Date().toISOString().slice(0, 10);
      return computeDayTotals(args.ctx.db, date, openingFloat ?? 0);
    }
  },
  {
    channel: 'operations.day.list',
    permission: 'reports.view.all',
    handler: (args) => listDayClosings(args.ctx.db, payloadOf<{ limit?: number }>(args)?.limit ?? 60)
  },
  {
    channel: 'operations.day.reconcile',
    permission: 'reports.view.all',
    handler: (args) => {
      const payload = payloadOf<{ businessDate?: string; openingFloat?: number }>(args) ?? {};
      const date = payload.businessDate?.trim() || new Date().toISOString().slice(0, 10);
      return dayReconciliation(args.ctx.db, date, {
        // Omit it when the caller did not type one: the saved day's own float
        // is then used, so a reopened day reconciles exactly as it was closed.
        ...(payload.openingFloat !== undefined ? { openingFloat: payload.openingFloat } : {}),
        includeShifts: args.features.supermarket
      });
    }
  },
  {
    channel: 'operations.day.close',
    permission: 'reports.view.all',
    handler: (args) =>
      closeDay(
        args.ctx.db,
        payloadOf<{ businessDate: string; openingFloat?: number; countedCash: number; note?: string }>(args),
        actor(requireSession(args))
      )
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
    // Prefer pos.print (it records the print and the DUPLICATE rule); this
    // older channel renders the same document without touching the trail.
    handler: (args) => {
      const session = requireSession(args);
      const sale = getSale(args.ctx.db, payloadOf<{ id: number }>(args).id);
      if (sale.userId !== session.userId && !session.permissions.includes('sales.view.all')) {
        throw new AppError('FORBIDDEN', 'You can only print your own sales.');
      }
      const settings = getAllSettings(args.ctx.db);
      const html = buildSaleDocument(sale, getStoreProfile(args.ctx.db), args.features.productName, {
        layout: sale.docType === 'INVOICE' ? 'A4_INVOICE' : settings.receiptLayout,
        poweredBy: settings.poweredByFooter
      });
      return { html, sale };
    }
  },

  /* ---------------- till (phase 6) ---------------- */
  {
    channel: 'pos.config',
    permission: 'pos.sell',
    handler: (args) => getPosConfig(args.ctx.db, salesActor(requireSession(args)), args.features)
  },
  {
    channel: 'pos.quote',
    permission: 'pos.sell',
    handler: (args) => {
      const session = requireSession(args);
      const payload = payloadOf<Parameters<typeof priceCart>[1]>(args);
      return priceCart(args.ctx.db, payload, salesActor(session));
    }
  },
  {
    channel: 'pos.approve',
    // Any signed-in user may ask; the approver's own credentials and role
    // decide whether the approval is granted.
    handler: (args) => {
      const session = requireSession(args);
      return approveWithPin(args.ctx.db, payloadOf<ApprovalInput>(args), session);
    }
  },
  {
    channel: 'pos.holds.list',
    permission: 'pos.sell',
    handler: (args) => listHeldSales(args.ctx.db, salesActor(requireSession(args)))
  },
  {
    channel: 'pos.holds.save',
    permission: 'pos.sell',
    handler: (args) => holdSale(args.ctx.db, payloadOf<HoldInput>(args), salesActor(requireSession(args)))
  },
  {
    channel: 'pos.holds.get',
    permission: 'pos.sell',
    handler: (args) => {
      const session = requireSession(args);
      return getHeldSale(args.ctx.db, payloadOf<{ id: number }>(args).id, salesActor(session));
    }
  },
  {
    channel: 'pos.holds.cancel',
    permission: 'pos.sell',
    handler: (args) => {
      const session = requireSession(args);
      return cancelHeldSale(args.ctx.db, payloadOf<{ id: number }>(args).id, salesActor(session));
    }
  },
  {
    channel: 'pos.print',
    permission: 'pos.sell',
    handler: (args) => {
      const session = requireSession(args);
      return printSaleDocument(
        args.ctx.db,
        payloadOf<{ id: number; layout?: 'THERMAL_80' | 'THERMAL_58' | 'A4_RECEIPT' | 'A4_INVOICE' }>(args),
        salesActor(session),
        args.features
      );
    }
  },
  {
    channel: 'pos.prints',
    permission: 'sales.view.all',
    handler: (args) => listDocumentPrints(args.ctx.db, payloadOf<{ saleId: number }>(args).saleId)
  },
  {
    channel: 'pos.credits.list',
    permission: 'sales.view.all',
    handler: (args) => listCreditBalances(args.ctx.db, payloadOf<{ search?: string }>(args)?.search)
  },
  {
    channel: 'pos.credits.customer',
    // Cashiers need a customer's limit to know whether credit is possible.
    permission: 'pos.sell',
    handler: (args) => customerBalanceSummary(args.ctx.db, payloadOf<{ customerId: number }>(args).customerId)
  },
  {
    channel: 'pos.credits.invoices',
    permission: 'pos.sell',
    handler: (args) => listCreditInvoices(args.ctx.db, payloadOf<{ customerId: number }>(args).customerId)
  },
  {
    channel: 'pos.credits.pay',
    permission: 'sales.credit.collect',
    handler: (args) => {
      const session = requireSession(args);
      return recordCreditPayment(
        args.ctx.db,
        payloadOf<Parameters<typeof recordCreditPayment>[1]>(args),
        salesActor(session),
        args.features
      );
    }
  },
  {
    channel: 'pos.display',
    permission: 'pos.sell',
    handler: (args) => displayState(args.ctx.db, payloadOf<Parameters<typeof displayState>[1]>(args))
  },

  /* ---------------- returns ---------------- */
  {
    channel: 'returns.lookup',
    permission: 'returns.create',
    handler: (args) => {
      const session = requireSession(args);
      const settings = getAllSettings(args.ctx.db);
      return lookupSaleForReturn(
        args.ctx.db,
        payloadOf<{ saleId?: number; receiptNo?: string }>(args),
        salesActor(session),
        { returnLimit: settings.returnLimit, returnWindowDays: settings.returnWindowDays }
      );
    }
  },
  {
    channel: 'returns.create',
    permission: 'returns.create',
    handler: (args) => {
      const session = requireSession(args);
      return createReturn(
        args.ctx.db,
        payloadOf<Parameters<typeof createReturn>[1]>(args),
        salesActor(session),
        getStoreProfile(args.ctx.db),
        args.features
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
      return approveReturn(args.ctx.db, payloadOf<{ id: number }>(args).id, salesActor(session), args.features);
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
    // Preview only: prints go through returns.print so the trail is written.
    handler: (args) => {
      requireSession(args);
      const ret = getReturn(args.ctx.db, payloadOf<{ id: number }>(args).id);
      const settings = getAllSettings(args.ctx.db);
      const html = buildCreditNoteDocument(ret, getStoreProfile(args.ctx.db), args.features.productName, {
        poweredBy: settings.poweredByFooter
      });
      return { html, creditNote: ret };
    }
  },
  {
    channel: 'returns.print',
    permission: 'returns.create',
    handler: (args) => {
      const session = requireSession(args);
      const ret = getReturn(args.ctx.db, payloadOf<{ id: number }>(args).id);
      if (
        ret.requestedBy !== session.userId &&
        ret.approvedBy !== session.userId &&
        !session.permissions.includes('reports.view.all')
      ) {
        throw new AppError('FORBIDDEN', 'You can only print returns you handled.');
      }
      const settings = getAllSettings(args.ctx.db);
      return printReturnDocument(
        args.ctx.db,
        payloadOf<{ id: number }>(args),
        actor(session),
        args.features.productName,
        { poweredBy: settings.poweredByFooter, store: getStoreProfile(args.ctx.db) }
      );
    }
  },
  {
    channel: 'returns.writeoffs',
    permission: 'reports.view.all',
    handler: (args) =>
      listWriteoffs(args.ctx.db, payloadOf<{ from?: string; to?: string; limit?: number }>(args) ?? {})
  },
  {
    channel: 'returns.writeoff',
    permission: 'reports.view.all',
    handler: (args) => getWriteoff(args.ctx.db, payloadOf<{ id: number }>(args).id)
  },

  /* ---------------- reports & dashboard ---------------- */
  {
    channel: 'dashboard.get',
    handler: (args) => {
      const session = requireSession(args);
      const canSeeAll = session.permissions.includes('reports.view.all');
      return getDashboard(args.ctx.db, {
        scopeUserId: canSeeAll ? undefined : session.userId,
        expiryWindowDays: getAllSettings(args.ctx.db).expiryAlertDays,
        trackedOnly: !args.features.pharmacy
      });
    }
  },
  {
    channel: 'reports.build',
    permission: 'reports.view.own',
    handler: (args) => {
      const request = payloadOf<ReportRequest>(args);
      if (!request?.kind) throw validation('Choose a report.');
      return buildReportForSession(args, request);
    }
  },
  {
    channel: 'reports.catalogue',
    permission: 'reports.view.own',
    handler: (args) => {
      const session = requireSession(args);
      return REPORT_CATALOGUE.filter((entry) => {
        if (entry.owner === 'PHARMACY' && !args.features.pharmacy) return false;
        if (entry.owner === 'SUPERMARKET' && !args.features.supermarket) return false;
        if (entry.permission && !session.permissions.includes(entry.permission)) return false;
        if (entry.adminOnly && session.role !== 'ADMIN') return false;
        return true;
      });
    }
  },
  {
    channel: 'reports.daily',
    permission: 'reports.view.own',
    handler: (args) => {
      const session = requireSession(args);
      const canSeeAll = session.permissions.includes('reports.view.all');
      const { date } = payloadOf<{ date?: string }>(args) ?? {};
      return dailySummary(
        args.ctx.db,
        { ...(date ? { date } : {}) },
        {
          store: getStoreProfile(args.ctx.db),
          productName: args.features.productName,
          includeProfit: session.role === 'ADMIN',
          ...(canSeeAll ? {} : { scopeUserId: session.userId })
        }
      );
    }
  },
  {
    channel: 'reports.monthly',
    permission: 'reports.view.own',
    handler: (args) => {
      const session = requireSession(args);
      const canSeeAll = session.permissions.includes('reports.view.all');
      const { month } = payloadOf<{ month?: string }>(args) ?? {};
      return monthlySummary(
        args.ctx.db,
        { ...(month ? { month } : {}) },
        {
          store: getStoreProfile(args.ctx.db),
          productName: args.features.productName,
          includeProfit: session.role === 'ADMIN',
          ...(canSeeAll ? {} : { scopeUserId: session.userId })
        }
      );
    }
  },
  {
    channel: 'reports.export',
    permission: 'reports.view.own',
    handler: (args) => {
      const request = payloadOf<ReportRequest>(args);
      if (!request?.kind) throw validation('Choose a report to export.');
      const report = buildReportForSession(args, request);
      return {
        filename: reportFileName(report, request.from),
        data: reportToCsv(report, getStoreProfile(args.ctx.db)),
        encoding: 'utf8' as const,
        mime: 'text/csv'
      };
    }
  },
  {
    // A real workbook: the table, the meta summary and a bold total row, with
    // money as naira numbers so Excel can add them up.
    channel: 'reports.excel',
    permission: 'reports.view.own',
    handler: async (args) => {
      const request = payloadOf<ReportRequest>(args);
      if (!request?.kind) throw validation('Choose a report to export.');
      const report = buildReportForSession(args, request);
      const buffer = await reportToExcel(report, getStoreProfile(args.ctx.db));
      return {
        filename: reportFileName(report, request.from).replace(/\.csv$/, '.xlsx'),
        data: buffer.toString('base64'),
        encoding: 'base64' as const,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };
    }
  },
  {
    channel: 'reports.pdf',
    permission: 'reports.view.own',
    handler: async (args) => {
      const request = payloadOf<ReportRequest>(args);
      if (!request?.kind) throw validation('Choose a report to export.');
      const report = buildReportForSession(args, request);
      if (!args.ctx.pdf) {
        throw new AppError(
          'UNAVAILABLE',
          'PDF export runs inside the desktop app. Use Print and choose “Save as PDF”, or export a CSV here.'
        );
      }
      const buffer = await args.ctx.pdf({ html: report.html, title: report.title });
      return {
        filename: `${report.kind.toLowerCase()}-${request.from ?? new Date().toISOString().slice(0, 10)}.pdf`,
        data: buffer.toString('base64'),
        encoding: 'base64' as const,
        mime: 'application/pdf'
      };
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

  {
    // Administrator-only: clears a lock caused by five failed sign-ins.
    channel: 'users.unlock',
    permission: 'users.manage',
    handler: (args) => {
      const session = requireSession(args);
      const { id } = payloadOf<{ id: number }>(args);
      const row = unlockUser(args.ctx.db, id, actor(session));
      return toUserAccount(row);
    }
  },

  /* ---------------- backup & documents ---------------- */
  {
    channel: 'backup.create',
    permission: 'backup.manage',
    handler: (args) => {
      const session = requireSession(args);
      const payload = payloadOf<{ label?: string; folder?: string }>(args) ?? {};
      const info = createBackup(
        args.ctx.db,
        args.ctx.backupsDir,
        payload.label?.trim() || 'manual',
        payload.folder ? { folder: payload.folder } : {}
      );
      audit(args.ctx.db, {
        action: 'backup.create',
        entity: 'backup',
        entityId: info.name,
        userId: session.userId,
        username: session.username,
        severity: 'SECURITY',
        details: info.external ? { folder: dirname(info.path), external: true } : { automatic: false }
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
    // The warning banner: how old is the newest backup, and is that too old?
    channel: 'backup.status',
    permission: 'backup.manage',
    handler: (args) => backupStatus(args.ctx.backupsDir, true)
  },
  {
    // List the .db files on a drive the operator points at (a USB stick).
    channel: 'backup.listFolder',
    permission: 'backup.manage',
    handler: (args) => listBackupsIn(payloadOf<{ folder: string }>(args).folder)
  },
  {
    channel: 'backup.copy',
    permission: 'backup.manage',
    handler: (args) => {
      const session = requireSession(args);
      const { path, folder } = payloadOf<{ path: string; folder: string }>(args);
      const source = listBackups(args.ctx.backupsDir).find((backup) => resolve(backup.path) === resolve(path));
      if (!source) throw notFound('Backup file');
      const copied = copyBackupTo(source, folder);
      audit(args.ctx.db, {
        action: 'backup.copy',
        entity: 'backup',
        entityId: copied.name,
        userId: session.userId,
        username: session.username,
        severity: 'SECURITY',
        details: { folder: dirname(copied.path) }
      });
      return copied;
    }
  },
  {
    // Windows folder picker (desktop only). The browser harness uploads a path.
    channel: 'backup.chooseFolder',
    permission: 'backup.manage',
    handler: async (args) => {
      requireSession(args);
      if (!args.ctx.pickFolder) {
        throw new AppError(
          'UNAVAILABLE',
          'The folder picker runs inside the desktop app. Type the folder path instead.'
        );
      }
      return { folder: await args.ctx.pickFolder({ title: 'Choose a folder for the backup' }) };
    }
  },
  {
    channel: 'backup.chooseFile',
    permission: 'backup.manage',
    handler: async (args) => {
      requireSession(args);
      if (!args.ctx.pickFile) {
        throw new AppError(
          'UNAVAILABLE',
          'The file picker runs inside the desktop app. Type the backup file path instead.'
        );
      }
      return { path: await args.ctx.pickFile({ title: 'Choose a backup file', extensions: ['db'] }) };
    }
  },
  {
    channel: 'backup.restore',
    permission: 'backup.manage',
    handler: (args) => {
      const session = requireSession(args);
      const { path, confirm } = payloadOf<{ path: string; confirm?: string }>(args);
      // A restore replaces every record: the operator types the file name so a
      // stray click cannot wipe the shop's data.
      if (!confirm || confirm.trim() !== basename(path ?? '')) {
        throw validation(
          `Type the backup file name (${basename(path ?? '') || 'the file name'}) to confirm the restore.`
        );
      }
      const result = restoreBackup(args.ctx.db, args.ctx.backupsDir, path, actor(session));
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
    // Writes an exported file (CSV text or base64 workbook) into the data
    // folder's exports directory and returns its path.
    channel: 'documents.saveExport',
    handler: (args) => {
      const session = requireSession(args);
      const { filename, data, encoding } = payloadOf<{
        filename: string;
        data: string;
        encoding: 'base64' | 'utf8';
      }>(args);
      if (!data || !filename) throw validation('Nothing to export.');
      const exportsDir = join(args.ctx.dataDir, 'exports');
      mkdirSync(exportsDir, { recursive: true });
      const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      const path = join(exportsDir, safe);
      writeFileSync(path, encoding === 'base64' ? Buffer.from(data, 'base64') : data, encoding === 'base64' ? undefined : 'utf8');
      audit(args.ctx.db, {
        action: 'document.export',
        entity: 'document',
        entityId: safe,
        userId: session.userId,
        username: session.username
      });
      return { path };
    }
  },
  {
    // The printers this machine can see, for the Settings picker. Reading the
    // list is harmless, but it belongs to the settings screen, so it needs the
    // same permission.
    channel: 'print.printers',
    permission: 'settings.manage',
    handler: async (args) => {
      if (!args.ctx.printers) {
        throw new AppError(
          'UNAVAILABLE',
          'The app reads your Windows printer list. In the browser preview, type a printer name instead.'
        );
      }
      return args.ctx.printers();
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
      const settings = getAllSettings(args.ctx.db);
      const result = await args.ctx.print({
        html,
        title: title ?? 'Infoflex document',
        // The administrator may pin a printer once, so the till does not have
        // to pick one on every receipt.
        ...(settings.printerName.trim() ? { deviceName: settings.printerName.trim() } : {}),
        silent: settings.silentPrint
      });
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

/** Core channels plus every edition module channel (used for lookup + docs). */
export const HANDLERS: Handler[] = [...CORE_HANDLERS, ...editionHandlers()];

/** Channels that stay available while a forced password change is pending. */
export const PASSWORD_CHANGE_ALLOWLIST = new Set([
  'app.state',
  'auth.me',
  'auth.logout',
  'auth.changePassword'
]);

export const HANDLER_MAP = new Map(HANDLERS.map((h) => [h.channel, h]));

/**
 * Runtime handler table for the active edition: a module's channels are only
 * reachable when its feature flag is on. Cached because the result only depends
 * on the two edition flags.
 */
const editionMaps = new Map<string, Map<string, Handler>>();

export function handlerMapFor(features: FeatureFlags): Map<string, Handler> {
  const key = `${features.pharmacy ? 'p' : ''}${features.supermarket ? 's' : ''}`;
  const cached = editionMaps.get(key);
  if (cached) return cached;
  const map = new Map<string, Handler>();
  for (const handler of CORE_HANDLERS) map.set(handler.channel, handler);
  for (const module of EDITION_MODULES) {
    if (!features[module.id]) continue;
    for (const handler of module.handlers) map.set(handler.channel, handler);
  }
  editionMaps.set(key, map);
  return map;
}

export const FEATURE_FLAGS: Array<keyof FeatureFlags> = [
  'pharmacy',
  'supermarket',
  'wholesale',
  'prescriptions'
];

export function describeHandlers(): { channel: string; permission?: string; feature?: string }[] {
  return HANDLERS.map((h) => ({ channel: h.channel, permission: h.permission, feature: h.feature }));
}

export { EDITION_MODULES };

export type { ApiContext };
