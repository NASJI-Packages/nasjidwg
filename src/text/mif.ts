/* nasjidwg — MIF escapes (\M+<n>XXXX).
 *
 * The MIF form predates \U+ and encodes a code point of one specific CJK
 * codepage rather than Unicode: the digit selects the page, the four hex
 * digits are that page's own code. Resolving one therefore needs the same
 * double-byte tables the DWG string decoder uses.
 */

import { DBCS_PACKED } from './dbcs.js';

/** MIF page digit -> codepage table name. */
const MIF_PAGES: Record<number, string> = {
  1: 'CP932',                              /* Japanese */
  2: 'BIG5',                               /* Traditional Chinese */
  3: 'CP949',                              /* Korean Wansung */
  4: 'JOHAB',                              /* Korean Johab */
  5: 'GB2312'                              /* Simplified Chinese */
};

const cache = new Map<string, Map<number, number>>();

const table = (name: string): Map<number, number> => {
  const hit = cache.get(name);
  if (hit) return hit;
  const map = new Map<number, number>();
  const packed = DBCS_PACKED[name] ?? '';
  let k = 0, v = 0;
  if (packed) {
    for (const part of packed.split(';')) {
      const comma = part.indexOf(',');
      k += parseInt(part.slice(0, comma), 36);
      v += parseInt(part.slice(comma + 1), 36);
      map.set(k, v);
    }
  }
  cache.set(name, map);
  return map;
};

/** Resolve one MIF escape to its Unicode character. Unmapped codes fall
 *  back to the raw value so nothing is silently lost. */
export const decodeMif = (page: number, code: number): string => {
  const name = MIF_PAGES[page];
  if (!name) return String.fromCharCode(code);
  const t = table(name);
  const u = t.get(code) ?? t.get(code & 0x7f7f);
  return String.fromCharCode(u ?? code);
};

/** Encode a character as a MIF escape for a given page, when that page can
 *  represent it; returns null otherwise. */
export const encodeMif = (ch: string, page: number): string | null => {
  const name = MIF_PAGES[page];
  if (!name) return null;
  const want = ch.charCodeAt(0);
  for (const [code, u] of table(name)) {
    if (u === want) {
      return '\\M+' + page + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return null;
};
