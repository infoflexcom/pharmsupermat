/**
 * Builds the Infoflex brand assets from one vector definition so the app icon,
 * the login logo, the installer icon and the in-app logo never drift apart.
 *
 * Outputs:
 *   logo-source.png                     (1024 master)
 *   resources/icon.png                  (512, used by the running app)
 *   resources/build/icon.png            (512, electron-builder)
 *   resources/build/icon.ico            (multi-size Windows installer/app icon)
 *   src/renderer/src/assets/logo.png    (512, in-app logo + login background)
 *
 * Replace the SVG below with the official artwork when available and re-run
 * `npm run icons`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const NAVY = '#1F3F73';
const NAVY_DARK = '#14294D';
const GOLD = '#C9A24B';
const OFF_WHITE = '#F7F5EF';

function logoSvg(size = 1024): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${NAVY}"/>
      <stop offset="100%" stop-color="${NAVY_DARK}"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#E5C87F"/>
      <stop offset="55%" stop-color="${GOLD}"/>
      <stop offset="100%" stop-color="#A9873B"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="214" fill="url(#bg)"/>
  <rect x="52" y="52" width="920" height="920" rx="176" fill="none" stroke="url(#gold)" stroke-width="10" opacity="0.55"/>
  <circle cx="512" cy="512" r="316" fill="none" stroke="url(#gold)" stroke-width="8" opacity="0.35"/>
  <text x="512" y="612" font-family="Georgia, 'Times New Roman', serif" font-size="392" font-weight="700"
        fill="${OFF_WHITE}" text-anchor="middle" letter-spacing="-12">IF</text>
  <rect x="300" y="672" width="424" height="16" rx="8" fill="url(#gold)"/>
  <text x="512" y="770" font-family="Helvetica, Arial, sans-serif" font-size="52" letter-spacing="16"
        fill="url(#gold)" text-anchor="middle">INFOFLEX</text>
</svg>`;
}

/** Minimal ICO writer: PNG-compressed entries, supported by Windows Vista+. */
function buildIco(entries: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    directory.writeUInt8(0, base + 2); // palette
    directory.writeUInt8(0, base + 3); // reserved
    directory.writeUInt16LE(1, base + 4); // colour planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

async function main() {
  const root = join(__dirname, '..');
  const svg = logoSvg(1024);

  const png = (size: number) =>
    sharp(Buffer.from(svg)).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

  for (const dir of ['resources', 'resources/build', 'src/renderer/src/assets']) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  writeFileSync(join(root, 'logo-source.png'), await png(1024));
  writeFileSync(join(root, 'resources/icon.png'), await png(512));
  writeFileSync(join(root, 'resources/build/icon.png'), await png(512));
  writeFileSync(join(root, 'src/renderer/src/assets/logo.png'), await png(512));

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = await Promise.all(icoSizes.map(async (size) => ({ size, png: await png(size) })));
  writeFileSync(join(root, 'resources/build/icon.ico'), buildIco(entries));

  console.log('Brand assets generated:', [
    'logo-source.png',
    'resources/icon.png',
    'resources/build/icon.png',
    'resources/build/icon.ico',
    'src/renderer/src/assets/logo.png'
  ].join(', '));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
