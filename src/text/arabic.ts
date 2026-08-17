/* nasjidwg — Arabic text pipeline.
 *
 * CAD files and CAD renderers are hostile territory for Arabic:
 *
 *  - Many renderers (AutoCAD's TEXT engine included) break the joining of
 *    logical Arabic that arrives through escape sequences: the word draws
 *    with disconnected letters. Shaping the text into Unicode Presentation
 *    Forms-B (U+FB50..U+FEFC) bakes the joining into the codepoints
 *    themselves, so every reader draws the word connected no matter how its
 *    shaper behaves.
 *  - CAD bidi implementations position brackets but never mirror the glyph,
 *    so an RTL "(text)" draws inside-out. On RTL lines we swap each matched
 *    bracket pair that encloses Arabic; the importer swaps them back.
 *
 * The document model always holds LOGICAL Arabic. Shaping happens on the
 * way out (writers), unshaping on the way in (readers) — and only for text
 * that carries our presentation-forms signature, so native logical Arabic
 * from other producers passes through untouched.
 */

/** codepoint -> [isolated, final, initial, medial] presentation forms. */
const AR_FORMS: Record<number, number[]> = {};
([
  [0x0626, 0xFE89], [0x0628, 0xFE8F], [0x062A, 0xFE95], [0x062B, 0xFE99],
  [0x062C, 0xFE9D], [0x062D, 0xFEA1], [0x062E, 0xFEA5], [0x0633, 0xFEB1],
  [0x0634, 0xFEB5], [0x0635, 0xFEB9], [0x0636, 0xFEBD], [0x0637, 0xFEC1],
  [0x0638, 0xFEC5], [0x0639, 0xFEC9], [0x063A, 0xFECD], [0x0641, 0xFED1],
  [0x0642, 0xFED5], [0x0643, 0xFED9], [0x0644, 0xFEDD], [0x0645, 0xFEE1],
  [0x0646, 0xFEE5], [0x0647, 0xFEE9], [0x064A, 0xFEF1]
] as const).forEach(([cp, b]) => { AR_FORMS[cp] = [b, b + 1, b + 2, b + 3]; });
([
  [0x0622, 0xFE81], [0x0623, 0xFE83], [0x0624, 0xFE85], [0x0625, 0xFE87],
  [0x0627, 0xFE8D], [0x0629, 0xFE93], [0x062F, 0xFEA9], [0x0630, 0xFEAB],
  [0x0631, 0xFEAD], [0x0632, 0xFEAF], [0x0648, 0xFEED], [0x0649, 0xFEEF]
] as const).forEach(([cp, b]) => { AR_FORMS[cp] = [b, b + 1]; });
AR_FORMS[0x0621] = [0xFE80];                          /* ء never joins       */
AR_FORMS[0x0640] = [0x0640, 0x0640, 0x0640, 0x0640];  /* tatweel joins both  */

/** lam + alef ligatures: alef codepoint -> [isolated, final]. */
const LAM_ALEF: Record<number, [number, number]> = {
  0x0622: [0xFEF5, 0xFEF6], 0x0623: [0xFEF7, 0xFEF8],
  0x0625: [0xFEF9, 0xFEFA], 0x0627: [0xFEFB, 0xFEFC]
};

/** Transparent (joining-neutral) marks: harakat + superscript alef. */
const isTransparent = (cp: number): boolean =>
  (cp >= 0x064B && cp <= 0x065F) || cp === 0x0670;

/** Shape logical Arabic into Presentation Forms-B. Non-Arabic text is
 *  returned unchanged. */
export const shapeArabic = (s: string): string => {
  if (!/[ء-ي]/.test(s)) return s;
  const src = Array.from(String(s));
  const out: string[] = [];
  let prevJoins = false;                  /* previous glyph joins forward */
  for (let i = 0; i < src.length; i++) {
    const cp = src[i].codePointAt(0)!;
    if (isTransparent(cp)) { out.push(src[i]); continue; }
    const f = AR_FORMS[cp];
    if (!f) { out.push(src[i]); prevJoins = false; continue; }
    if (cp === 0x0644 && i + 1 < src.length) {
      const la = LAM_ALEF[src[i + 1].codePointAt(0)!];
      if (la) {
        out.push(String.fromCharCode(prevJoins ? la[1] : la[0]));
        i++;                              /* the alef is consumed */
        prevJoins = false;
        continue;
      }
    }
    const dual = f.length === 4;
    let nextAccepts = false;
    for (let j = i + 1; j < src.length; j++) {
      const nc = src[j].codePointAt(0)!;
      if (isTransparent(nc)) continue;
      const nf = AR_FORMS[nc];
      nextAccepts = !!(nf && nf.length >= 2);
      break;
    }
    const idx = (dual && nextAccepts) ? (prevJoins ? 3 : 2) : (prevJoins ? 1 : 0);
    out.push(String.fromCharCode(f[Math.min(idx, f.length - 1)]));
    prevJoins = dual && nextAccepts;
  }
  return out.join('');
};

const AR_UNSHAPE: Record<number, string> = {};
for (const cpStr of Object.keys(AR_FORMS)) {
  const cp = Number(cpStr);
  for (const fm of AR_FORMS[cp]) {
    if (fm !== 0x0640) AR_UNSHAPE[fm] = String.fromCharCode(cp);
  }
}
for (const cpStr of Object.keys(LAM_ALEF)) {
  const cp = Number(cpStr);
  for (const fm of LAM_ALEF[cp]) {
    AR_UNSHAPE[fm] = 'ل' + String.fromCharCode(cp);   /* lam + alef */
  }
}

/** Undo shapeArabic: presentation forms back to logical letters. */
export const unshapeArabic = (s: string): string => (/[ﭐ-ﻼ]/.test(s)
  ? s.replace(/[ﭐ-ﻼ]/g, (ch) => AR_UNSHAPE[ch.charCodeAt(0)] ?? ch)
  : s);

/* Bracket mirroring (UAX#9 N0-lite). CAD renderers position brackets with
   their bidi but never mirror the glyph, so an RTL "(كذا)" draws inside-out.
   On RTL lines the writer swaps each matched pair that encloses Arabic; the
   reader (recognizing our pre-shaped text) swaps them back. */
const BRACKET_MIRROR: Record<string, string> = {
  '(': ')', ')': '(', '[': ']', ']': '[',
  '{': '}', '}': '{', '<': '>', '>': '<'
};

const strongDirOf = (cp: number): 'R' | 'L' | null =>
  ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0xFB50 && cp <= 0xFEFC)) ? 'R'
    : ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) ? 'L' : null;

const mirrorBracketsLine = (line: string, invert: boolean): string => {
  if (!/[()[\]{}<>]/.test(line)) return line;
  let dir: 'R' | 'L' | null = null;
  for (const ch of line) {
    dir = strongDirOf(ch.codePointAt(0)!);
    if (dir) break;
  }
  if (dir !== 'R') return line;           /* LTR lines stay logical */
  const OPEN = invert ? ')]}>' : '([{<';
  const CLOSE = invert ? '([{<' : ')]}>';
  const chars = Array.from(line);
  const stack: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (OPEN.indexOf(chars[i]) >= 0) { stack.push(i); continue; }
    if (CLOSE.indexOf(chars[i]) >= 0 && stack.length) {
      const j = stack.pop()!;
      let hasArabic = false;
      for (let k = j + 1; k < i && !hasArabic; k++) {
        hasArabic = strongDirOf(chars[k].codePointAt(0)!) === 'R';
      }
      if (hasArabic) {
        chars[j] = BRACKET_MIRROR[chars[j]];
        chars[i] = BRACKET_MIRROR[chars[i]];
      }
    }
  }
  return chars.join('');
};

/** Mirror matched bracket pairs on RTL lines (invert=true to undo). */
export const mirrorBrackets = (s: string, invert = false): string =>
  s.split('\n').map((l) => mirrorBracketsLine(l, invert)).join('\n');

/** Reader-side normalization: only text carrying our presentation-forms
 *  signature is unshaped + unmirrored; native logical Arabic from other
 *  producers passes through untouched. */
export const normalizeIncomingText = (t: string): string =>
  (/[ﭐ-ﻼ]/.test(t) ? mirrorBrackets(unshapeArabic(t), true) : t);

/** True when the string contains any complex-script run (Arabic, Hebrew,
 *  and friends) that needs the MTEXT path to keep its joining. */
export const hasComplexScript = (s: string): boolean =>
  /[֐-ࣿיִ-ﻼ]/.test(s);
