/**
 * Till pricing: retail/wholesale price tiers, promotions, manual discounts,
 * VAT, credit balances and loyalty.
 *
 * One function prices a whole basket before anything is written, and the sale
 * writer re-uses the same quote so the customer, the screen and the stored
 * document can never disagree.
 */
import type { Database } from '../db';
import type { CartLineInput, PriceTier, Product, QuoteLine, SaleQuote, SettingsPayload } from '../shared/types';
import type { PromotionRow as PromotionRecord } from '../db/repositories';
import { validation } from '../shared/errors';
import { requireProduct } from './products';
import { getAllSettings, vatBasisPoints } from './settings';

export interface PricingActor {
  permissions: readonly string[];
}

export interface PriceCartInput {
  lines: CartLineInput[];
  /** Retail keeps shelf prices; wholesale uses the trade tier. */
  tier?: PriceTier;
  docType?: 'RECEIPT' | 'INVOICE';
  /** Sale-level manual discount in kobo. */
  discount?: Moneyish;
  loyaltyMemberId?: number | null;
  /** Points the buyer wants to spend. */
  loyaltyRedeemed?: number;
}

type Moneyish = number;

/** Promotions already loaded for the basket, so a 200-line cart stays fast. */
function activePromotions(db: Database, now: Date): PromotionRecord[] {
  const stamp = now.toISOString();
  return db.handle
    .prepare(
      `SELECT * FROM promotions
       WHERE active = 1
         AND (starts_at IS NULL OR starts_at = '' OR starts_at <= ?)
         AND (ends_at IS NULL OR ends_at = '' OR ends_at >= ?)
       ORDER BY id`
    )
    .all(stamp, stamp) as PromotionRecord[];
}

/** A promotion applies when it names the product, its category or its department. */
function promotionMatches(promo: PromotionRecord, product: Product, qty: number): boolean {
  if (qty < Math.max(1, promo.min_qty)) return false;
  if (promo.product_id && promo.product_id === product.id) return true;
  if (promo.category_id && product.categoryId && promo.category_id === product.categoryId) return true;
  if (promo.department_id && product.departmentId && promo.department_id === product.departmentId) return true;
  return false;
}

/**
 * Discount a promotion gives on one line.
 *
 *   PERCENT   value is a percentage of the line
 *   AMOUNT    value is kobo off the line (floored at the line value)
 *   BOGO      buy (min_qty - 1) get 1 free: min_qty 2 is the classic buy-one-get-one
 *   MULTIBUY  value is the bundle price in kobo for min_qty units
 *
 * Weighed lines are priced per kilogram, so unit-count promotions (BOGO and
 * MULTIBUY) are skipped for them; percentage and amount offers still apply.
 */
export function promotionDiscount(
  promo: PromotionRecord,
  unitPrice: number,
  qty: number,
  isWeighed: boolean
): number {
  const gross = isWeighed ? Math.round((qty * unitPrice) / 1000) : qty * unitPrice;
  if (gross <= 0) return 0;
  const count = Math.max(1, promo.min_qty);
  switch (promo.promo_type) {
    case 'PERCENT':
      return Math.min(gross, Math.round((gross * promo.value) / 100));
    case 'AMOUNT':
      return Math.min(gross, promo.value);
    case 'BOGO': {
      if (isWeighed) return 0;
      const freeUnits = Math.floor(qty / count);
      return Math.min(gross, freeUnits * unitPrice);
    }
    case 'MULTIBUY': {
      if (isWeighed) return 0;
      const bundles = Math.floor(qty / count);
      if (bundles === 0) return 0;
      const remainder = qty - bundles * count;
      const full = qty * unitPrice;
      const bundleTotal = bundles * promo.value + remainder * unitPrice;
      return Math.max(0, Math.min(gross, full - bundleTotal));
    }
    default:
      return 0;
  }
}

/** The single best offer for a line; ties go to the older promotion. */
function bestPromotion(
  promos: PromotionRecord[],
  product: Product,
  unitPrice: number,
  qty: number,
  isWeighed: boolean
): { promo: PromotionRecord; discount: number } | null {
  let best: { promo: PromotionRecord; discount: number } | null = null;
  for (const promo of promos) {
    if (!promotionMatches(promo, product, qty)) continue;
    const discount = promotionDiscount(promo, unitPrice, qty, isWeighed);
    if (discount <= 0) continue;
    if (!best || discount > best.discount) best = { promo, discount };
  }
  return best;
}

/** Flat list price for a product on the chosen tier. */
export function listPriceFor(product: Product, tier: PriceTier, qty: number): number {
  if (product.isWeighed && product.pricePerKg !== null) return product.pricePerKg;
  if (tier === 'WHOLESALE' && product.wholesalePrice < product.price) {
    // Trade prices only kick in once the wholesale minimum is reached.
    return qty >= Math.max(1, product.wholesaleMinQty) ? product.wholesalePrice : product.price;
  }
  return product.price;
}

function lineGross(unitPrice: number, qty: number, isWeighed: boolean): number {
  return isWeighed ? Math.round((qty * unitPrice) / 1000) : qty * unitPrice;
}

export interface QuoteContext {
  settings: SettingsPayload;
  promotions: PromotionRecord[];
}

/** Loads the settings and promotions once per basket. */
export function quoteContext(db: Database, now = new Date()): QuoteContext {
  return { settings: getAllSettings(db), promotions: activePromotions(db, now) };
}

function loyaltyBalance(db: Database, memberId: number): number {
  const row = db.handle.prepare('SELECT points FROM loyalty_members WHERE id = ?').get(memberId) as
    | { points: number }
    | undefined;
  return row?.points ?? 0;
}

/**
 * Prices a basket. Nothing is written: this is what the till shows while the
 * cashier scans, and the sale writer re-runs it inside its transaction.
 */
export function priceCart(
  db: Database,
  input: PriceCartInput,
  actor: PricingActor,
  context = quoteContext(db)
): SaleQuote {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw validation('Add at least one item to the sale.');
  }
  const { settings, promotions } = context;
  const tier: PriceTier = input.tier ?? (input.docType === 'INVOICE' ? 'WHOLESALE' : 'RETAIL');

  const lines: QuoteLine[] = [];
  let priceOverridden = false;

  for (const line of input.lines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw validation('Quantities must be positive whole numbers.');
    }
    const product = requireProduct(db, line.productId);
    if (product.isWeighed && product.pricePerKg === null) {
      throw validation(`${product.name} is set up as a weighed item but has no price per kg.`);
    }
    const listPrice = listPriceFor(product, tier, line.qty);
    const unitPrice = line.unitPrice ?? listPrice;
    if (!Number.isInteger(unitPrice) || unitPrice < 0) throw validation('Unit price is invalid.');
    const overridden = unitPrice !== listPrice;
    if (overridden) {
      // Pricing never blocks on its own: the till shows "supervisor needed"
      // and createSale enforces the approval token.
      priceOverridden = true;
    }

    const isWeighed = product.isWeighed && product.pricePerKg !== null;
    const gross = lineGross(unitPrice, line.qty, isWeighed);

    const best = bestPromotion(promotions, product, unitPrice, line.qty, isWeighed);
    const promoDiscount = best ? best.discount : 0;

    const requestedDiscount = line.discount ?? 0;
    if (!Number.isInteger(requestedDiscount) || requestedDiscount < 0) {
      throw validation('Line discount is invalid.');
    }
    const lineDiscount = Math.min(requestedDiscount, Math.max(0, gross - promoDiscount));
    if (requestedDiscount > lineDiscount) {
      throw validation(`${product.name}: the line discount is larger than the line.`);
    }

    lines.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      qty: line.qty,
      unitPrice,
      listPrice,
      isWeighed,
      gross,
      lineDiscount,
      promoDiscount,
      promotionId: best?.promo.id ?? null,
      promotionName: best?.promo.name ?? null,
      net: gross - lineDiscount - promoDiscount,
      rxRequired: product.rxRequired,
      priceOverridden: overridden
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.gross, 0);
  const itemDiscount = lines.reduce((sum, l) => sum + l.lineDiscount, 0);
  const promoDiscount = lines.reduce((sum, l) => sum + l.promoDiscount, 0);
  const discountable = subtotal - itemDiscount - promoDiscount;

  const manualDiscount = input.discount ?? 0;
  if (!Number.isInteger(manualDiscount) || manualDiscount < 0) throw validation('Discount is invalid.');
  if (manualDiscount > discountable) {
    throw validation('Discount cannot be more than the amount still due.');
  }

  // The cap only governs discounts a person gives deliberately: item and
  // sale-level discounts. Automatic promotions are the store's own pricing, so
  // they never eat into the allowance. Administrators sit above the cap.
  const manualDiscountPercent = subtotal > 0 ? (manualDiscount / subtotal) * 100 : 0;
  const totalDiscount = itemDiscount + promoDiscount + manualDiscount;
  const discountPercent = subtotal > 0 ? ((itemDiscount + manualDiscount) / subtotal) * 100 : 0;
  const capped = !actor.permissions.includes('settings.manage');

  const vatRate = vatBasisPoints(settings);
  const beforeVat = Math.max(0, discountable - manualDiscount);
  const tax = vatRate > 0 ? Math.round((beforeVat * vatRate) / 10_000) : 0;
  const grossTotal = beforeVat + tax;

  // Loyalty redemption: points become money off, never more than the bill.
  let loyaltyRedeemed = input.loyaltyRedeemed ?? 0;
  let loyaltyValue = 0;
  let loyaltyEarned = 0;
  const loyaltyOn = Boolean(input.loyaltyMemberId) && settings.loyaltyRedeemEnabled;
  if (input.loyaltyRedeemed !== undefined && input.loyaltyRedeemed !== null) {
    if (!input.loyaltyMemberId) throw validation('Choose the loyalty member before spending their points.');
    if (!settings.loyaltyRedeemEnabled) throw validation('Loyalty redemption is switched off for this store.');
    if (!Number.isInteger(loyaltyRedeemed) || loyaltyRedeemed < 0) {
      throw validation('Points to redeem must be a whole number.');
    }
    const available = loyaltyBalance(db, input.loyaltyMemberId);
    if (loyaltyRedeemed > available) {
      throw validation(`That member only has ${available} point${available === 1 ? '' : 's'}.`);
    }
    const requested = loyaltyRedeemed * settings.loyaltyPointValue;
    const usable = Math.min(requested, grossTotal);
    loyaltyValue = usable;
    if (usable < requested) {
      // Trim to the points that actually fit the bill.
      loyaltyRedeemed = settings.loyaltyPointValue > 0 ? Math.floor(usable / settings.loyaltyPointValue) : 0;
      loyaltyValue = loyaltyRedeemed * settings.loyaltyPointValue;
    }
  }

  const total = Math.max(0, grossTotal - loyaltyValue);
  if (loyaltyOn && settings.loyaltyPointsPer100 > 0) {
    loyaltyEarned = Math.floor(total / 10_000) * settings.loyaltyPointsPer100;
  }

  const needsPriceApproval = priceOverridden && !actor.permissions.includes('prices.override');
  const overCap = capped && discountPercent > settings.maxDiscountPercent + 0.000001;
  const approvalReason = needsPriceApproval
    ? 'A price override was entered.'
    : overCap
      ? `Discounts of ${discountPercent.toFixed(1)}% are above the ${settings.maxDiscountPercent}% cap.`
      : null;

  return {
    tier,
    lines,
    subtotal,
    itemDiscount,
    promoDiscount,
    manualDiscount,
    totalDiscount,
    manualDiscountPercent,
    vatRate,
    tax,
    loyaltyValue,
    loyaltyRedeemed,
    total,
    loyaltyEarned,
    requiresApproval: Boolean(approvalReason),
    approvalReason,
    needsPriceApproval,
    exceedsDiscountCap: overCap,
    discountPercent,
    blocked: null
  };
}
