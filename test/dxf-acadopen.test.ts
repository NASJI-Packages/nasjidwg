/* What AutoCAD's DXFIN demands before it will open a file at all.
 *
 * Every rule here was found the hard way: feeding writeDxf output to
 * AutoCAD 2027's Core Console and reading the rejection line. DXFIN does
 * not skip what it dislikes — one missing group discards the WHOLE file:
 *
 *   "Did not receive PlotStyleName"        LAYER without group 390
 *   "Missing SymbolTable:VIEW"             any of the 9 tables absent
 *   "Missing Default entry ByLayer"        LTYPE without ByBlock/ByLayer
 *   "GroupTable dictionary was not
 *    defined in NamedObject dictionary"    no ACAD_GROUP (or no OBJECTS)
 *   "Bad handle FFFF: already in use"      a handle at/above $HANDSEED
 *   "expected group code 75"               a 97 inside a spline hatch edge
 *   "Premature end of object" (HATCH)      gradient groups 450+ in AC1015
 *   "Class separator ... AcDbWipeout"      WIPEOUT spelled AcDbRasterImage
 *   "Xdata wasn't read" (WIPEOUT)          an open polygonal clip ring
 *   (MLINE, no reason line)                MLINE without its style's 340
 *
 * A 72 MB production drawing (232,382 entities) now opens with a single
 * AUDIT fix — a one-dash linetype AutoCAD's own DXFOUT reproduces too. */
import { describe, expect, it } from 'vitest';
import { emptyDrawing, writeDxf } from '../src/index.js';
import type { Drawing, Entity } from '../src/index.js';

const line = (x2 = 10, y2 = 5): Entity => ({
  type: 'line', layer: '0', color: { kind: 'byLayer' },
  start: { x: 0, y: 0, z: 0 }, end: { x: x2, y: y2, z: 0 }
});

const base = (): Drawing => {
  const d = emptyDrawing();
  d.entities = [line()];
  return d;
};

/** [code, value] pairs of the whole file */
const pairs = (dxf: string): [number, string][] => {
  const lines = dxf.split('\n');
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    out.push([parseInt(lines[i], 10), lines[i + 1]]);
  }
  return out;
};

/** the pairs of one record: from its `0 <name>` to the next 0 group */
const record = (dxf: string, name: string): [number, string][] => {
  const ps = pairs(dxf);
  const at = ps.findIndex(([c, v]) => c === 0 && v === name);
  expect(at, name + ' present').toBeGreaterThan(-1);
  const end = ps.findIndex(([c], i) => i > at && c === 0);
  return ps.slice(at + 1, end < 0 ? undefined : end);
};

describe('what DXFIN demands', () => {
  it('every LAYER names its plot style, and the dictionary exists', () => {
    const dxf = writeDxf(base());
    const layer = record(dxf, 'LAYER');
    expect(layer.some(([c]) => c === 390)).toBe(true);
    expect(dxf).toContain('ACAD_PLOTSTYLENAME');
    expect(dxf).toContain('ACDBDICTIONARYWDFLT');
    expect(dxf).toContain('ACDBPLACEHOLDER');
  });

  it('all nine symbol tables go out even when empty', () => {
    const dxf = writeDxf(base());
    for (const t of ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS',
      'APPID', 'DIMSTYLE', 'BLOCK_RECORD']) {
      expect(pairs(dxf).some(([c, v]) => c === 2 && v === t), t).toBe(true);
    }
    /* and the defaults DXFIN checks for by name */
    expect(dxf).toContain('ByBlock');
    expect(dxf).toContain('ByLayer');
    expect(dxf).toContain('Standard');       /* DIMSTYLE */
  });

  it('the OBJECTS section and its group dictionary are unconditional', () => {
    const dxf = writeDxf(base());
    expect(dxf).toContain('OBJECTS');
    expect(dxf).toContain('ACAD_GROUP');
  });

  it('$HANDSEED clears every handle in the file', () => {
    const d = base();
    for (let i = 0; i < 200; i++) d.entities.push(line(i, i));
    const ps = pairs(writeDxf(d));
    const seedAt = ps.findIndex(([c, v]) => c === 9 && v === '$HANDSEED');
    const seed = parseInt(ps[seedAt + 1][1], 16);
    ps.forEach(([c, v], i) => {
      if (i === seedAt + 1) return;         /* the seed itself rides group 5 */
      if (c === 5 || c === 105) {
        expect(parseInt(v, 16), 'handle ' + v).toBeLessThan(seed);
      }
    });
  });

  it('a spline hatch edge carries no 97 of its own', () => {
    const d = base();
    d.entities.push({
      type: 'hatch', layer: '0', color: { kind: 'byLayer' },
      solid: true, loops: [{
        kind: 'edges', edges: [{
          kind: 'spline', degree: 3, periodic: false,
          knots: [0, 0, 0, 0, 1, 1, 1, 1],
          controlPoints: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: -1 }, { x: 3, y: 0 }]
        }]
      }]
    } as Entity);
    const hatch = record(writeDxf(d), 'HATCH');
    expect(hatch.filter(([c]) => c === 97)).toHaveLength(1);
  });

  it('no gradient groups leave in an AC1015 file', () => {
    const d = base();
    d.entities.push({
      type: 'hatch', layer: '0', color: { kind: 'byLayer' },
      solid: true,
      loops: [{ kind: 'polyline', closed: true, vertices: [
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
      gradient: { name: 'LINEAR', angle: 0, shift: 0, tint: 0,
        singleColor: false, colors: [] }
    } as unknown as Entity);
    const hatch = record(writeDxf(d), 'HATCH');
    expect(hatch.some(([c]) => c >= 450)).toBe(false);
    /* and never a live associative flag without the boundary links */
    expect(hatch.find(([c]) => c === 71)?.[1]).toBe('0');
  });

  it('WIPEOUT is spelled AcDbWipeout with a closed clip ring', () => {
    const d = base();
    d.entities.push({
      type: 'image', layer: '0', color: { kind: 'byLayer' }, wipeout: true,
      position: { x: 0, y: 0, z: 0 },
      uVector: { x: 1, y: 0, z: 0 }, vVector: { x: 0, y: 1, z: 0 },
      widthPx: 1, heightPx: 1,
      clip: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }]
    } as Entity);
    const wo = record(writeDxf(d), 'WIPEOUT');
    expect(wo.some(([c, v]) => c === 100 && v === 'AcDbWipeout')).toBe(true);
    expect(wo.some(([c, v]) => c === 100 && v === 'AcDbRasterImage')).toBe(false);
    expect(wo.find(([c]) => c === 340)?.[1]).toBe('0');
    expect(wo.find(([c]) => c === 91)?.[1]).toBe('4');   /* 3 + closing */
    const xs = wo.filter(([c]) => c === 14).map(([, v]) => v);
    expect(xs[0]).toBe(xs[xs.length - 1]);
  });

  it('MLINE points at its style, synthesized if the drawing has none', () => {
    const d = base();
    d.entities.push({
      type: 'mline', layer: '0', color: { kind: 'byLayer' },
      scale: 1, justification: 0, basePoint: { x: 0, y: 0, z: 0 },
      vertices: [
        { position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
          miterDirection: { x: 0, y: 1, z: 0 }, lines: [] },
        { position: { x: 5, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
          miterDirection: { x: 0, y: 1, z: 0 }, lines: [] }]
    } as Entity);
    const dxf = writeDxf(d);
    const ml = record(dxf, 'MLINE');
    const styleH = ml.find(([c]) => c === 340)?.[1];
    expect(styleH).toBeTruthy();
    const style = record(dxf, 'MLINESTYLE');
    expect(dxf).toContain('ACAD_MLINESTYLE');
    expect(style.length).toBeGreaterThan(0);
  });

  it('an ASM kernel stream stays out of the DXF, and says so', () => {
    const d = base();
    d.entities.push({
      type: 'acis', kind: 'region', layer: '0', color: { kind: 'byLayer' },
      sat: '22300 2 1 4 \nasmheader $-1 -1 @12 228.0.0.1234 #\nEnd-of-ASM-data \n'
    } as Entity);
    const dxf = writeDxf(d);
    expect(pairs(dxf).some(([c, v]) => c === 0 && v === 'REGION')).toBe(false);
    expect(d.warnings.some((s) => /skipped in DXF/.test(s))).toBe(true);
    /* a classic ACIS stream still travels */
    const d2 = base();
    d2.entities.push({
      type: 'acis', kind: 'region', layer: '0', color: { kind: 'byLayer' },
      sat: '400 1 1 0\nbody $-1 -1 $-1 $1 $-1 $-1 #\n'
    } as Entity);
    expect(pairs(writeDxf(d2)).some(([c, v]) => c === 0 && v === 'REGION')).toBe(true);
  });

  it('a 250-character text chunk never ends inside an escape', () => {
    /* The GENERAL NOTES mtext of the reference's own tables sample has
       tabs (^I) that fell on a chunk boundary: a chunk ending in a bare
       caret is a malformed DXF string — "DXF read error on line N",
       file discarded. The cut moves back before a caret, a \U+XXXX or a
       %%x code, and is measured after escaping, so every chunk that
       lands in the file is at most 250 characters. */
    const d = base();
    const text = 'A'.repeat(249) + '^I' + 'B'.repeat(30) + 'C'.repeat(217)
      + 'é' + 'D'.repeat(40) + '%'.repeat(2) + 'd' + 'E'.repeat(300);
    d.entities.push({
      type: 'mtext', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, text, height: 2.5, rotation: 0
    } as Entity);
    const rec = record(writeDxf(d), 'MTEXT');
    const chunks = rec.filter(([c]) => c === 3 || c === 1).map(([, v]) => v);
    expect(chunks.length).toBeGreaterThan(3);
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(250);
      expect(ch.endsWith('^'), 'bare caret: ' + ch.slice(-5)).toBe(false);
      expect(/\\U\+[0-9A-F]{0,3}$/.test(ch), 'split \\U+: ' + ch.slice(-8)).toBe(false);
      expect(/%%?$/.test(ch), 'split %%: ' + ch.slice(-5)).toBe(false);
    }
    expect(chunks.join('')).toBe(text.replace('é', '\\U+00E9'));
  });

  it('a carried 1005 xdata handle leaves as null, not dangling', () => {
    const d = base();
    d.entities[0].xdata = [{
      appName: 'ACAD', values: [{ code: 1005, value: '2CE73C' }]
    }];
    const ln = record(writeDxf(d), 'LINE');
    expect(ln.find(([c]) => c === 1005)?.[1]).toBe('0');
  });

  it('layouts and their block records point at each other', () => {
    const d = base();
    d.layouts = [
      { name: 'Model', blockName: '*Model_Space', tabOrder: 0 },
      { name: 'Layout1', blockName: '*Paper_Space', tabOrder: 1 },
      /* an extra paper space this writer does not emit: not listed */
      { name: 'Layout2', blockName: '*Paper_Space2', tabOrder: 2 }
    ];
    const dxf = writeDxf(d);
    const btr = record(dxf, 'BLOCK_RECORD');   /* first: *Model_Space */
    const back = btr.find(([c]) => c === 340)?.[1];
    expect(back).toBeTruthy();
    const layoutAt = pairs(dxf).findIndex(([c, v]) => c === 5 && v === back);
    expect(layoutAt).toBeGreaterThan(-1);
    expect(dxf).not.toContain('Layout2');
  });
});
