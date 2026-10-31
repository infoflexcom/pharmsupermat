import type { EditionModule } from '..';
import { payloadOf } from '../../main/api/args';
import { PHARMACY_TABLES } from '../../db/schema';
import { listStockAlerts } from '../../services/inventory';
import { findProductByCode } from '../../services/products';
import { listBatches } from '../../services/stock';

/**
 * Pharmacy module — batch/expiry handling, generic names and prescription
 * flags. Every channel here is gated by the `pharmacy` feature flag in the
 * main process (see `handlerMapFor`), so a supermarket licence can never reach
 * these handlers even if the renderer asks for them.
 */
export const pharmacyModule: EditionModule = {
  id: 'pharmacy',
  label: 'Pharmacy',
  tables: PHARMACY_TABLES,
  handlers: [
    {
      channel: 'pharmacy.expiryWatch',
      permission: 'products.view',
      feature: 'pharmacy',
      handler: (args) => {
        const { windowDays } = payloadOf<{ windowDays?: number }>(args) ?? {};
        const days = typeof windowDays === 'number' && windowDays > 0 ? Math.min(windowDays, 730) : 90;
        return listStockAlerts(args.ctx.db, days).expiring;
      }
    },
    {
      // Counter-friendly lookup: scan/type a code, get the product, its stock
      // and its batches (FEFO order) in one round-trip.
      channel: 'pharmacy.dispenseLookup',
      permission: 'products.view',
      feature: 'pharmacy',
      handler: (args) => {
        const { code } = payloadOf<{ code?: string }>(args) ?? {};
        const product = findProductByCode(args.ctx.db, code ?? '');
        if (!product) return null;
        return { product, batches: listBatches(args.ctx.db, product.id) };
      }
    }
  ]
};
