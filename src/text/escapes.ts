/* nasjidwg — CAD text control codes and escapes.
 *
 * Decoding (reader side): %%d -> ° (U+00B0), %%c -> Ø (U+00D8),
 * %%p -> ± (U+00B1), %%u / %%o underline/overline toggles stripped,
 * %%% -> %, %%nnn -> font character nnn, \U+XXXX -> the real character.
 *
 * Encoding (writer side): ° Ø ± are written back as %%d/%%c/%%p for
 * compatibility with legacy readers. An ASCII-era DXF is codepage text,
 * not UTF-8: every character above ASCII travels as the \U+XXXX escape —
 * text, layer names, block names, everything — and every reader rebuilds
 * the exact character.
 */

import { normalizeIncomingText } from './arabic.js';
import { decodeMif } from './mif.js';

/** Bytes 0x80..0x9F of Windows-1252 -> Unicode. */
export const CP1252_HIGH: readonly number[] = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178
];

/** Decode CAD text escapes into plain Unicode (and normalize any of our
 *  pre-shaped Arabic back to logical order). */
export const decodeCadText = (v: unknown): string => {
  const s = String(v == null ? '' : v);
  if (s.indexOf('%%') === -1 && s.indexOf('\\U+') === -1
      && s.indexOf('\\u+') === -1 && s.indexOf('\\M+') === -1) {
    return normalizeIncomingText(s);
  }
  return normalizeIncomingText(s
    /* \M+<n>XXXX — MIF escape: n selects a CJK codepage, XXXX is that
       page's code point. The Unicode value is resolved by the caller's
       codepage tables; here the raw code point is kept when it is already
       a valid character (the common case for round-tripped text). */
    .replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (_m, page: string, h: string) =>
      decodeMif(Number(page), parseInt(h, 16)))
    .replace(/\\[Uu]\+([0-9A-Fa-f]{4})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)))
    .replace(/%%(%|\d{1,3}|[A-Za-z])/g, (m, code: string) => {
      if (code === '%') return '%';
      if (code >= '0' && code <= '9') {
        const n = parseInt(code, 10);
        if (n >= 32 && n <= 255) {
          return (n >= 0x80 && n <= 0x9F)
            ? String.fromCharCode(CP1252_HIGH[n - 0x80]) : String.fromCharCode(n);
        }
        return '';
      }
      const c = code.toLowerCase();
      if (c === 'd') return '°';
      if (c === 'c') return 'Ø';
      if (c === 'p') return '±';
      if (c === 'u' || c === 'o') return '';
      return m;                            /* unknown %%x — keep literally */
    }));
};

/** Writer-side symbol substitution (° Ø ± -> %%d %%c %%p). */
export const encodeCadSymbols = (v: unknown): string =>
  String(v == null ? '' : v)
    .replace(/°/g, '%%d')
    .replace(/Ø/g, '%%c')
    .replace(/±/g, '%%p');

/** Escape every character above ASCII as \U+XXXX (codepage-safe transport
 *  for ASCII DXF). */
export const escapeUnicode = (s: string): string => {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    r += (cu > 126)
      ? '\\U+' + cu.toString(16).toUpperCase().padStart(4, '0')
      : s[i];
  }
  return r;
};

/** Strip MTEXT inline formatting codes down to plain text with \n breaks. */
export const stripMtextCodes = (s: string): string => {
  const BSL = String.fromCharCode(1);      /* placeholder for escaped \\ */
  return String(s)
    .replace(/\\\\/g, BSL)
    .replace(/\\P/gi, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\[LOKlok]/g, '')
    .replace(/\\[ACHQTWFfpx][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(new RegExp(BSL, 'g'), '\\');
};
