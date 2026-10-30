/**
 * Code 128-B barcode generation for shelf/price labels.
 *
 * A plain SVG is returned so the label sheet prints crisply at any size with no
 * external assets — important because the app must work fully offline.
 */

// Module widths for the 107 Code 128 symbols (6 elements each; the stop symbol
// has 7). Index = symbol value.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

const START_B = 104;
const STOP = 106;

/** Values for a Code 128-B string, including start, checksum and stop. */
export function code128Values(text: string): number[] {
  const clean = text.replace(/[^\x20-\x7E]/g, '');
  if (!clean) return [];
  const values = [...clean].map((char) => char.charCodeAt(0) - 32);
  const checksum = (START_B + values.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  return [START_B, ...values, checksum, STOP];
}

export interface BarcodeSvgOptions {
  height?: number;
  /** Width of one module in px. */
  moduleWidth?: number;
  showText?: boolean;
  color?: string;
}

/**
 * Renders a scannable Code 128 barcode. Falls back to the raw text when the
 * value contains characters Code 128-B cannot encode.
 */
export function code128Svg(text: string, options: BarcodeSvgOptions = {}): string {
  const { height = 48, moduleWidth = 1.6, showText = true, color = '#000' } = options;
  const values = code128Values(text);
  const label = text.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char]!);
  if (values.length === 0) {
    return `<span style="font-family:monospace;font-size:11px">${label}</span>`;
  }

  const quiet = 10;
  let x = quiet;
  const bars: string[] = [];
  for (const value of values) {
    const pattern = PATTERNS[value];
    for (let index = 0; index < pattern.length; index += 1) {
      const width = Number(pattern[index]) * moduleWidth;
      if (index % 2 === 0) bars.push(`<rect x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="${height}" />`);
      x += width;
    }
  }
  const totalWidth = x + quiet;
  const textHeight = showText ? 14 : 0;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth.toFixed(0)}" height="${height + textHeight}" ` +
    `viewBox="0 0 ${totalWidth.toFixed(0)} ${height + textHeight}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<g fill="${color}">${bars.join('')}</g>` +
    (showText
      ? `<text x="${(totalWidth / 2).toFixed(0)}" y="${height + 12}" text-anchor="middle" ` +
        `font-family="monospace" font-size="11" fill="${color}">${label}</text>`
      : '') +
    '</svg>'
  );
}

/** GS1 check digit, used to validate/complete 12-digit retail barcodes. */
export function ean13CheckDigit(first12: string): number {
  const digits = first12.replace(/\D/g, '').slice(0, 12).padStart(12, '0');
  const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 13) return false;
  return ean13CheckDigit(digits.slice(0, 12)) === Number(digits[12]);
}
