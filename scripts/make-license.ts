/**
 * Vendor CLI: issue a signed licence code for a customer.
 *
 *   VENDOR_MASTER_PASSWORD='...' npm run vendor:license -- \
 *     --edition PHARMACY --customer "Grace Pharmacy, Ikeja" --months 12
 *
 * Options:
 *   --edition   PHARMACY | SUPERMARKET | BOTH          (required)
 *   --customer  Customer / store name on the licence   (required)
 *   --months    Validity in months (default 12)
 *   --expires   Explicit expiry date YYYY-MM-DD (overrides --months)
 *   --note      Free-text reference
 *   --out       Write the code to a file instead of stdout
 *
 * The master password is read from the environment; it is never written to disk
 * and never appears in shell history when passed this way.
 */
import { writeFileSync } from 'node:fs';
import { buildLicensePayload, signLicensePayload } from '../src/license/license';
import type { Edition } from '../src/shared/types';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.log(
    'Usage: VENDOR_MASTER_PASSWORD=... npm run vendor:license -- --edition PHARMACY --customer "Store" [--months 12 | --expires YYYY-MM-DD] [--note ref] [--out file.txt]'
  );
  process.exit(1);
}

const password = process.env.VENDOR_MASTER_PASSWORD;
if (!password) {
  console.error('Set VENDOR_MASTER_PASSWORD before issuing a licence.');
  process.exit(1);
}

const edition = (arg('edition') ?? '').toUpperCase() as Edition;
const customer = arg('customer');
if (!['PHARMACY', 'SUPERMARKET', 'BOTH'].includes(edition) || !customer) usage();

const expiresArg = arg('expires');
const months = Number(arg('months') ?? 12);
let expiresAt: string;
if (expiresArg) {
  expiresAt = new Date(`${expiresArg}T23:59:59`).toISOString();
} else {
  const date = new Date();
  date.setMonth(date.getMonth() + (Number.isFinite(months) ? months : 12));
  expiresAt = date.toISOString();
}

const payload = buildLicensePayload({
  edition,
  customerName: customer,
  expiresAt,
  note: arg('note')
});

const code = signLicensePayload(payload, password);

const out = arg('out');
if (out) {
  writeFileSync(out, `${code}\n`, 'utf8');
  console.log(`Licence written to ${out}`);
} else {
  console.log(code);
}
console.log(
  `\nEdition: ${payload.edition}  |  Customer: ${payload.customerName}  |  Expires: ${payload.expiresAt.slice(0, 10)}`
);
