import type { Database } from '../db';
import { nowIso } from '../db';
import { repositoriesFor, type CategoryRow, type CustomerRow, type SupplierRow } from '../db/repositories';
import { conflict, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import type { Actor } from './stock';

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export interface CategoryInput {
  id?: number;
  name: string;
  description?: string | null;
  sortOrder?: number;
  active?: boolean;
}

export function listCategoryRecords(db: Database): CategoryRow[] {
  return repositoriesFor(db).categories.all();
}

export function saveCategory(db: Database, input: CategoryInput, actor: Actor): CategoryRow {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Category name is required.');
  const repos = repositoriesFor(db);
  const existing = input.id ? repos.categories.findById(input.id) : repos.categories.findOne({ name });
  if (input.id && !existing) throw notFound('Category');
  const clash = repos.categories.findOne({ name });
  if (clash && clash.id !== existing?.id) throw conflict(`Category ${name} already exists.`);

  return db.transaction(() => {
    const now = nowIso();
    if (existing) {
      repos.categories.update(existing.id, {
        name,
        description: input.description ?? existing.description,
        sort_order: input.sortOrder ?? existing.sort_order,
        active: input.active === undefined ? existing.active : input.active ? 1 : 0,
        updated_at: now
      });
      audit(db, {
        action: 'category.update',
        entity: 'category',
        entityId: existing.id,
        userId: actor.userId,
        username: actor.username,
        details: { name }
      });
      return repos.categories.findById(existing.id)!;
    }
    const id = repos.categories.insert({
      name,
      description: input.description ?? null,
      sort_order: input.sortOrder ?? 0,
      active: input.active === false ? 0 : 1,
      created_at: now,
      updated_at: now
    });
    audit(db, {
      action: 'category.create',
      entity: 'category',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { name }
    });
    return repos.categories.findById(id)!;
  });
}

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export interface SupplierInput {
  id?: number;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  active?: boolean;
}

export function listSupplierRecords(db: Database, search?: string): SupplierRow[] {
  const repos = repositoriesFor(db);
  if (!search?.trim()) return repos.suppliers.all();
  const like = `%${search.trim()}%`;
  return db.handle
    .prepare(
      `SELECT * FROM suppliers
       WHERE name LIKE ? OR IFNULL(contact_person, '') LIKE ? OR IFNULL(phone, '') LIKE ?
       ORDER BY name COLLATE NOCASE LIMIT 500`
    )
    .all(like, like, like) as SupplierRow[];
}

export function saveSupplier(db: Database, input: SupplierInput, actor: Actor): SupplierRow {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Supplier name is required.');
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw validation('Supplier email looks invalid.');
  const repos = repositoriesFor(db);
  const existing = input.id ? repos.suppliers.findById(input.id) : null;
  if (input.id && !existing) throw notFound('Supplier');

  return db.transaction(() => {
    const now = nowIso();
    if (existing) {
      repos.suppliers.update(existing.id, {
        name,
        contact_person: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        active: input.active === undefined ? existing.active : input.active ? 1 : 0,
        updated_at: now
      });
      audit(db, {
        action: 'supplier.update',
        entity: 'supplier',
        entityId: existing.id,
        userId: actor.userId,
        username: actor.username,
        details: { name }
      });
      return repos.suppliers.findById(existing.id)!;
    }
    const id = repos.suppliers.insert({
      name,
      contact_person: input.contactPerson ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null,
      active: input.active === false ? 0 : 1,
      created_at: now,
      updated_at: now
    });
    audit(db, {
      action: 'supplier.create',
      entity: 'supplier',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { name }
    });
    return repos.suppliers.findById(id)!;
  });
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

export interface CustomerInput {
  id?: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  creditLimit?: number;
  notes?: string | null;
  active?: boolean;
}

export function listCustomerRecords(db: Database, search?: string): CustomerRow[] {
  const repos = repositoriesFor(db);
  if (!search?.trim()) return repos.customers.all();
  const like = `%${search.trim()}%`;
  return db.handle
    .prepare(
      `SELECT * FROM customers
       WHERE name LIKE ? OR IFNULL(phone, '') LIKE ? OR IFNULL(email, '') LIKE ?
       ORDER BY name COLLATE NOCASE LIMIT 500`
    )
    .all(like, like, like) as CustomerRow[];
}

export function saveCustomer(db: Database, input: CustomerInput, actor: Actor): CustomerRow {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Customer name is required.');
  if (input.creditLimit !== undefined && (!Number.isInteger(input.creditLimit) || input.creditLimit < 0)) {
    throw validation('Credit limit must be a whole amount in kobo.');
  }
  const repos = repositoriesFor(db);
  const existing = input.id ? repos.customers.findById(input.id) : null;
  if (input.id && !existing) throw notFound('Customer');

  return db.transaction(() => {
    const now = nowIso();
    if (existing) {
      repos.customers.update(existing.id, {
        name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        credit_limit: input.creditLimit ?? existing.credit_limit,
        notes: input.notes ?? null,
        active: input.active === undefined ? existing.active : input.active ? 1 : 0,
        updated_at: now
      });
      audit(db, {
        action: 'customer.update',
        entity: 'customer',
        entityId: existing.id,
        userId: actor.userId,
        username: actor.username,
        details: { name }
      });
      return repos.customers.findById(existing.id)!;
    }
    const id = repos.customers.insert({
      name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      credit_limit: input.creditLimit ?? 0,
      notes: input.notes ?? null,
      active: input.active === false ? 0 : 1,
      created_at: now,
      updated_at: now
    });
    audit(db, {
      action: 'customer.create',
      entity: 'customer',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { name }
    });
    return repos.customers.findById(id)!;
  });
}
