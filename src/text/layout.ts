/* nasjidwg — MTEXT paragraph layout, shared by the SVG and PDF exporters.
 *
 * The model stores an MTEXT as a raw inline-coded stream plus a stripped
 * plain text; neither is what a viewer paints. This module turns the
 * entity into positioned lines the way a CAD viewer lays them out:
 * \P starts a new paragraph, the reference-rectangle width word-wraps
 * rows, the attachment point anchors the block, and Arabic is shaped
 * BEFORE the wrap so a line break can never split a joined form.
 *
 * Widths are estimates unless the entity's style resolves to a registered
 * SHX font, in which case the real glyph advances are used — the same
 * advances the stroke renderer will draw with.
 */

import type { MTextEntity, TextStyle } from '../core/model.js';
import { parseMtext } from './mtext.js';
import { findShxFont, type ShxFont } from './shx.js';
import { shapeArabic } from './arabic.js';

export interface MtextLayoutLine {
  /** Characters to draw, in logical order (Arabic already shaped). */
  text: string;
  /** Drop from the entity position down to this line's baseline,
   *  drawing units (positive = further down the page). */
  dy: number;
  /** Estimated advance width of the line, drawing units. */
  width: number;
}

export interface MtextLayout {
  lines: MtextLayoutLine[];
  /** Baseline-to-baseline distance, drawing units. */
  lineStep: number;
  /** Horizontal anchor derived from the attachment point. */
  align: 'left' | 'center' | 'right';
  /** Nominal text height the lines are drawn at. */
  height: number;
}

interface Char { ch: string; w: number }

/* Logical Arabic letters — presence means the paragraph must be shaped
 * as one string before any measuring or wrapping happens. */
const ARABIC_RE = /[ء-ي]/;

/** Advance of one character at a given height: the real SHX glyph
 *  advance when the style's font is registered (matching what the stroke
 *  renderer draws), 0.72 × height as the flat estimate otherwise. */
const advanceOf = (
  font: ShxFont | undefined, ch: string, height: number
): number => {
  if (font) {
    const above = font.above > 0 ? font.above : 1;
    const cp = ch.codePointAt(0)!;
    const g = font.glyph(cp);
    if (g) return (g.advance / above) * height;
    /* the stroke renderer synthesizes a space as one cap height of
       pure advance; mirror that so wrap points agree with the drawing */
    if (cp === 0x20 || cp === 0x09) return height;
  }
  return 0.72 * height;
};

/** Greedy word wrap of one paragraph into rows no wider than
 *  `wrapWidth`. Spaces at a break point are consumed by the break;
 *  leading spaces indent the paragraph's first row; a single word wider
 *  than the rectangle hard-breaks mid-word (as AutoCAD does). */
const wrapParagraph = (
  chars: Char[], wrapWidth: number
): { text: string; width: number }[] => {
  const widthOf = (cs: readonly Char[]): number =>
    cs.reduce((s, c) => s + c.w, 0);
  if (!(wrapWidth > 0)) {
    return [{ text: chars.map((c) => c.ch).join(''), width: widthOf(chars) }];
  }
  const rows: { text: string; width: number }[] = [];
  let line: Char[] = [];
  let lineW = 0;
  const flushRow = (): void => {
    rows.push({ text: line.map((c) => c.ch).join(''), width: lineW });
    line = [];
    lineW = 0;
  };
  let i = 0;
  let first = true;
  while (i < chars.length) {
    /* one token: the run of spaces before a word, then the word */
    let gap: Char[] = [];
    while (i < chars.length && chars[i].ch === ' ') gap.push(chars[i++]);
    const word: Char[] = [];
    while (i < chars.length && chars[i].ch !== ' ') word.push(chars[i++]);
    if (first) {
      if (gap.length) { line.push(...gap); lineW += widthOf(gap); }
      gap = [];
      first = false;
    }
    if (!word.length) continue;         /* trailing spaces never draw */
    const joinW = line.length && gap.length ? widthOf(gap) : 0;
    const wordW = widthOf(word);
    if (line.length && lineW + joinW + wordW > wrapWidth) {
      flushRow();                       /* the break eats the joining gap */
    } else if (joinW) {
      line.push(...gap);
      lineW += joinW;
    }
    if (!line.length && wordW > wrapWidth) {
      for (const c of word) {
        if (line.length && lineW + c.w > wrapWidth) flushRow();
        line.push(c);
        lineW += c.w;
      }
      continue;
    }
    line.push(...word);
    lineW += wordW;
  }
  flushRow();                           /* an empty paragraph is a blank row */
  return rows;
};

/** Lay an MTEXT entity out as positioned lines. Fragments come from
 *  `parseMtext` on the raw stream (falling back to the plain text), so
 *  per-fragment heights weight the advance estimates; the entity's width
 *  wraps when set and positive, and the attachment point (1..9, top-left
 *  default — matching what the exporters always did) anchors the block. */
export const layoutMtext = (
  entity: MTextEntity, styles: readonly TextStyle[]
): MtextLayout => {
  const base = entity.height > 0 ? entity.height : 5;
  const styleName = (entity.style ?? 'Standard').toLowerCase();
  const rec = styles.find((s) => s.name.toLowerCase() === styleName);
  const font = findShxFont(rec?.font);
  const wf = rec?.widthFactor && rec.widthFactor > 0 ? rec.widthFactor : 1;

  /* fragments -> paragraphs of (text, height) runs; \P flags and literal
     newlines both end a paragraph (the plain-text form uses \n) */
  interface Run { text: string; height: number }
  const paragraphs: Run[][] = [[]];
  for (const f of parseMtext(entity.raw ?? entity.text)) {
    if (f.newParagraph) paragraphs.push([]);
    const h = f.height && f.height > 0 ? f.height
      : f.heightFactor && f.heightFactor > 0 ? f.heightFactor * base : base;
    const text = f.stacked ? f.stacked.upper + '/' + f.stacked.lower : f.text;
    const parts = text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) paragraphs.push([]);
      if (parts[p]) {
        paragraphs[paragraphs.length - 1].push({ text: parts[p], height: h });
      }
    }
  }

  const wrapWidth = entity.width && entity.width > 0 ? entity.width : 0;
  const rows: { text: string; width: number }[] = [];
  for (const runs of paragraphs) {
    const chars: Char[] = [];
    const joined = runs.map((r) => r.text).join('');
    if (ARABIC_RE.test(joined)) {
      /* Arabic joins across fragment boundaries, so the paragraph shapes
         as one string — a wrap can then only ever fall between already
         joined forms. Mixed run heights collapse to the tallest. */
      const h = runs.reduce((m, r) => Math.max(m, r.height), 0) || base;
      for (const ch of shapeArabic(joined)) {
        chars.push({ ch, w: advanceOf(font, ch, h) * wf });
      }
    } else {
      for (const r of runs) {
        for (const ch of r.text) {
          chars.push({ ch, w: advanceOf(font, ch, r.height) * wf });
        }
      }
    }
    rows.push(...wrapParagraph(chars, wrapWidth));
  }

  /* MTEXT's default line spacing is 5/3 of the text height. The model
     carries no MTEXT line-spacing factor, so the default stands. */
  const lineStep = (5 / 3) * base;
  const att = entity.attachment ?? 1;
  const align: MtextLayout['align'] =
    att === 2 || att === 5 || att === 8 ? 'center'
      : att === 3 || att === 6 || att === 9 ? 'right' : 'left';
  /* vertical anchor: the first baseline sits at the entity position for
     the top row of attachment points (the exporters' historic anchor);
     middle and bottom rows raise the whole block accordingly */
  const blockDrop = (rows.length - 1) * lineStep;
  const rise = att >= 7 ? blockDrop : att >= 4 ? blockDrop / 2 : 0;
  return {
    lines: rows.map((r, i) => ({
      text: r.text, width: r.width, dy: i * lineStep - rise
    })),
    lineStep,
    align,
    height: base
  };
};
