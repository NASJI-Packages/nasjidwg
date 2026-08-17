/* nasjidwg — SHX shape fonts: parser, vectorizer, registry, exporters.
 *
 * Repo rule: no shipped binaries — every font here is built byte for
 * byte in the test, so each assertion pins the format itself.
 */

import { describe, expect, it } from 'vitest';
import { parseShx, registerShxFont, findShxFont } from '../src/text/shx.js';
import { writeSvg } from '../src/export/svg.js';
import { writePdf } from '../src/export/pdf.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

const A = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const asciiz = (s: string): number[] => [...A(s), 0];
const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];

/* ---- a classic "AutoCAD-86 shapes 1.0" font, hand-assembled ---- *
 * above 4, below 1. Glyphs exercise every drawing bytecode:
 *   I  73: one pen-down vector (0,0)-(0,4)              [vector byte]
 *   J  74: subshape I, then a second stroke              [0x07]
 *   L  76: two strokes with pen up/down moves            [0x01 0x02 0x08]
 *   O  79: full-circle octant arc, r=2, centre (2,2)     [0x0A]
 *   Q  81: quarter fractional arc, r=2, centre (2,0)     [0x0B]
 *   V  86: an 0x0E-guarded command that must be skipped  [0x0E]
 *   W  87: scale x2 / /2 and push/pop location           [0x03 0x04 0x05 0x06]
 *   Z  90: 0x09 pair run, then a bulge-127 semicircle    [0x09 0x0C]
 */
const buildClassicShx = (): Uint8Array => {
  const shapes: [number, string, number[]][] = [
    [0, 'testfont', [4, 1, 0, 0]],
    [73, 'uci', [0x44, 0x02, 0x08, 2, 0xfc, 0]],
    [74, 'ucj', [0x07, 73, 0x01, 0x44, 0x02, 0x08, 2, 0xfc, 0]],
    [76, 'ucl', [0x02, 0x08, 0, 4, 0x01, 0x4c,
      0x02, 0x08, 1, 0, 0x01, 0x08, 0, 2,
      0x02, 0x08, 2, 0xfe, 0]],
    [79, 'uco', [0x02, 0x08, 4, 2, 0x01, 0x0a, 2, 0x00,
      0x02, 0x08, 2, 0xfe, 0]],
    [81, 'ucq', [0x02, 0x08, 4, 0, 0x01, 0x0b, 0, 0, 0, 2, 0x02,
      0x02, 0x08, 2, 0xfe, 0]],
    [86, 'ucv', [0x0e, 0x08, 0, 0x9c, 0x24, 0x02, 0x08, 1, 0xfe, 0]],
    [87, 'ucw', [0x04, 2, 0x14, 0x05, 0x24, 0x06, 0x10, 0x03, 2,
      0x02, 0x08, 1, 0xfe, 0]],
    [90, 'ucz', [0x09, 2, 0, 0, 2, 0, 0, 0x0c, 2, 0, 127,
      0x02, 0x08, 1, 0xfe, 0]]
  ];
  const dir: number[] = [];
  const blocks: number[] = [];
  for (const [code, name, data] of shapes) {
    const block = [...asciiz(name), ...data];
    dir.push(...u16(code), ...u16(block.length));
    blocks.push(...block);
  }
  return Uint8Array.from([
    ...A('AutoCAD-86 shapes 1.0'), 0x0d, 0x0a, 0x1a,
    ...u16(0), ...u16(90), ...u16(shapes.length),
    ...dir, ...blocks
  ]);
};

/* ---- a unifont: u32 record count, inline (u16 code, u16 len) records.
 * above 6, below 2; 'A', a u16 subshape of it, and an Arabic isolated
 * beh (U+FE8F) so shaped text can hit a real glyph. ---- */
const buildUnifontShx = (): Uint8Array => {
  const recs: [number, string, number[]][] = [
    [0, 'unitest', [6, 2, 0, 0, 0, 0]],
    [0x41, 'uniA', [0x64, 0x02, 0x08, 3, 0xfa, 0]],
    [0x42, 'uniB', [0x07, 0x00, 0x41, 0]],
    [0xfe8f, 'beh', [0x30, 0x02, 0x08, 1, 0, 0]]
  ];
  const body: number[] = [];
  for (const [code, name, data] of recs) {
    const block = [...asciiz(name), ...data];
    body.push(...u16(code), ...u16(block.length), ...block);
  }
  const n = recs.length;
  return Uint8Array.from([
    ...A('AutoCAD-86 unifont 1.0'), 0x0d, 0x0a, 0x1a,
    n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff,
    ...body
  ]);
};

/* a drawing with one line (stable bounds) and one styled text entity */
const textDrawing = (
  styleFont: string, text: string, extra: Record<string, unknown> = {}
): Drawing => {
  const d = emptyDrawing();
  d.textStyles.push({ name: 'S1', font: styleFont });
  d.entities.push({
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 50, z: 0 }
  } as Entity, {
    type: 'text', layer: '0', color: { kind: 'byLayer' },
    position: { x: 10, y: 20, z: 0 }, text, height: 8, rotation: 0,
    style: 'S1', ...extra
  } as Entity);
  return d;
};

/* captured before ANY registration in this file: the inertness snapshot */
const inertDrawing = textDrawing('neverregistered.shx', 'I');
const svgBeforeAnyRegistration = writeSvg(inertDrawing);

describe('parseShx: classic shapes format', () => {
  const font = parseShx(buildClassicShx())!;

  it('reads the font description from shape 0', () => {
    expect(font).not.toBeNull();
    expect(font.name).toBe('testfont');
    expect(font.above).toBe(4);
    expect(font.below).toBe(1);
  });

  it('vectorizes a plain stroke and its advance (I)', () => {
    const g = font.glyph(73)!;
    expect(g.paths).toEqual([[{ x: 0, y: 0 }, { x: 0, y: 4 }]]);
    expect(g.advance).toBe(2);
  });

  it('caches vectorized glyphs', () => {
    expect(font.glyph(73)).toBe(font.glyph(73));
  });

  it('returns undefined for a code the font lacks', () => {
    expect(font.glyph(65)).toBeUndefined();
    expect(font.glyph(0)).toBeUndefined();     /* shape 0 is not a glyph */
  });

  it('pen up/down and 0x08 displacements make two strokes (L)', () => {
    const g = font.glyph(76)!;
    expect(g.paths).toEqual([
      [{ x: 0, y: 4 }, { x: 0, y: 0 }],
      [{ x: 1, y: 0 }, { x: 1, y: 2 }]
    ]);
    expect(g.advance).toBe(3);
  });

  it('octant arc: a full circle closes on its start (O)', () => {
    const g = font.glyph(79)!;
    expect(g.advance).toBe(6);
    expect(g.paths.length).toBe(1);
    const ring = g.paths[0];
    expect(ring.length).toBe(17);              /* ~16 segments per circle */
    expect(ring[0]).toEqual({ x: 4, y: 2 });
    expect(ring[16].x).toBeCloseTo(4, 9);
    expect(ring[16].y).toBeCloseTo(2, 9);
    for (const p of ring) {
      expect(Math.hypot(p.x - 2, p.y - 2)).toBeCloseTo(2, 9);
    }
  });

  it('fractional arc: a quarter turn spans two octants (Q)', () => {
    const g = font.glyph(81)!;
    expect(g.advance).toBe(4);
    const arc = g.paths[0];
    expect(arc.length).toBe(5);                /* 90° at 16/circle = 4 segs */
    expect(arc[0]).toEqual({ x: 4, y: 0 });
    expect(arc[4].x).toBeCloseTo(2, 9);
    expect(arc[4].y).toBeCloseTo(2, 9);
    for (const p of arc) {
      expect(Math.hypot(p.x - 2, p.y - 0)).toBeCloseTo(2, 9);
    }
  });

  it('0x09 pair run then a bulge-127 semicircle (Z)', () => {
    const g = font.glyph(90)!;
    expect(g.advance).toBe(5);
    expect(g.paths.length).toBe(1);
    const pts = g.paths[0];
    expect(pts.slice(0, 3)).toEqual(
      [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }]);
    const last = pts[pts.length - 1];
    expect(last.x).toBeCloseTo(4, 9);
    expect(last.y).toBeCloseTo(2, 9);
    /* the arc bows below the chord (positive bulge sweeps CCW, matching
       the polyline flattener), bottoming out one unit down */
    const arc = pts.slice(3);
    expect(Math.min(...arc.map((p) => p.y))).toBeCloseTo(1, 9);
    for (const p of arc) {
      expect(Math.hypot(p.x - 3, p.y - 2)).toBeCloseTo(1, 9);
    }
  });

  it('0x0E skips the next command in horizontal rendering (V)', () => {
    const g = font.glyph(86)!;
    expect(g.paths).toEqual([[{ x: 0, y: 0 }, { x: 0, y: 2 }]]);
    expect(g.advance).toBe(1);
  });

  it('scale multiply/divide and push/pop location (W)', () => {
    const g = font.glyph(87)!;
    expect(g.paths).toEqual([
      [{ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 0, y: 6 }],
      [{ x: 0, y: 2 }, { x: 2, y: 2 }]
    ]);
    expect(g.advance).toBe(3);
  });

  it('subshapes execute inline and share pen state (J)', () => {
    const g = font.glyph(74)!;
    expect(g.paths).toEqual([
      [{ x: 0, y: 0 }, { x: 0, y: 4 }],
      [{ x: 2, y: 0 }, { x: 2, y: 4 }]
    ]);
    expect(g.advance).toBe(4);
  });
});

describe('parseShx: unifont format', () => {
  const font = parseShx(buildUnifontShx())!;

  it('reads metrics from record 0', () => {
    expect(font).not.toBeNull();
    expect(font.name).toBe('unitest');
    expect(font.above).toBe(6);
    expect(font.below).toBe(2);
  });

  it('keys glyphs by Unicode code point', () => {
    const g = font.glyph(0x41)!;
    expect(g.paths).toEqual([[{ x: 0, y: 0 }, { x: 0, y: 6 }]]);
    expect(g.advance).toBe(3);
    const beh = font.glyph(0xfe8f)!;
    expect(beh.paths).toEqual([[{ x: 0, y: 0 }, { x: 3, y: 0 }]]);
    expect(beh.advance).toBe(4);
  });

  it('subshape references are two bytes wide', () => {
    const g = font.glyph(0x42)!;
    expect(g.paths).toEqual([[{ x: 0, y: 0 }, { x: 0, y: 6 }]]);
    expect(g.advance).toBe(3);
  });
});

describe('parseShx: hostile input', () => {
  it('returns null on foreign bytes', () => {
    expect(parseShx(new Uint8Array(0))).toBeNull();
    expect(parseShx(Uint8Array.from([1, 2, 3, 4, 5]))).toBeNull();
    expect(parseShx(Uint8Array.from(A('%PDF-1.4 not a font at all here')))).toBeNull();
    /* right header, impossible directory */
    expect(parseShx(Uint8Array.from(
      [...A('AutoCAD-86 shapes 1.0'), 0x0d, 0x0a, 0x1a, 0xff, 0xff]))).toBeNull();
  });

  it('never throws on any truncation of a valid file', () => {
    for (const full of [buildClassicShx(), buildUnifontShx()]) {
      for (let n = 0; n < full.length; n++) {
        let r: unknown = 'unset';
        expect(() => { r = parseShx(full.subarray(0, n)); }).not.toThrow();
        expect(r).toBeNull();
      }
    }
  });
});

describe('font registry', () => {
  it('matches case-insensitively, .shx and path optional', () => {
    const f = registerShxFont(buildClassicShx(), ['ARIALSHX']);
    expect(f).not.toBeNull();
    expect(findShxFont('arialshx')).toBe(f);
    expect(findShxFont('ArialShx.shx')).toBe(f);
    expect(findShxFont('ARIALSHX.SHX')).toBe(f);
    expect(findShxFont('C:\\Fonts\\arialshx.shx')).toBe(f);
    expect(findShxFont('fonts/ARIALSHX.shx')).toBe(f);
    expect(findShxFont('TESTFONT')).toBe(f);   /* its own shape-0 name */
    expect(findShxFont('somethingelse.shx')).toBeUndefined();
    expect(findShxFont(undefined)).toBeUndefined();
  });

  it('rejects foreign bytes without registering anything', () => {
    expect(registerShxFont(Uint8Array.from([9, 9, 9]), ['bogus'])).toBeNull();
    expect(findShxFont('bogus')).toBeUndefined();
  });
});

describe('SVG export with SHX fonts', () => {
  it('renders styled text as strokes at position and scale', () => {
    const d = textDrawing('strokefontA.shx', 'I');
    const before = writeSvg(d);
    expect(before).toContain('<text');         /* not yet registered */
    registerShxFont(buildClassicShx(), ['strokefontA']);
    const after = writeSvg(d);
    expect(after).not.toContain('<text');
    /* height 8 over cap height 4 doubles the glyph: (10,20)-(10,28) */
    expect(after).toContain('M10,-20 L10,-28');
  });

  it('a missing glyph fails the whole string, never half-and-half', () => {
    const d = textDrawing('strokefontA.shx', 'IX');   /* no X in the font */
    const svg = writeSvg(d);
    expect(svg).toContain('<text');
    expect(svg).toContain('IX');
    expect(svg).not.toContain('M10,-20 L10,-28');
  });

  it('applies width factor to x only', () => {
    const d = textDrawing('strokefontA.shx', 'L', {
      position: { x: 0, y: 0, z: 0 }, height: 4, widthFactor: 2
    });
    const svg = writeSvg(d);
    expect(svg).toContain('M0,-4 L0,0');       /* the x=0 stroke is fixed */
    expect(svg).toContain('M2,0 L2,-2');       /* the x=1 stroke doubles */
  });

  it('applies rotation about the insertion point', () => {
    const d = textDrawing('strokefontA.shx', 'I', {
      position: { x: 0, y: 0, z: 0 }, height: 4, rotation: Math.PI / 2
    });
    expect(writeSvg(d)).toContain('M0,0 L-4,0');
  });

  it('applies oblique as a shear', () => {
    const d = textDrawing('strokefontA.shx', 'I', {
      position: { x: 0, y: 0, z: 0 }, height: 4, oblique: Math.PI / 4
    });
    expect(writeSvg(d)).toContain('M0,0 L4,-4');
  });

  it('anchors right-justified text at its end', () => {
    const d = textDrawing('strokefontA.shx', 'I', {
      position: { x: 0, y: 0, z: 0 }, height: 4, halign: 'right'
    });
    expect(writeSvg(d)).toContain('M-2,0 L-2,-4');   /* advance 2 shifts back */
  });

  it('stacks MTEXT lines 1.25 heights apart', () => {
    const d = textDrawing('strokefontA.shx', 'I\nI', {
      type: 'mtext', height: 8
    });
    const svg = writeSvg(d);
    expect(svg).toContain('M10,-20 L10,-28');
    expect(svg).toContain('M10,-10 L10,-18');  /* 10 units further down */
  });

  it('shapes Arabic before glyph lookup (presentation forms hit)', () => {
    registerShxFont(buildUnifontShx(), ['arabvec']);
    const d = textDrawing('arabvec.shx', 'ب', { height: 12 });
    const svg = writeSvg(d);
    /* logical beh shapes to isolated U+FE8F: a 3-unit baseline stroke at
       twice size (height 12 over cap 6) */
    expect(svg).not.toContain('<text');
    expect(svg).toContain('M10,-20 L16,-20');
  });

  it('is byte-identical for styles whose font was never registered', () => {
    const again = writeSvg(inertDrawing);
    expect(again).toBe(svgBeforeAnyRegistration);
    expect(again).toContain('<text');
  });
});

describe('PDF export with SHX fonts', () => {
  const latin1 = (r: { data: Uint8Array }): string =>
    new TextDecoder('latin1').decode(r.data);

  it('replaces Tj text with stroked paths', () => {
    registerShxFont(buildClassicShx(), ['strokefontA']);
    const d = textDrawing('strokefontA.shx', 'I');
    const pdf = latin1(writePdf(d));
    expect(pdf).not.toContain('(I) Tj');
    const unregistered = latin1(writePdf(textDrawing('nope.shx', 'I')));
    expect(unregistered).toContain('(I) Tj');
  });

  it('covers text the standard fonts cannot encode (nothing skipped)', () => {
    registerShxFont(buildUnifontShx(), ['arabvec']);
    const d = textDrawing('arabvec.shx', 'ب', { height: 12 });
    const res = writePdf(d);
    expect(res.skipped).toEqual([]);
    /* without the font the entity is skipped as before */
    const bare = writePdf(textDrawing('nope.shx', 'ب', { height: 12 }));
    expect(bare.skipped.length).toBe(1);
  });
});
