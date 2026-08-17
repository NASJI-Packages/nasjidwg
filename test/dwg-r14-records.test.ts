/* R13/R14 acceptance regressions — the record set and field widths that
 * AutoCAD 2027 requires before it opens an AC1014 file (campaign round 4;
 * every rule here was pinned externally with accoreconsole):
 *   - a DIMSTYLE "STANDARD" and MLINESTYLE "STANDARD" must exist, with the
 *     ACAD_MLINESTYLE dictionary naming the style;
 *   - simple entities spell thickness as a full BD and extrusion as a full
 *     3BD (the one-bit BT/BE shortcuts are R2000 inventions — with them the
 *     drawing is refused, ErrorStatus 53);
 *   - dimension styles ride through for every version from R13 on.
 */
import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwgR14, writeDwg2000 } from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing } from '../src/core/model.js';

const lineDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.entities = [{
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 50, z: 0 }
  }];
  return d;
};

describe('R14 required records', () => {
  const back = readDwg(writeDwgR14(lineDrawing()).data);

  it('synthesizes DIMSTYLE STANDARD', () => {
    expect(back.dimStyles?.map((s) => s.name)).toEqual(['STANDARD']);
  });

  it('synthesizes MLINESTYLE STANDARD with the two ±0.5 elements', () => {
    const ms = back.mlineStyles?.[0];
    expect(ms?.name).toBe('STANDARD');
    expect(ms?.elements.map((e) => e.offset)).toEqual([0.5, -0.5]);
    expect(ms?.startAngle).toBeCloseTo(Math.PI / 2, 12);
  });

  it('round-trips the lone line through the full-width R14 fields', () => {
    const line = back.entities.find((e) => e.type === 'line');
    expect(line && line.type === 'line' && line.end.x).toBe(100);
  });
});

describe('dimension styles ride through the R13+ writers', () => {
  it('writes the source dimStyles at R2000 and resolves dimension.style', () => {
    const d = lineDrawing();
    d.dimStyles = [{ name: 'S1', vars: { DIMSCALE: 2 } }];
    d.entities.push({
      type: 'dimension', layer: '0', color: { kind: 'byLayer' },
      dimensionType: 33, kind: 'linear', style: 'S1',
      definitionPoint: { x: 0, y: 0, z: 0 }
    });
    const back = readDwg(writeDwg2000(d).data);
    expect(back.dimStyles?.map((s) => s.name).sort()).toEqual(['S1', 'Standard']);
    const dim = back.entities.find((e) => e.type === 'dimension');
    expect(dim && dim.type === 'dimension' && dim.style).toBe('S1');
  });
});
