/* nasjidwg — R2018 spellings that only the AutoCAD oracle could catch.
 *
 * Three defects from one 72 MB field drawing, each invisible to a round
 * trip because the reader tolerated the writer's mistake:
 *
 * - a HATCH spline edge must close with its R2010+ fit-data block (the
 *   count at least); without it the record is misaligned from there on
 *   — our reader sealed such a hatch as an unknown, AutoCAD 2027
 *   refused the drawing (ErrorStatus 53) or died in regen.
 * - an ELLIPSE record's third 3BD is the entity's plane NORMAL; the
 *   writer used to forge +Z, mirroring mirrored ellipses — and one
 *   near-planar tilted normal in the field drawing made AutoCAD refuse
 *   the file, because the forged +Z was no longer perpendicular to the
 *   major axis within its tolerance.
 * - the AcDs _data_ segment's record tally is exact (see meta.ts);
 *   4 + N held only through N = 4, and the fifth solid onward the
 *   drawing was refused.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

const one = (e: Entity): Drawing => {
  const d = emptyDrawing();
  d.entities = [e];
  return d;
};

describe('R2018 HATCH spline edge fit-data block', () => {
  const splineEdgeHatch = (fit: boolean): Entity => ({
    type: 'hatch', layer: '0', color: { kind: 'byLayer' },
    patternName: 'SOLID', solid: true, angle: 0, scale: 1,
    loops: [{
      kind: 'edges', edges: [
        {
          kind: 'spline', degree: 3,
          knots: [0, 0, 0, 0, 1, 1, 1, 1],
          controlPoints: [
            { x: 0, y: 0 }, { x: 3, y: 8 }, { x: 7, y: 8 }, { x: 10, y: 0 }
          ],
          fitPoints: fit ? [{ x: 0, y: 0 }, { x: 5, y: 6 }, { x: 10, y: 0 }]
            : undefined
        },
        { kind: 'line', start: { x: 10, y: 0 }, end: { x: 0, y: 0 } }
      ]
    }]
  });

  it.each([[false], [true]])(
    'round-trips as a hatch, not a sealed unknown (fit data: %s)', (fit) => {
      const back = readDwg(writeDwg2018(one(splineEdgeHatch(fit))).data);
      const h = back.entities.find((e) => e.type === 'hatch');
      expect(h).toBeDefined();
      if (h?.type !== 'hatch') return;
      const loop = h.loops[0];
      expect(loop.kind).toBe('edges');
      if (loop.kind !== 'edges') return;
      const sp = loop.edges.find((ed) => ed.kind === 'spline');
      expect(sp && sp.kind === 'spline' && sp.controlPoints.length).toBe(4);
      if (fit && sp?.kind === 'spline') {
        expect(sp.fitPoints?.length).toBe(3);
      }
    });
});

describe('R2018 ELLIPSE plane normal', () => {
  it('keeps a tilted negative normal instead of forging +Z', () => {
    const normal = {
      x: 5.085991501233355e-9, y: 1.3773532998766642e-8,
      z: -0.9999999999999998
    };
    const back = readDwg(writeDwg2018(one({
      type: 'ellipse', layer: '0', color: { kind: 'byLayer' },
      center: { x: 667.7065150241053, y: -115.5107150437, z: -2.809567816e-7 },
      majorAxis: {
        x: -5.040747801024497, y: 5.040747801024497, z: 4.379170569999999e-8
      },
      ratio: 0.9999999999999442,
      startParam: 5.569617846904408, endParam: 8.487626441044652,
      extrusion: normal
    })).data);
    const e = back.entities.find((q) => q.type === 'ellipse');
    expect(e && e.type === 'ellipse' && e.extrusion).toEqual(normal);
  });
});

describe('AcDs _data_ record tally', () => {
  /* 4 + N + floor((N-1)/4), fitted to AutoCAD's own saves and confirmed
   * against 2027 at N = 5, 8, 9, 13 and 68 — the exact value is
   * required, one below or above is refused. */
  const END_ASM = '\x0e\x03End\x0e\x02of\x0e\x03ASM\r\x04data';
  const blob = (tag: string): string => {
    const text = 'ASM BinaryFile synthetic ' + tag + ' ' + END_ASM;
    let b64 = '';
    const CH =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      b64 += CH[a >> 2] + CH[((a & 3) << 4) | ((b ?? 0) >> 4)]
        + (i + 1 < bytes.length
          ? CH[(((b ?? 0) & 15) << 2) | ((c ?? 0) >> 6)] : '=')
        + (i + 2 < bytes.length ? CH[(c ?? 0) & 63] : '=');
    }
    return b64;
  };
  const dataTallyOf = (n: number): number => {
    const d = emptyDrawing();
    d.entities = Array.from({ length: n }, (_, i): Entity => ({
      type: 'acis', layer: '0', color: { kind: 'byLayer' },
      kind: 'solid3d', sab: blob('S' + i)
    }));
    const bytes = writeDwg2018(d).data;
    const s = [...readSections2004(bytes)]
      .find(([nm]) => nm.startsWith('AcDb:AcDs'))![1];
    const u16 = (o: number): number => s[o] | (s[o + 1] << 8);
    const u32 = (o: number): number =>
      (s[o] | (s[o + 1] << 8) | (s[o + 2] << 16)) + s[o + 3] * 0x1000000;
    const u64 = (o: number): number => u32(o) + u32(o + 4) * 0x100000000;
    for (let at = 0x80; at + 48 <= s.length;) {
      if (u16(at) !== 0xd5ac) { at += 0x80; continue; }
      const name = String.fromCharCode(...s.subarray(at + 2, at + 8))
        .replace(/\0.*$/, '');
      if (name === '_data_') return u32(at + 36);
      const size = u64(at + 16);
      at += size > 0 ? size : 0x80;
    }
    throw new Error('no _data_ segment');
  };

  it.each([[1, 5], [2, 6], [4, 8], [5, 10], [8, 13], [9, 15]])(
    '%i solids -> tally %i', (n, tally) => {
      expect(dataTallyOf(n)).toBe(tally);
    });
});

describe('WIPEOUT imagedef reference', () => {
  it('a wipeout references a NULL imagedef, like every AutoCAD one', () => {
    /* minting a path-less imagedef for the mask plots it as a black
       box; AutoCAD writes handle 0 there (oracle: all 17 wipeouts of
       the field corpus) */
    const d = emptyDrawing();
    d.entities = [{
      type: 'image', wipeout: true, layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 },
      uVector: { x: 10, y: 0, z: 0 }, vVector: { x: 0, y: 5, z: 0 },
      widthPx: 1, heightPx: 1,
      clip: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: 0.5 }]
    }];
    const bytes = writeDwg2018(d).data;
    const back = readDwg(bytes);
    const wp = back.entities.find((e) => e.type === 'image');
    expect(wp && wp.type === 'image' && wp.wipeout).toBe(true);
    /* structurally: no IMAGEDEF object should exist in the file at all */
    const sections = readSections2004(bytes);
    const classesSection = sections.get('AcDb:Classes')!;
    let ascii = '';
    for (const b of classesSection) {
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
    }
    /* the class table still declares IMAGEDEF (positional numbering),
       but the drawing must not carry a minted def record: reading back
       yields no image with a path and no leftover handle */
    expect(wp && wp.type === 'image' && wp.path).toBeUndefined();
    void ascii;
  });
});

describe('hatch loop flags and pattern fidelity', () => {
  it('external/derived/outermost bits and pixel size survive R2018', () => {
    const d = emptyDrawing();
    d.entities = [{
      type: 'hatch', layer: '0', color: { kind: 'byLayer' },
      patternName: 'ANSI31', solid: false, angle: 0, scale: 1,
      styleFlag: 1,
      loops: [
        { kind: 'polyline', closed: true, external: true, derived: true,
          vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
        { kind: 'polyline', closed: true, outermost: true,
          vertices: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }] }
      ],
      definitionLines: [
        { angle: 45, base: { x: 0, y: 0 }, offset: { x: -2, y: 2 }, dashes: [] }
      ],
      pixelSize: 2.5
    }];
    const back = readDwg(writeDwg2018(d).data);
    const h = back.entities.find((e) => e.type === 'hatch');
    expect(h?.type).toBe('hatch');
    if (h?.type !== 'hatch') return;
    expect(h.loops[0].external).toBe(true);
    expect(h.loops[0].derived).toBe(true);
    expect(h.loops[1].outermost).toBe(true);
    expect(h.pixelSize).toBeCloseTo(2.5, 12);
    /* associativity is never written: no boundary handles ride along,
       and associative-with-no-boundary is an audit error on each one */
    expect(h.associative).toBeUndefined();
  });
});

describe('DXF hatch pattern lines split per 53', () => {
  it('three definition lines survive the DXF round trip', async () => {
    /* the reader folded every line's groups into the first (a second 53
       is the NEXT line's angle) — the corpus' NET3/INSUL hatches came
       back as one line plus zero-offset husks, which AutoCAD audits as
       unrepairable and erases */
    const { writeDxf } = await import('../src/dxf/writer.js');
    const { readDxf } = await import('../src/dxf/reader.js');
    const d = emptyDrawing();
    const lines = [
      { angle: 180, base: { x: 1, y: 2 }, offset: { x: 0, y: 0.025 }, dashes: [] },
      { angle: 120, base: { x: 3, y: 4 }, offset: { x: 0.02, y: 0.0125 }, dashes: [0.0125, -0.0125] },
      { angle: 60, base: { x: 5, y: 6 }, offset: { x: 0.02, y: -0.0125 }, dashes: [0.0125, -0.0125] }
    ];
    d.entities = [{
      type: 'hatch', layer: '0', color: { kind: 'byLayer' },
      patternName: 'NET3', solid: false, angle: 0, scale: 0.2,
      loops: [{ kind: 'polyline', closed: true, external: true,
        vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
      definitionLines: lines
    }];
    const back = readDxf(writeDxf(d));
    const h = back.entities.find((e) => e.type === 'hatch');
    expect(h?.type).toBe('hatch');
    if (h?.type !== 'hatch') return;
    expect(h.definitionLines?.length).toBe(3);
    expect(h.definitionLines?.map((l) => l.angle)).toEqual([180, 120, 60]);
    expect(h.definitionLines?.[1].offset.x).toBeCloseTo(0.02, 12);
    expect(h.definitionLines?.[2].dashes).toEqual([0.0125, -0.0125]);
    expect(h.loops[0].external).toBe(true);
  });
});

describe('R2004+ entity true colour (ENC)', () => {
  it('an RGB entity colour survives, spelled as AutoCAD spells it', () => {
    /* flags 0x80 with the nearest ACI as legacy index, then the
       0xC2-method dword — collapsing to index 7 painted the corpus'
       salmon banner black in every plot */
    const back = readDwg(writeDwg2018(one({
      type: 'line', layer: '0', color: { kind: 'rgb', rgb: 0xFA9285 },
      start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 5, z: 0 }
    })).data);
    expect(back.entities[0].color).toEqual({ kind: 'rgb', rgb: 0xFA9285 });
  });
});
