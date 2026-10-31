/**
 * Wipes the browser harness database so the app starts at the activation
 * screen again. This only touches ./data — the packaged desktop app keeps its
 * data in %APPDATA%/Infoflex/data and is never affected.
 */
import { rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');

if (!existsSync(dataDir)) {
  console.log('No harness data to remove.');
  process.exit(0);
}
rmSync(dataDir, { recursive: true, force: true });
console.log('Harness data removed. Start the app again to run first-run activation.');
