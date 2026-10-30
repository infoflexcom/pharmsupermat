/**
 * Brand asset pipeline.
 *
 * Source of truth: `logo-source.png` (the official Infoflex mark — navy rounded
 * square, "IF" emblem, gold rule and the INFOFLEX wordmark). The script:
 *
 *   1. trims the uniform/transparent margin around the artwork (the "wall"
 *      background is removed — anything outside the rounded plate becomes
 *      transparent),
 *   2. crops the plate to the emblem + wordmark bounding box,
 *   3. emits the Windows icon (.ico with 16/32/48/64/128/256 entries), the PNG
 *      icons electron-builder needs for Linux/macOS, the in-app logo and the
 *      blurred login background.
 *
 * If `logo-source.png` is missing (fresh clone, CI) the previous vector
 * definition is used so the build never depends on a binary asset being present.
 *
 *   npm run icons
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const NAVY = '#1F3F73';
const NAVY_DARK = '#0E2342';
const GOLD = '#C9A24B';
const OFF_WHITE = '#F7F5EF';

/** Vector fallback that mirrors the supplied artwork. */
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

/**
 * Trims whatever uniform border surrounds the artwork and returns a square RGBA
 * plate: the supplied source is already transparent outside its rounded plate;
 * a photo of the logo on a wall would lose that wall here, because `trim`
 * removes uniform edge colour and the alpha threshold removes near-white walls.
 */
async function preparePlate(source: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  const trimmed = await sharp(source)
    // Remove a flat wall/paper background when the artwork is not already
    // transparent: drop near-uniform edges, then knock out near-white pixels.
    .trim({ threshold: 12 })
    .ensureAlpha()
    .toBuffer();

  const { data, info } = await sharp(trimmed).raw().toBuffer({ resolveWithObject: true });
  // Knock out any remaining near-white "wall" pixels so the plate keeps only
  // the navy/gold mark (harmless when the source is already transparent).
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = info.channels === 4 ? data[i + 3] : 255;
    if (a === 0) continue;
    if (r > 244 && g > 244 && b > 244) data[i + 3] = 0;
  }

  const cleaned = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels }
  })
    .png()
    .toBuffer();

  // Square canvas with a hair of breathing room, so the 16px favicon still
  // reads as the brand plate rather than a crop of the ring.
  const side = Math.max(info.width, info.height);
  const padded = Math.round(side * 1.04);
  const square = await sharp({
    create: { width: padded, height: padded, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: cleaned, gravity: 'centre' }])
    .png()
    .toBuffer();

  return { buffer: square, width: padded, height: padded };
}

async function main(): Promise<void> {
  const root = join(__dirname, '..');
  const sourcePath = join(root, 'logo-source.png');
  const usingSource = existsSync(sourcePath);
  const source = usingSource
    ? await sharp(sourcePath).png().toBuffer()
    : await sharp(Buffer.from(logoSvg(1024))).png().toBuffer();

  const plate = await preparePlate(source);

  const at = (size: number) =>
    sharp(plate.buffer)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

  for (const dir of ['resources', 'resources/build', 'src/renderer/src/assets']) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  const master = await at(1024);
  writeFileSync(join(root, 'resources/icon.png'), await at(512));
  writeFileSync(join(root, 'resources/build/icon.png'), await at(512));
  writeFileSync(join(root, 'src/renderer/src/assets/logo.png'), await at(512));

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const entries = await Promise.all(icoSizes.map(async (size) => ({ size, png: await at(size) })));
  writeFileSync(join(root, 'resources/build/icon.ico'), buildIco(entries));

  // Individual PNGs are handy for store listings and for the NSIS header.
  for (const size of icoSizes) {
    writeFileSync(join(root, `resources/build/icon-${size}.png`), await at(size));
  }

  /* ---------------- login background ---------------- */
  // The front door: a large, softly blurred copy of the mark on a navy field,
  // exactly what the login page uses behind its card.
  const width = 1920;
  const height = 1200;
  const backdrop = await sharp({
    create: { width, height, channels: 3, background: NAVY_DARK }
  })
    .composite([
      {
        input: await sharp(master)
          .resize({ width: 1180, height: 1180, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .blur(26)
          .ensureAlpha()
          .composite([
            {
              input: Buffer.from(
                `<svg width="1180" height="1180"><rect width="1180" height="1180" fill="#0E2342" opacity="0.35"/></svg>`
              ),
              blend: 'over'
            }
          ])
          .png()
          .toBuffer(),
        gravity: 'centre'
      },
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}">
             <defs>
               <radialGradient id="v" cx="50%" cy="45%" r="75%">
                 <stop offset="45%" stop-color="#0E2342" stop-opacity="0.15"/>
                 <stop offset="100%" stop-color="#081528" stop-opacity="0.92"/>
               </radialGradient>
             </defs>
             <rect width="${width}" height="${height}" fill="url(#v)"/>
           </svg>`
        ),
        blend: 'over'
      }
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
  writeFileSync(join(root, 'src/renderer/src/assets/login-bg.jpg'), backdrop);

  console.log(
    `Brand assets generated from ${usingSource ? 'logo-source.png' : 'the built-in vector'}:\n` +
      [
        '  resources/icon.png (512)',
        '  resources/build/icon.png (512)',
        '  resources/build/icon.ico (16/32/48/64/128/256)',
        '  resources/build/icon-{16,32,48,64,128,256}.png',
        '  src/renderer/src/assets/logo.png (512)',
        '  src/renderer/src/assets/login-bg.jpg (1920x1200, blurred navy)'
      ].join('\n')
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
