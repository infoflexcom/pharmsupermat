import type { EditionModule } from '..';
import { actor, payloadOf, requireSession } from '../../main/api/args';
import { SUPERMARKET_TABLES } from '../../db/schema';
import {
  addProductBarcode,
  listProductBarcodes,
  listProductVariants,
  removeProductBarcode,
  saveProductVariant,
  type VariantInput
} from '../../services/barcodes';
import {
  adjustLoyaltyPoints,
  listDepartments,
  listLoyaltyMembers,
  listLoyaltyTransactions,
  listPriceRules,
  listPromotions,
  saveDepartment,
  saveLoyaltyMember,
  savePriceRule,
  savePromotion,
  type DepartmentInput,
  type LoyaltyMemberInput,
  type PriceRuleInput,
  type PromotionInput
} from '../../services/marketing';
import {
  closeShift,
  listDrawerEvents,
  listShifts,
  logDrawerEvent,
  openShift,
  type DrawerEventType
} from '../../services/operations';

/**
 * Supermarket module — departments, promotions, price rules, loyalty, cashier
 * shifts, the drawer log, multiple barcodes and variants. All channels carry
 * the `supermarket` feature flag and are shipped in the main process only when
 * the licence enables the module.
 *
 * Price-setting channels require `prices.set` (admin only): supervisors may
 * approve an override but may not change what the shop charges.
 */
export const supermarketModule: EditionModule = {
  id: 'supermarket',
  label: 'Supermarket',
  tables: SUPERMARKET_TABLES,
  handlers: [
    /* ---------------- departments ---------------- */
    {
      channel: 'mart.departments.list',
      permission: 'products.view',
      feature: 'supermarket',
      handler: (args) => listDepartments(args.ctx.db)
    },
    {
      channel: 'mart.departments.save',
      permission: 'products.manage',
      feature: 'supermarket',
      handler: (args) => saveDepartment(args.ctx.db, payloadOf<DepartmentInput>(args), actor(requireSession(args)))
    },

    /* ---------------- promotions ---------------- */
    {
      channel: 'mart.promotions.list',
      permission: 'products.view',
      feature: 'supermarket',
      handler: (args) => listPromotions(args.ctx.db, payloadOf<{ activeOnly?: boolean }>(args)?.activeOnly === true)
    },
    {
      channel: 'mart.promotions.save',
      permission: 'prices.set',
      feature: 'supermarket',
      handler: (args) => savePromotion(args.ctx.db, payloadOf<PromotionInput>(args), actor(requireSession(args)))
    },

    /* ---------------- price rules ---------------- */
    {
      channel: 'mart.priceRules.list',
      permission: 'products.view',
      feature: 'supermarket',
      handler: (args) => listPriceRules(args.ctx.db)
    },
    {
      channel: 'mart.priceRules.save',
      permission: 'prices.set',
      feature: 'supermarket',
      handler: (args) => savePriceRule(args.ctx.db, payloadOf<PriceRuleInput>(args), actor(requireSession(args)))
    },

    /* ---------------- loyalty ---------------- */
    {
      channel: 'mart.loyalty.list',
      permission: 'products.view',
      feature: 'supermarket',
      handler: (args) => listLoyaltyMembers(args.ctx.db, payloadOf<{ search?: string }>(args)?.search)
    },
    {
      channel: 'mart.loyalty.save',
      permission: 'pos.sell',
      feature: 'supermarket',
      handler: (args) => saveLoyaltyMember(args.ctx.db, payloadOf<LoyaltyMemberInput>(args), actor(requireSession(args)))
    },
    {
      channel: 'mart.loyalty.adjust',
      permission: 'pos.sell',
      feature: 'supermarket',
      handler: (args) =>
        adjustLoyaltyPoints(
          args.ctx.db,
          payloadOf<{ memberId: number; points: number; reason?: string; saleId?: number | null }>(args),
          actor(requireSession(args))
        )
    },
    {
      channel: 'mart.loyalty.transactions',
      permission: 'products.view',
      feature: 'supermarket',
      handler: (args) => {
        const { memberId, limit } = payloadOf<{ memberId: number; limit?: number }>(args);
        return listLoyaltyTransactions(args.ctx.db, memberId, limit);
      }
    },

    /* ---------------- shifts + drawer ---------------- */
    {
      channel: 'mart.shifts.list',
      permission: 'pos.sell',
      feature: 'supermarket',
      handler: (args) => {
        const query = payloadOf<{ status?: 'OPEN' | 'CLOSED'; userId?: number; limit?: number }>(args) ?? {};
        return listShifts(args.ctx.db, query);
      }
    },
    {
      channel: 'mart.shifts.open',
      permission: 'pos.sell',
      feature: 'supermarket',
      handler: (args) =>
        openShift(args.ctx.db, payloadOf<{ openingFloat?: number; note?: string }>(args) ?? {}, actor(requireSession(args)))
    },
    {
      channel: 'mart.shifts.close',
      permission: 'pos.sell',
      feature: 'supermarket',
      handler: (args) =>
        closeShift(
          args.ctx.db,
          payloadOf<{ shiftId: number; countedCash: number; note?: string }>(args),
          actor(requireSession(args))
        )
    },
    {
      channel: 'mart.drawer.log',
      permission: 'pos.sell',
      feature: 'supermarket',
      handler: (args) =>
        logDrawerEvent(
          args.ctx.db,
          payloadOf<{ eventType: Exclude<DrawerEventType, 'OPEN' | 'CLOSE'>; amount?: number; reason?: string }>(args),
          actor(requireSession(args))
        )
    },
    {
      channel: 'mart.drawer.list',
      permission: 'pos.sell',
      feature: 'supermarket',
      handler: (args) => {
        const { shiftId, limit } = payloadOf<{ shiftId?: number; limit?: number }>(args) ?? {};
        return listDrawerEvents(args.ctx.db, { shiftId, limit });
      }
    },

    /* ---------------- barcodes + variants ---------------- */
    {
      channel: 'mart.barcodes.list',
      permission: 'products.view',
      feature: 'supermarket',
      handler: (args) => listProductBarcodes(args.ctx.db, payloadOf<{ productId: number }>(args).productId)
    },
    {
      channel: 'mart.barcodes.add',
      permission: 'products.manage',
      feature: 'supermarket',
      handler: (args) =>
        addProductBarcode(
          args.ctx.db,
          payloadOf<{ productId: number; barcode: string; packQty?: number; isPrimary?: boolean }>(args),
          actor(requireSession(args))
        )
    },
    {
      channel: 'mart.barcodes.remove',
      permission: 'products.manage',
      feature: 'supermarket',
      handler: (args) =>
        removeProductBarcode(
          args.ctx.db,
          payloadOf<{ productId: number; barcode: string }>(args),
          actor(requireSession(args))
        )
    },
    {
      channel: 'mart.variants.list',
      permission: 'products.view',
      feature: 'supermarket',
      handler: (args) => listProductVariants(args.ctx.db, payloadOf<{ productId: number }>(args).productId)
    },
    {
      channel: 'mart.variants.save',
      permission: 'products.manage',
      feature: 'supermarket',
      handler: (args) => saveProductVariant(args.ctx.db, payloadOf<VariantInput>(args), actor(requireSession(args)))
    }
  ]
};
