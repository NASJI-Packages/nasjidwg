/* nasjidwg — dimension geometry generation.
 *
 * A DIMENSION without its anonymous block is only definition points;
 * explodeDimension builds the drawn form. The exporters use it as a
 * fallback and the R12 writer materializes it as a real block.
 */

import { describe, expect, it } from 'vitest';
import { explodeDimension } from '../src/core/dim.js';
import { emptyDrawing } from '../src/core/model.js';
import type { DimensionEntity, Entity } from '../src/core/model.js';
import { writeSvg } from '../src/export/svg.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwgR12 } from '../src/dwg/writer12.js';

const dim = (extra: Partial<DimensionEntity>): DimensionEntity => ({
  type: 'dimension', layer: '0', color: { kind: 'byLayer' },
  dimensionType: 0, definitionPoint: { x: 0, y: 0, z: 0 },
  ...extra
});

const tally = (list: Entity[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of list) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
};
const textOf = (list: Entity[]): string =>
  list.filter((e) => e.type === 'text').map((e) => e.type === 'text' ? e.text : '').join('|');

describe('explodeDimension', () => {
  it('draws a linear dimension: extensions, line, arrows, measurement', () => {
    const parts = explodeDimension(dim({
      kind: 'linear', rotation: 0,
      definitionPoint: { x: 5, y: 2, z: 0 },
      point13: { x: 0, y: 0, z: 0 }, point14: { x: 5, y: 0, z: 0 }
    }));
    expect(tally(parts)).toEqual({ line: 3, solid: 2, text: 1 });
    expect(textOf(parts)).toBe('5');
    /* the dimension line runs at the definition point's height */
    const flat = parts.filter((e) => e.type === 'line'
      && Math.abs(e.start.y - 2) < 1e-9 && Math.abs(e.end.y - 2) < 1e-9);
    expect(flat.length).toBe(1);
  });

  it('honors the text override forms', () => {
    const base = {
      kind: 'aligned' as const,
      point13: { x: 0, y: 0, z: 0 }, point14: { x: 3, y: 4, z: 0 },
      definitionPoint: { x: 3, y: 4, z: 0 }
    };
    expect(textOf(explodeDimension(dim(base)))).toBe('5');
    expect(textOf(explodeDimension(dim({ ...base, text: ' ' })))).toBe('');
    expect(textOf(explodeDimension(dim({ ...base, text: 'L=<> m' })))).toBe('L=5 m');
    expect(textOf(explodeDimension(dim({ ...base, text: 'fixed' })))).toBe('fixed');
  });

  it('draws radius and diameter dimensions', () => {
    const r = explodeDimension(dim({
      kind: 'radius', definitionPoint: { x: 0, y: 0, z: 0 },
      point15: { x: 3, y: 0, z: 0 }
    }));
    expect(tally(r)).toEqual({ line: 1, solid: 1, text: 1 });
    expect(textOf(r)).toBe('R3');
    const d = explodeDimension(dim({
      kind: 'diameter', definitionPoint: { x: -3, y: 0, z: 0 },
      point15: { x: 3, y: 0, z: 0 }
    }));
    expect(tally(d)).toEqual({ line: 1, solid: 2, text: 1 });
    expect(textOf(d)).toBe('%%c6');
  });

  it('draws a three-point angular dimension as an arc', () => {
    const s = Math.SQRT1_2;
    const parts = explodeDimension(dim({
      kind: 'angular3pt',
      point15: { x: 0, y: 0, z: 0 },
      point13: { x: 1, y: 0, z: 0 }, point14: { x: 0, y: 1, z: 0 },
      definitionPoint: { x: s, y: s, z: 0 }
    }));
    expect(tally(parts)).toEqual({ arc: 1, line: 2, text: 1 });
    expect(textOf(parts)).toBe('90%%d');
    const arc = parts.find((e) => e.type === 'arc');
    expect(arc?.type === 'arc' && arc.radius).toBeCloseTo(1, 9);
  });

  it('applies the dimension style scale', () => {
    const parts = explodeDimension(dim({
      kind: 'aligned',
      point13: { x: 0, y: 0, z: 0 }, point14: { x: 10, y: 0, z: 0 },
      definitionPoint: { x: 10, y: 3, z: 0 }
    }), { name: 'S', vars: { DIMSCALE: 10, DIMTXT: 0.2, DIMDEC: 1 } });
    const text = parts.find((e) => e.type === 'text');
    expect(text?.type === 'text' && text.height).toBeCloseTo(2, 9);
  });
});

describe('generated dimensions reach the outputs', () => {
  const d = emptyDrawing();
  d.entities.push(dim({
    kind: 'linear', rotation: 0,
    definitionPoint: { x: 8, y: 3, z: 0 },
    point13: { x: 0, y: 0, z: 0 }, point14: { x: 8, y: 0, z: 0 },
    textMidpoint: { x: 4, y: 3.2, z: 0 }
  }));

  it('SVG falls back to the generated form when the block is absent', () => {
    const svg = writeSvg(d);
    expect(svg).toContain('>8</text>');            /* the measurement */
  });

  it('the R12 writer materializes a *D block for a blockless dimension', () => {
    const { data, skipped } = writeDwgR12(d);
    expect(skipped).toEqual([]);
    const back = readDwg(data);
    const dm = back.entities.find((e) => e.type === 'dimension');
    expect(dm?.type === 'dimension' && dm.blockName).toBe('*D0');
    const blk = back.blocks['*D0'];
    expect(blk).toBeDefined();
    expect(tally(blk.entities)).toEqual({ line: 3, solid: 2, text: 1 });
  });
});

/* A DWG's DIMSTYLE table carries names only, so the drawing's current
 * sizes live in the header. Without them every generated dimension came
 * out at the library's own imperial defaults. */
describe('header vars as the size fallback', () => {
  const dim = {
    type: 'dimension', layer: '0', color: { kind: 'byLayer' },
    kind: 'aligned', dimensionType: 1,
    definitionPoint: { x: 0, y: 0, z: 0 },
    point13: { x: 0, y: 0, z: 0 },
    point14: { x: 100, y: 0, z: 0 },
    textMidpoint: { x: 50, y: 10, z: 0 }
  } as unknown as Parameters<typeof explodeDimension>[0];

  const textHeight = (ents: ReturnType<typeof explodeDimension>): number => {
    const t = ents.find((e) => e.type === 'text');
    return t && t.type === 'text' ? t.height : 0;
  };

  it('uses them when the named style has none', () => {
    const withHdr = explodeDimension(dim, undefined, { DIMTXT: 5, DIMASZ: 4 });
    expect(textHeight(withHdr)).toBeCloseTo(5, 9);
    /* the default is the library's own 0.18 */
    expect(textHeight(explodeDimension(dim))).toBeCloseTo(0.18, 9);
  });

  it('but the named style still wins over them', () => {
    const style = { name: 'BIG', vars: { DIMTXT: 9 } };
    expect(textHeight(explodeDimension(dim, style, { DIMTXT: 5 }))).toBeCloseTo(9, 9);
  });
});
