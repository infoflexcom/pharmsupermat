/**
 * Optional demo data.
 *
 * A new installation is empty, which is right for a shop but useless for a
 * demonstration, a training session or a first look at the app. This module
 * seeds a realistic catalogue — pharmacy products with batches, or a
 * supermarket with two departments, weighed items, promotions, loyalty members
 * and wholesale customers — plus sample users.
 *
 * Two rules:
 *  1. **Nothing is faked in the database.** The seed goes through the same
 *     services the screens use, so stock, batches, audit entries and validation
 *     are real. A seeded product is an ordinary product.
 *  2. **It can always be removed.** Every row created here is written to the
 *     `demo_data` register, so "Remove demo data" can take exactly those rows
 *     out again — and `kept` reports anything the shop has already used (a demo
 *     product that has been sold, for example) rather than breaking the sale.
 */
import type { Database } from '../db';
import { nowIso } from '../db';
import type { DemoRemoval, DemoStatus, Edition } from '../shared/types';
import { conflict, validation } from '../shared/errors';
import { audit } from './audit';
import { createProduct } from './products';
import { receiveStock } from './stock';
import { saveCustomer } from './directory';
import { saveDepartment, saveLoyaltyMember, savePromotion } from './marketing';
import { createUser } from './users';
import type { Actor } from './stock';

export type DemoEntity =
  | 'product'
  | 'batch'
  | 'department'
  | 'promotion'
  | 'customer'
  | 'loyalty_member'
  | 'user';

/** Password for every sample account; each is forced to change it at sign-in. */
export const DEMO_PASSWORD = 'Demo1234';

interface PharmacySeed {
  name: string;
  generic?: string;
  category: string;
  cost: number;
  price: number;
  wholesale?: number;
  rx?: boolean;
  stock: number;
  /** Opening batch expiry, in days from today. */
  expiry: number;
  /** A second batch with its own expiry, to demonstrate FEFO. */
  secondBatch?: { qty: number; expiry: number };
}

const PHARMACY: PharmacySeed[] = [
  { name: 'Paracetamol 500mg Tablets (100)', generic: 'Paracetamol', category: 'Analgesics', cost: 250, price: 500, wholesale: 450, stock: 80, expiry: 540, secondBatch: { qty: 40, expiry: 120 } },
  { name: 'Ibuprofen 400mg Tablets (100)', generic: 'Ibuprofen', category: 'Analgesics', cost: 350, price: 700, stock: 55, expiry: 420, secondBatch: { qty: 25, expiry: 150 } },
  { name: 'Diclofenac 50mg Tablets (30)', generic: 'Diclofenac sodium', category: 'Analgesics', cost: 300, price: 600, stock: 35, expiry: 365, secondBatch: { qty: 20, expiry: 90 } },
  { name: 'Amoxicillin 500mg Capsules (21)', generic: 'Amoxicillin', category: 'Antibiotics', cost: 900, price: 1_800, rx: true, stock: 24, expiry: 300 },
  { name: 'Ampicillin 250mg Capsules (20)', generic: 'Ampicillin', category: 'Antibiotics', cost: 700, price: 1_400, rx: true, stock: 18, expiry: 240 },
  { name: 'Azithromycin 500mg Tablets (3)', generic: 'Azithromycin', category: 'Antibiotics', cost: 2_500, price: 4_500, rx: true, stock: 12, expiry: 400 },
  { name: 'Ciprofloxacin 500mg Tablets (10)', generic: 'Ciprofloxacin', category: 'Antibiotics', cost: 1_200, price: 2_200, rx: true, stock: 20, expiry: 330 },
  { name: 'Artemether/Lumefantrine 80/480mg (6)', generic: 'Artemether + Lumefantrine', category: 'Antimalarials', cost: 1_800, price: 3_200, stock: 30, expiry: 500 },
  { name: 'Artemether/Lumefantrine Dispersible 20/120mg (6)', generic: 'Artemether + Lumefantrine', category: 'Antimalarials', cost: 900, price: 1_600, stock: 26, expiry: 300 },
  { name: 'Sulfadoxine/Pyrimethamine 500/25mg (3)', generic: 'Sulfadoxine + Pyrimethamine', category: 'Antimalarials', cost: 400, price: 800, stock: 15, expiry: 200, secondBatch: { qty: 10, expiry: 60 } },
  { name: 'Vitamin C 100mg Tablets (100)', generic: 'Ascorbic acid', category: 'Vitamins & Supplements', cost: 200, price: 450, stock: 90, expiry: 600 },
  { name: 'Multivitamin Syrup 200ml', category: 'Vitamins & Supplements', cost: 1_400, price: 2_500, stock: 22, expiry: 380 },
  { name: 'Vitamin B Complex Tablets (100)', category: 'Vitamins & Supplements', cost: 300, price: 650, stock: 40, expiry: 450 },
  { name: 'Zinc Sulphate 20mg Tablets (100)', category: 'Vitamins & Supplements', cost: 250, price: 500, stock: 33, expiry: 500 },
  { name: 'Folic Acid 5mg Tablets (100)', category: 'Vitamins & Supplements', cost: 180, price: 400, stock: 50, expiry: 480 },
  { name: 'Ferrous Sulphate 200mg Tablets (100)', generic: 'Ferrous sulphate', category: 'Vitamins & Supplements', cost: 220, price: 450, stock: 44, expiry: 420 },
  { name: 'Cough Syrup 100ml', category: 'Cough & Cold', cost: 800, price: 1_600, stock: 26, expiry: 240 },
  { name: 'Chlorpheniramine 4mg Tablets (30)', generic: 'Chlorpheniramine', category: 'Cough & Cold', cost: 150, price: 350, stock: 38, expiry: 400 },
  { name: 'Oral Rehydration Salts (10 sachets)', category: 'Gastro & Digestive', cost: 120, price: 300, stock: 60, expiry: 500 },
  { name: 'Metronidazole 400mg Tablets (21)', generic: 'Metronidazole', category: 'Gastro & Digestive', cost: 350, price: 750, rx: true, stock: 21, expiry: 330 },
  { name: 'Omeprazole 20mg Capsules (14)', generic: 'Omeprazole', category: 'Gastro & Digestive', cost: 900, price: 1_800, stock: 17, expiry: 300 },
  { name: 'Antacid Suspension 200ml', category: 'Gastro & Digestive', cost: 700, price: 1_400, stock: 19, expiry: 210 },
  { name: 'Ranitidine 150mg Tablets (20)', generic: 'Ranitidine', category: 'Gastro & Digestive', cost: 400, price: 850, stock: 14, expiry: 180 },
  { name: 'Betamethasone Cream 30g', generic: 'Betamethasone', category: 'Dermatology', cost: 900, price: 1_800, stock: 16, expiry: 360 },
  { name: 'Gentamicin Eye Drops 5ml', generic: 'Gentamicin', category: 'Dermatology', cost: 350, price: 750, stock: 24, expiry: 210 },
  { name: 'Methylated Spirit 200ml', category: 'Dermatology', cost: 400, price: 800, stock: 12, expiry: 900 },
  { name: 'Baby Paracetamol Syrup 60ml', generic: 'Paracetamol', category: 'Baby & Mother Care', cost: 600, price: 1_200, stock: 30, expiry: 240 },
  { name: 'Oral Rehydration + Zinc Kit', category: 'Baby & Mother Care', cost: 500, price: 1_000, stock: 28, expiry: 400 },
  { name: 'Face Masks (pack of 50)', category: 'Consumables', cost: 800, price: 1_500, stock: 20, expiry: 2_000 },
  { name: 'Glucometer Test Strips (25)', category: 'Consumables', cost: 5_000, price: 8_000, stock: 10, expiry: 330 }
];

interface MartSeed {
  name: string;
  category: string;
  department: 'Groceries' | 'Household';
  cost: number;
  price: number;
  stock: number;
}

/** Sold by the kilogram: the scale prints a barcode, the till reads the weight. */
const MART_WEIGHED: { name: string; pricePerKg: number; plu: string; stock: number }[] = [
  { name: 'Long Grain Rice', pricePerKg: 140_000, plu: '00101', stock: 250_000 },
  { name: 'Brown Beans', pricePerKg: 160_000, plu: '00102', stock: 180_000 },
  { name: 'Garri (Ijebu)', pricePerKg: 80_000, plu: '00103', stock: 150_000 },
  { name: 'Granulated Sugar', pricePerKg: 120_000, plu: '00104', stock: 120_000 },
  { name: 'Tomatoes', pricePerKg: 90_000, plu: '00105', stock: 60_000 },
  { name: 'Red Pepper (Rodo)', pricePerKg: 110_000, plu: '00106', stock: 45_000 },
  { name: 'Puna Yam', pricePerKg: 130_000, plu: '00107', stock: 90_000 },
  { name: 'Chicken Drumsticks', pricePerKg: 320_000, plu: '00108', stock: 40_000 }
];

const MART_GROCERIES: MartSeed[] = [
  ['Golden Penny Semovita 1kg', 'Flour & Grains', 950, 1_350, 40],
  ['Dangote Sugar 500g', 'Baking & Sugar', 700, 1_000, 55],
  ['Peak Milk Powder 400g', 'Dairy', 2_300, 3_200, 30],
  ['Milo Chocolate Drink 400g', 'Beverages', 2_800, 3_800, 26],
  ['Bournvita 500g', 'Beverages', 2_600, 3_600, 22],
  ['Indomie Chicken Noodles (pack of 5)', 'Noodles & Pasta', 1_200, 1_800, 48],
  ['Golden Morn 500g', 'Cereals', 1_500, 2_200, 35],
  ['Quaker Oats 500g', 'Cereals', 1_800, 2_500, 20],
  ['Kings Vegetable Oil 1L', 'Cooking Oil', 2_400, 3_300, 25],
  ["Devon King's Vegetable Oil 2L", 'Cooking Oil', 4_600, 6_200, 15],
  ['Titus Sardine 125g', 'Canned Goods', 900, 1_400, 42],
  ['Geisha Mackerel 125g', 'Canned Goods', 750, 1_200, 50],
  ['Gino Tomato Paste 70g', 'Canned Goods', 180, 350, 80],
  ['Maggi Star Cubes (50)', 'Seasoning', 900, 1_400, 44],
  ['Knorr Chicken Cubes (50)', 'Seasoning', 950, 1_500, 38],
  ['Dangote Salt 1kg', 'Seasoning', 300, 500, 60],
  ['Golden Penny Spaghetti (pack of 5)', 'Noodles & Pasta', 1_100, 1_700, 32],
  ['Golden Penny Macaroni 500g', 'Noodles & Pasta', 500, 800, 28],
  ['Family Bread (large loaf)', 'Bakery', 900, 1_400, 18],
  ['Eggs (crate of 30)', 'Fresh Produce', 3_200, 4_200, 14],
  ['Blue Band Margarine 500g', 'Dairy', 1_400, 2_000, 24],
  ['Butter (salted) 250g', 'Dairy', 1_600, 2_300, 16],
  ['Lipton Yellow Label Tea (50 bags)', 'Beverages', 1_700, 2_400, 20],
  ['Nescafe Classic 100g', 'Beverages', 3_400, 4_600, 12],
  ['Cowbell Custard 400g', 'Cereals', 1_300, 1_900, 18],
  ['Grand Pure Soya Oil 1L', 'Cooking Oil', 2_500, 3_400, 22],
  ['Red Palm Oil 1L', 'Cooking Oil', 1_800, 2_600, 20],
  ['Yam Flour (Elubo) 1kg', 'Flour & Grains', 1_600, 2_300, 26],
  ['Plantain Flour 1kg', 'Flour & Grains', 2_200, 3_100, 12],
  ['Pure Honey 500ml', 'Beverages', 2_600, 3_800, 10],
  ['Peak Milk Sachet (pack of 10)', 'Dairy', 1_000, 1_500, 36],
  ['Bournvita Refill 200g', 'Beverages', 1_300, 1_900, 24]
].map(([name, category, cost, price, stock]) => ({
  name: name as string,
  category: category as string,
  department: 'Groceries' as const,
  cost: cost as number,
  price: price as number,
  stock: stock as number
}));

const MART_HOUSEHOLD: MartSeed[] = [
  ['Omo Detergent 900g', 'Laundry', 1_700, 2_400, 30],
  ['Ariel Detergent 500g', 'Laundry', 1_100, 1_700, 28],
  ['Sunlight Bar Soap (pack of 3)', 'Laundry', 900, 1_400, 36],
  ['Dettol Antiseptic 250ml', 'Cleaning', 1_500, 2_200, 22],
  ['Harpic Toilet Cleaner 750ml', 'Cleaning', 1_600, 2_300, 18],
  ['Izal Disinfectant 1L', 'Cleaning', 1_300, 2_000, 20],
  ['Hypo Bleach 1L', 'Cleaning', 800, 1_300, 24],
  ['Vim Scouring Powder 500g', 'Cleaning', 600, 1_000, 26],
  ['Toilet Paper (pack of 10)', 'Paper & Tissue', 1_900, 2_700, 32],
  ['Facial Tissue (box of 100)', 'Paper & Tissue', 1_200, 1_800, 20],
  ['Close-Up Toothpaste 130g', 'Personal Care', 900, 1_500, 30],
  ['Oral-B Toothbrush (pack of 2)', 'Personal Care', 800, 1_400, 22],
  ['Lux Beauty Soap (pack of 2)', 'Personal Care', 700, 1_200, 34],
  ['Dettol Bath Soap 110g', 'Personal Care', 450, 800, 40],
  ['Bath Sponge (2 pack)', 'Personal Care', 350, 700, 25],
  ['Mopping Broom', 'Household Tools', 1_800, 2_800, 10],
  ['Floor Mop with Bucket', 'Household Tools', 4_500, 6_500, 6],
  ['AA Batteries (pack of 4)', 'Household Tools', 900, 1_600, 18],
  ['Mosquito Coil (pack of 12)', 'Household Tools', 700, 1_200, 24],
  ['Insecticide Spray 400ml', 'Cleaning', 1_900, 2_800, 14]
].map(([name, category, cost, price, stock]) => ({
  name: name as string,
  category: category as string,
  department: 'Household' as const,
  cost: cost as number,
  price: price as number,
  stock: stock as number
}));

const WHOLESALE_CUSTOMERS: { name: string; phone: string; credit: number }[] = [
  { name: 'Sunrise Stores', phone: '0803 555 0101', credit: 5_000_000 },
  { name: 'Blessed Kiosk', phone: '0812 555 0202', credit: 2_000_000 },
  { name: 'Unity Provisions', phone: '0705 555 0303', credit: 3_000_000 }
];

const LOYALTY_MEMBERS: { name: string; phone: string }[] = [
  { name: 'Ada Nwosu', phone: '0806 444 1122' },
  { name: 'Chinedu Okafor', phone: '0813 444 3344' },
  { name: 'Fatima Bello', phone: '0703 444 5566' }
];

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

function mark(db: Database, entity: DemoEntity, id: number): void {
  db.handle
    .prepare('INSERT OR IGNORE INTO demo_data (entity, entity_id, created_at) VALUES (?, ?, ?)')
    .run(entity, id, nowIso());
}

function idsFor(db: Database, entity: DemoEntity): number[] {
  const rows = db.handle
    .prepare('SELECT entity_id FROM demo_data WHERE entity = ? ORDER BY entity_id')
    .all(entity) as { entity_id: number }[];
  return rows.map((row) => row.entity_id);
}

function countOf(db: Database, entity: DemoEntity): number {
  const row = db.handle.prepare('SELECT COUNT(*) AS n FROM demo_data WHERE entity = ?').get(entity) as { n: number };
  return row.n;
}

export function demoStatus(db: Database): DemoStatus {
  const first = db.handle
    .prepare("SELECT MIN(created_at) AS at FROM demo_data")
    .get() as { at: string | null };
  const products = countOf(db, 'product');
  return {
    loaded: countOf(db, 'product') + countOf(db, 'department') + countOf(db, 'user') > 0,
    loadedAt: first.at ?? null,
    products,
    batches: countOf(db, 'batch'),
    users: countOf(db, 'user'),
    departments: countOf(db, 'department'),
    promotions: countOf(db, 'promotion'),
    customers: countOf(db, 'customer'),
    loyaltyMembers: countOf(db, 'loyalty_member')
  };
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function lowestOrNull(db: Database, productId: number): number | null {
  const row = db.handle
    .prepare('SELECT MIN(id) AS id FROM product_batches WHERE product_id = ?')
    .get(productId) as { id: number | null };
  return row.id ?? null;
}

/**
 * Seeds the demo catalogue for the active edition. Safe to call once: a second
 * call is refused rather than doubling the catalogue.
 */
export function loadDemoData(db: Database, edition: Edition, actor: Actor): DemoStatus {
  const status = demoStatus(db);
  if (status.loaded) throw conflict('Demo data is already loaded. Remove it first, then load it again.');
  if (edition !== 'PHARMACY' && edition !== 'SUPERMARKET' && edition !== 'BOTH') {
    throw validation('Activate the app before loading demo data.');
  }

  const pharmacy = edition === 'PHARMACY' || edition === 'BOTH';
  const supermarket = edition === 'SUPERMARKET' || edition === 'BOTH';

  db.transaction(() => {
    if (pharmacy) seedPharmacy(db, actor);
    if (supermarket) seedSupermarket(db, actor);
    seedUsers(db, edition, actor);
    audit(db, {
      action: 'demo.load',
      entity: 'demo',
      userId: actor.userId,
      username: actor.username,
      severity: 'SECURITY',
      details: { edition }
    });
  });

  return demoStatus(db);
}

function seedPharmacy(db: Database, actor: Actor): void {
  PHARMACY.forEach((item, index) => {
    const product = createProduct(
      db,
      {
        name: item.name,
        genericName: item.generic ?? null,
        category: item.category,
        unit: 'pack',
        costPrice: item.cost * 100,
        price: item.price * 100,
        wholesalePrice: (item.wholesale ?? Math.round(item.price * 0.9)) * 100,
        reorderLevel: 5,
        rxRequired: item.rx ?? false,
        barcode: `50000000${String(index + 1).padStart(5, '0')}`,
        openingStock: item.stock,
        openingBatchNo: `PH-${String(index + 1).padStart(3, '0')}`,
        openingExpiry: daysFromNow(item.expiry)
      },
      actor
    );
    mark(db, 'product', product.id);

    if (item.secondBatch) {
      receiveStock(db, product.id, item.secondBatch.qty, {
        batchNo: `PH-${String(index + 1).padStart(3, '0')}B`,
        expiryDate: daysFromNow(item.secondBatch.expiry),
        costPrice: item.cost * 100,
        type: 'PURCHASE',
        note: 'Demo data: second batch',
        userId: actor.userId
      });
      const batch = db.handle
        .prepare("SELECT id FROM product_batches WHERE product_id = ? AND batch_no = ?")
        .get(product.id, `PH-${String(index + 1).padStart(3, '0')}B`) as { id: number } | undefined;
      if (batch) mark(db, 'batch', batch.id);
    }

    // One expired batch on a product that still has good stock: the expiry
    // guard has something real to refuse, and the demo shop can still trade.
    if (item.name.startsWith('Ranitidine')) {
      receiveStock(db, product.id, 6, {
        batchNo: 'PH-023-EXP',
        expiryDate: daysFromNow(-12),
        costPrice: item.cost * 100,
        type: 'PURCHASE',
        note: 'Demo data: an expired batch',
        userId: actor.userId
      });
      const batch = db.handle
        .prepare("SELECT id FROM product_batches WHERE product_id = ? AND batch_no = 'PH-023-EXP'")
        .get(product.id) as { id: number } | undefined;
      if (batch) mark(db, 'batch', batch.id);
    }

    const opening = lowestOrNull(db, product.id);
    if (opening) mark(db, 'batch', opening);
  });
}

function seedSupermarket(db: Database, actor: Actor): void {
  const departments: Record<string, number> = {};
  for (const name of ['Groceries', 'Household'] as const) {
    const department = saveDepartment(db, { name, description: `Demo ${name.toLowerCase()} department` }, actor);
    departments[name] = department.id;
    mark(db, 'department', department.id);
  }

  let index = 0;
  for (const item of [...MART_GROCERIES, ...MART_HOUSEHOLD]) {
    index += 1;
    const product = createProduct(
      db,
      {
        name: item.name,
        category: item.category,
        unit: item.category === 'Paper & Tissue' ? 'pack' : 'unit',
        costPrice: item.cost * 100,
        price: item.price * 100,
        reorderLevel: 4,
        departmentId: departments[item.department],
        shelfLocation: item.department === 'Groceries' ? `A${(index % 6) + 1}` : `B${(index % 4) + 1}`,
        barcode: `60000000${String(index).padStart(5, '0')}`,
        openingStock: item.stock,
        openingBatchNo: 'DEFAULT',
        openingExpiry: null
      },
      actor
    );
    mark(db, 'product', product.id);
    const batch = lowestOrNull(db, product.id);
    if (batch) mark(db, 'batch', batch);
  }

  for (const item of MART_WEIGHED) {
    const product = createProduct(
      db,
      {
        name: `${item.name} (per kg)`,
        category: 'Fresh Produce',
        unit: 'kg',
        costPrice: Math.round(item.pricePerKg * 0.75),
        price: item.pricePerKg,
        pricePerKg: item.pricePerKg,
        isWeighed: true,
        pluCode: item.plu,
        barcode: `210${item.plu}00000`,
        departmentId: departments.Groceries,
        shelfLocation: 'C1',
        openingStock: item.stock,
        openingBatchNo: 'DEFAULT',
        openingExpiry: null
      },
      actor
    );
    mark(db, 'product', product.id);
    const batch = lowestOrNull(db, product.id);
    if (batch) mark(db, 'batch', batch);
  }

  // Promotions the pricing engine already understands: a department percentage,
  // a buy-one-get-one and a multi-buy bundle.
  const groceryIds = MART_GROCERIES.map((item) => item.name);
  const findByName = (name: string): number => {
    const row = db.handle.prepare('SELECT id FROM products WHERE name = ?').get(name) as { id: number } | undefined;
    if (!row) throw validation(`Demo product ${name} was not created.`);
    return row.id;
  };

  const promotions = [
    savePromotion(
      db,
      {
        name: 'Groceries 10% off',
        promoType: 'PERCENT',
        value: 10,
        departmentId: departments.Groceries,
        minQty: 1,
        active: true
      },
      actor
    ),
    savePromotion(
      db,
      { name: 'Buy 1 Geisha, get 1 free', promoType: 'BOGO', value: 0, productId: findByName('Geisha Mackerel 125g'), minQty: 2, active: true },
      actor
    ),
    savePromotion(
      db,
      {
        name: 'Indomie 5 for ₦1,500',
        promoType: 'MULTIBUY',
        value: 150_000,
        productId: findByName('Indomie Chicken Noodles (pack of 5)'),
        minQty: 5,
        active: true
      },
      actor
    )
  ];
  for (const promotion of promotions) mark(db, 'promotion', promotion.id);
  void groceryIds;

  for (const customer of WHOLESALE_CUSTOMERS) {
    const saved = saveCustomer(
      db,
      { name: customer.name, phone: customer.phone, creditLimit: customer.credit, notes: 'Demo wholesale customer' },
      actor
    );
    mark(db, 'customer', saved.id);
  }

  for (const member of LOYALTY_MEMBERS) {
    const saved = saveLoyaltyMember(db, { name: member.name, phone: member.phone }, actor);
    mark(db, 'loyalty_member', saved.id);
  }
}

function seedUsers(db: Database, edition: Edition, actor: Actor): void {
  const wantsSupervisor = edition === 'SUPERMARKET' || edition === 'BOTH';
  const people: { username: string; fullName: string; role: 'SUPERVISOR' | 'CASHIER' }[] = [];
  if (wantsSupervisor) people.push({ username: 'demo.supervisor', fullName: 'Demo Supervisor', role: 'SUPERVISOR' });
  people.push({ username: 'demo.cashier', fullName: 'Demo Cashier', role: 'CASHIER' });

  for (const person of people) {
    const existing = db.handle
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .get(person.username) as { id: number } | undefined;
    if (existing) continue;
    const user = createUser(db, { ...person, password: DEMO_PASSWORD }, actor, edition);
    mark(db, 'user', user.id);
  }
}

/* ------------------------------------------------------------------ */
/* Removal                                                             */
/* ------------------------------------------------------------------ */

function usedInSales(db: Database, productId: number): boolean {
  const row = db.handle
    .prepare('SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?')
    .get(productId) as { n: number };
  return row.n > 0;
}

function userHasActivity(db: Database, userId: number): boolean {
  const row = db.handle
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sales WHERE user_id = ?)
            + (SELECT COUNT(*) FROM returns WHERE requested_by = ?)
            + (SELECT COUNT(*) FROM stock_movements WHERE user_id = ?) AS n`
    )
    .get(userId, userId, userId) as { n: number };
  return row.n > 0;
}

function customerHasSales(db: Database, customerId: number): boolean {
  const row = db.handle.prepare('SELECT COUNT(*) AS n FROM sales WHERE customer_id = ?').get(customerId) as { n: number };
  return row.n > 0;
}

function forget(db: Database, entity: DemoEntity, id: number): void {
  db.handle.prepare('DELETE FROM demo_data WHERE entity = ? AND entity_id = ?').run(entity, id);
}

/**
 * Removes every row the seed created. Rows the shop has since used — a demo
 * product that has been sold, a demo user who has rung up a sale — are kept and
 * named in `kept`, because removing them would break real history.
 */
export function removeDemoData(db: Database, actor: Actor): DemoRemoval {
  const kept: string[] = [];
  let removed = 0;

  db.transaction(() => {
    /* Products -------------------------------------------------------- */
    for (const id of idsFor(db, 'product')) {
      const row = db.handle.prepare('SELECT name FROM products WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) {
        forget(db, 'product', id);
        continue;
      }
      if (usedInSales(db, id)) {
        kept.push(`product: ${row.name} (has been sold)`);
        continue;
      }
      db.handle.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(id);
      db.handle.prepare('DELETE FROM product_batches WHERE product_id = ?').run(id);
      db.handle.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(id);
      db.handle.prepare('DELETE FROM price_rules WHERE product_id = ?').run(id);
      db.handle.prepare('DELETE FROM promotions WHERE product_id = ?').run(id);
      db.handle.prepare('DELETE FROM products WHERE id = ?').run(id);
      forget(db, 'product', id);
      removed += 1;
    }
    // Batches are gone with their products; clear their register rows too.
    for (const id of idsFor(db, 'batch')) {
      const still = db.handle.prepare('SELECT id FROM product_batches WHERE id = ?').get(id);
      if (!still) forget(db, 'batch', id);
    }

    /* Promotions, customers, loyalty ---------------------------------- */
    for (const id of idsFor(db, 'promotion')) {
      const row = db.handle.prepare('SELECT name FROM promotions WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) {
        forget(db, 'promotion', id);
        continue;
      }
      db.handle.prepare('DELETE FROM promotions WHERE id = ?').run(id);
      forget(db, 'promotion', id);
      removed += 1;
    }

    for (const id of idsFor(db, 'customer')) {
      const row = db.handle.prepare('SELECT name FROM customers WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) {
        forget(db, 'customer', id);
        continue;
      }
      if (customerHasSales(db, id)) {
        kept.push(`customer: ${row.name} (has sales)`);
        continue;
      }
      db.handle.prepare('DELETE FROM customers WHERE id = ?').run(id);
      forget(db, 'customer', id);
      removed += 1;
    }

    for (const id of idsFor(db, 'loyalty_member')) {
      const row = db.handle.prepare('SELECT name FROM loyalty_members WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) {
        forget(db, 'loyalty_member', id);
        continue;
      }
      const transactions = db.handle
        .prepare('SELECT COUNT(*) AS n FROM loyalty_transactions WHERE member_id = ?')
        .get(id) as { n: number };
      if (transactions.n > 0) {
        kept.push(`loyalty member: ${row.name} (has points history)`);
        continue;
      }
      db.handle.prepare('DELETE FROM loyalty_members WHERE id = ?').run(id);
      forget(db, 'loyalty_member', id);
      removed += 1;
    }

    /* Departments ----------------------------------------------------- */
    for (const id of idsFor(db, 'department')) {
      const row = db.handle.prepare('SELECT name FROM departments WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) {
        forget(db, 'department', id);
        continue;
      }
      const used = db.handle
        .prepare('SELECT COUNT(*) AS n FROM products WHERE department_id = ?')
        .get(id) as { n: number };
      if (used.n > 0) {
        kept.push(`department: ${row.name} (still has products)`);
        continue;
      }
      db.handle.prepare('DELETE FROM departments WHERE id = ?').run(id);
      forget(db, 'department', id);
      removed += 1;
    }

    /* Users ----------------------------------------------------------- */
    for (const id of idsFor(db, 'user')) {
      const row = db.handle.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
      if (!row) {
        forget(db, 'user', id);
        continue;
      }
      if (userHasActivity(db, id)) {
        kept.push(`user: ${row.username} (has activity)`);
        continue;
      }
      db.handle.prepare('DELETE FROM users WHERE id = ?').run(id);
      forget(db, 'user', id);
      removed += 1;
    }

    audit(db, {
      action: 'demo.remove',
      entity: 'demo',
      userId: actor.userId,
      username: actor.username,
      severity: 'SECURITY',
      details: { removed, kept: kept.length }
    });
  });

  return { removed, kept };
}
