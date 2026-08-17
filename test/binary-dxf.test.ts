/* nasjidwg — binary DXF tests: real-world file + round-trip. */
import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf, writeDxfBinary } from '../src/dxf/writer.js';
import { isBinaryDxf, isNarrowCodeBinaryDxf } from '../src/dxf/binary.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing } from '../src/core/model.js';

describe('binary DXF with pre-R13 group codes', () => {
  /* Before R13 a group code is one byte, escaping through 255 for the
     handful of codes that do not fit. */
  const sample = (): Drawing => {
    const d = emptyDrawing();
    d.entities.push(
      { type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: { x: 1, y: 2, z: 0 }, end: { x: 3, y: 4, z: 0 } },
      { type: 'circle', layer: '0', color: { kind: 'aci', index: 3 },
        center: { x: 5, y: 6, z: 0 }, radius: 2.5 },
      { type: 'text', layer: '0', color: { kind: 'byLayer' },
        position: { x: 0, y: 0, z: 0 }, text: 'Aa', height: 1, rotation: 0 }
    );
    return d;
  };

  it('round-trips through the single-byte form', () => {
    const bytes = writeDxfBinary(sample(), { narrowCodes: true });
    expect(isBinaryDxf(bytes)).toBe(true);
    expect(isNarrowCodeBinaryDxf(bytes)).toBe(true);
    const back = readDxf(bytes);
    expect(back.entities.map((e) => e.type)).toEqual(['line', 'circle', 'text']);
    const circle = back.entities[1];
    expect(circle.type === 'circle' && circle.radius).toBe(2.5);
    expect(circle.color).toEqual({ kind: 'aci', index: 3 });
  });

  it('is smaller than the two-byte form and still distinguishable', () => {
    const narrow = writeDxfBinary(sample(), { narrowCodes: true });
    const wide = writeDxfBinary(sample());
    expect(narrow.length).toBeLessThan(wide.length);
    expect(isNarrowCodeBinaryDxf(wide)).toBe(false);
    /* both decode to the same drawing */
    expect(readDxf(narrow).entities.length).toBe(readDxf(wide).entities.length);
  });

  it('escapes codes that do not fit in a byte', () => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 },
      xdata: [{ appName: 'NASJI', values: [{ code: 1000, value: 'tag' }] }]
    });
    const bytes = writeDxfBinary(d, { narrowCodes: true });
    const back = readDxf(bytes);
    expect(back.entities[0].xdata?.[0].appName).toBe('NASJI');
    expect(back.entities[0].xdata?.[0].values[0]).toEqual(
      { code: 1000, value: 'tag' });
  });
});
