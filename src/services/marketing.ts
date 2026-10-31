/**
 * Supermarket-module services: departments, promotions, price rules and
 * loyalty. Every handler that reaches these functions is gated by the
 * `supermarket` feature flag in the main process.
 */
import type { Database } from '../db';
import { nowIso } from '../db';
import {
  repositoriesFor,
  type DepartmentRow,
  type LoyaltyMemberRow,
  type LoyaltyTransactionRow,
  type PriceRuleRow,
  type PromotionRow
} from '../db/repositories';
import { conflict, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import type { Actor } from './stock';

/* ------------------------------------------------------------------ */
/* Departments                                                         */
/* ------------------------------------------------------------------ */

export interface DepartmentInput {
  id?: number;
  name: string;
  description?: string | null;
  active?: boolean;
}

export function listDepartments(db: Database): DepartmentRow[] {
  return repositoriesFor(db).departments.all();
}

export function saveDepartment(db: Database, input: DepartmentInput, actor: Actor): DepartmentRow {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Department name is required.');
  const repos = repositoriesFor(db);
  const existing = input.id ? repos.departments.findById(input.id) : repos.departments.findOne({ name });
  if (input.id && !existing) throw notFound('Department');
  const clash = repos.departments.findOne({ name });
  if (clash && clash.id !== existing?.id) throw conflict(`Department ${name} already exists.`);

  return db.transaction(() => {
    const now = nowIso();
    const id = existing
      ? (repos.departments.update(existing.id, {
          name,
          description: input.description ?? existing.description,
          active: input.active === undefined ? existing.active : input.active ? 1 : 0,
          updated_at: now
        }),
        existing.id)
      : repos.departments.insert({
          name,
          description: input.description ?? null,
          active: input.active === false ? 0 : 1,
          created_at: now,
          updated_at: now
        });
    audit(db, {
      action: existing ? 'department.update' : 'department.create',
      entity: 'department',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { name }
    });
    return repos.departments.findById(id)!;
  });
}

/* ------------------------------------------------------------------ */
/* Promotions                                                          */
/* ------------------------------------------------------------------ */

export type PromoType = 'PERCENT' | 'AMOUNT' | 'BOGO' | 'MULTIBUY';

export interface PromotionInput {
  id?: number;
  name: string;
  promoType: PromoType;
  value: number;
  productId?: number | null;
  categoryId?: number | null;
  departmentId?: number | null;
  minQty?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  active?: boolean;
}

const PROMO_TYPES: PromoType[] = ['PERCENT', 'AMOUNT', 'BOGO', 'MULTIBUY'];

export function listPromotions(db: Database, activeOnly = false): PromotionRow[] {
  const repos = repositoriesFor(db);
  return activeOnly ? repos.promotions.all({ active: 1 }) : repos.promotions.all();
}

export function savePromotion(db: Database, input: PromotionInput, actor: Actor): PromotionRow {
  if (!input.name?.trim()) throw validation('Promotion name is required.');
  if (!PROMO_TYPES.includes(input.promoType)) throw validation('Choose a valid promotion type.');
  if (!Number.isInteger(input.value) || input.value < 0) throw validation('Promotion value is invalid.');
  if (input.promoType === 'PERCENT' && input.value > 100) throw validation('Percentage discounts cannot exceed 100.');
  if (!input.productId && !input.categoryId && !input.departmentId) {
    throw validation('Attach the promotion to a product, category or department.');
  }
  const repos = repositoriesFor(db);
  const existing = input.id ? repos.promotions.findById(input.id) : null;
  if (input.id && !existing) throw notFound('Promotion');

  return db.transaction(() => {
    const now = nowIso();
    const payload = {
      name: input.name.trim(),
      promo_type: input.promoType,
      value: input.value,
      product_id: input.productId ?? null,
      category_id: input.categoryId ?? null,
      department_id: input.departmentId ?? null,
      min_qty: input.minQty ?? 1,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      active: input.active === false ? 0 : 1,
      updated_at: now
    };
    const id = existing
      ? (repos.promotions.update(existing.id, payload), existing.id)
      : repos.promotions.insert({ ...payload, created_at: now });
    audit(db, {
      action: existing ? 'promotion.update' : 'promotion.create',
      entity: 'promotion',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { name: payload.name, promoType: payload.promo_type, value: payload.value }
    });
    return repos.promotions.findById(id)!;
  });
}

/* ------------------------------------------------------------------ */
/* Price rules                                                         */
/* ------------------------------------------------------------------ */

export type PriceRuleScope = 'PRODUCT' | 'CATEGORY' | 'DEPARTMENT';
export type PriceRuleType = 'DISCOUNT_PERCENT' | 'DISCOUNT_AMOUNT' | 'SET_PRICE';

export interface PriceRuleInput {
  id?: number;
  name: string;
  scope: PriceRuleScope;
  productId?: number | null;
  categoryId?: number | null;
  departmentId?: number | null;
  ruleType: PriceRuleType;
  value: number;
  minQty?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  requiresSupervisor?: boolean;
  active?: boolean;
}

export function listPriceRules(db: Database): PriceRuleRow[] {
  return repositoriesFor(db).priceRules.all();
}

export function savePriceRule(db: Database, input: PriceRuleInput, actor: Actor): PriceRuleRow {
  if (!input.name?.trim()) throw validation('Price rule name is required.');
  if (!['PRODUCT', 'CATEGORY', 'DEPARTMENT'].includes(input.scope)) throw validation('Choose a valid price rule scope.');
  if (!['DISCOUNT_PERCENT', 'DISCOUNT_AMOUNT', 'SET_PRICE'].includes(input.ruleType)) {
    throw validation('Choose a valid price rule type.');
  }
  if (!Number.isInteger(input.value) || input.value < 0) throw validation('Price rule value is invalid.');
  const target =
    input.scope === 'PRODUCT' ? input.productId : input.scope === 'CATEGORY' ? input.categoryId : input.departmentId;
  if (!target) throw validation('Pick the product/category/department this rule applies to.');
  const repos = repositoriesFor(db);
  const existing = input.id ? repos.priceRules.findById(input.id) : null;
  if (input.id && !existing) throw notFound('Price rule');

  return db.transaction(() => {
    const now = nowIso();
    const payload = {
      name: input.name.trim(),
      scope: input.scope,
      product_id: input.productId ?? null,
      category_id: input.categoryId ?? null,
      department_id: input.departmentId ?? null,
      rule_type: input.ruleType,
      value: input.value,
      min_qty: input.minQty ?? 1,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      requires_supervisor: input.requiresSupervisor === false ? 0 : 1,
      active: input.active === false ? 0 : 1,
      updated_at: now
    };
    const id = existing
      ? (repos.priceRules.update(existing.id, payload), existing.id)
      : repos.priceRules.insert({ ...payload, created_at: now });
    audit(db, {
      action: existing ? 'price_rule.update' : 'price_rule.create',
      entity: 'price_rule',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { name: payload.name, scope: payload.scope, ruleType: payload.rule_type, value: payload.value }
    });
    return repos.priceRules.findById(id)!;
  });
}

/* ------------------------------------------------------------------ */
/* Loyalty                                                             */
/* ------------------------------------------------------------------ */

export interface LoyaltyMemberInput {
  id?: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  active?: boolean;
}

export function listLoyaltyMembers(db: Database, search?: string): LoyaltyMemberRow[] {
  const repos = repositoriesFor(db);
  if (!search?.trim()) return repos.loyaltyMembers.all();
  const like = `%${search.trim()}%`;
  return db.handle
    .prepare(
      `SELECT * FROM loyalty_members WHERE name LIKE ? OR member_no LIKE ? OR IFNULL(phone, '') LIKE ?
       ORDER BY name COLLATE NOCASE LIMIT 300`
    )
    .all(like, like, like) as LoyaltyMemberRow[];
}

export function listLoyaltyTransactions(db: Database, memberId: number, limit = 100): LoyaltyTransactionRow[] {
  return repositoriesFor(db).loyaltyTransactions.all({ member_id: memberId }, { limit });
}

export function saveLoyaltyMember(db: Database, input: LoyaltyMemberInput, actor: Actor): LoyaltyMemberRow {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Member name is required.');
  const repos = repositoriesFor(db);
  const existing = input.id ? repos.loyaltyMembers.findById(input.id) : null;
  if (input.id && !existing) throw notFound('Loyalty member');

  return db.transaction(() => {
    let id: number;
    if (existing) {
      repos.loyaltyMembers.update(existing.id, {
        name,
        phone: input.phone ?? existing.phone,
        email: input.email ?? existing.email,
        active: input.active === undefined ? existing.active : input.active ? 1 : 0
      });
      id = existing.id;
    } else {
      const memberNo = `LM-${String(repos.loyaltyMembers.count() + 1).padStart(5, '0')}`;
      id = Number(
        repos.loyaltyMembers.insert({
          member_no: memberNo,
          name,
          phone: input.phone ?? null,
          email: input.email ?? null,
          points: 0,
          joined_at: nowIso(),
          active: input.active === false ? 0 : 1
        })
      );
    }
    audit(db, {
      action: existing ? 'loyalty.member.update' : 'loyalty.member.create',
      entity: 'loyalty_member',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { name }
    });
    return repos.loyaltyMembers.findById(id)!;
  });
}

/** Adds (or removes, with a negative change) points and writes the ledger row. */
export function adjustLoyaltyPoints(
  db: Database,
  input: { memberId: number; points: number; reason?: string; saleId?: number | null },
  actor: Actor
): LoyaltyMemberRow {
  if (!Number.isInteger(input.points) || input.points === 0) throw validation('Points change must be a non-zero whole number.');
  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const member = repos.loyaltyMembers.findById(input.memberId);
    if (!member) throw notFound('Loyalty member');
    const next = member.points + input.points;
    if (next < 0) throw validation('The member does not have that many points.');
    repos.loyaltyMembers.update(member.id, { points: next });
    repos.loyaltyTransactions.insert({
      member_id: member.id,
      sale_id: input.saleId ?? null,
      points_change: input.points,
      reason: input.reason?.trim() || null,
      user_id: actor.userId,
      created_at: nowIso()
    });
    audit(db, {
      action: 'loyalty.points',
      entity: 'loyalty_member',
      entityId: member.id,
      userId: actor.userId,
      username: actor.username,
      details: { points: input.points, balance: next, reason: input.reason ?? null }
    });
    return repos.loyaltyMembers.findById(member.id)!;
  });
}
