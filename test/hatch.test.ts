/* nasjidwg — hatch pattern files and pattern explosion. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  explodeHatch, readPatternFile, writePatternFile
} from '../src/hatch/pattern.js';
import { readDwg } from '../src/dwg/reader.js';
import { dwgOf } from './corpus.js';
import type { HatchEntity } from '../src/core/model.js';

describe('.pat pattern files', () => {
  const text = readFileSync(
    fileURLToPath(new URL('./patterns.pat', import.meta.url)), 'utf8');
  const patterns = readPatternFile(text);

  it('parses a pattern library', () => {
    expect(patterns.map((p) => p.name))
      .toEqual(['NASJI_RULE', 'NASJI_DASH', 'NASJI_GRID', 'NASJI_BOND']);
    expect(patterns[0].description).toBe('Plain horizontal rules');
    expect(patterns[0].lines.length).toBe(1);
    expect(patterns[0].lines[0]).toEqual({
      angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 3 }, dashes: []
    });
  });

  it('reads dashes, gaps and multi-family patterns', () => {
    const dash = patterns[1].lines[0];
    expect(dash.dashes).toEqual([2, -2]);
    expect(dash.dashes[1]).toBeLessThan(0);            /* a gap */

    /* the grid is two families ninety degrees apart */
    expect(patterns[2].lines.map((l) => l.angle)).toEqual([0, 90]);

    /* running bond: a shifted base point is what staggers the courses */
    const bond = patterns[3].lines;
    expect(bond.length).toBe(3);
    expect(bond[1].base).toEqual({ x: 0, y: 0 });
    expect(bond[2].base).toEqual({ x: 4, y: 2 });
    expect(bond[2].offset).toEqual({ x: 4, y: 4 });
    expect(bond[2].dashes).toEqual([4, -4]);
  });

  it('round-trips through the writer', () => {
    const back = readPatternFile(writePatternFile(patterns));
    expect(back.length).toBe(patterns.length);
    expect(back.map((p) => p.name)).toEqual(patterns.map((p) => p.name));
    for (let i = 0; i < back.length; i++) {
      expect(back[i].lines.length).toBe(patterns[i].lines.length);
      expect(back[i].lines[0].angle).toBeCloseTo(patterns[i].lines[0].angle, 6);
      expect(back[i].lines[0].dashes).toEqual(patterns[i].lines[0].dashes);
    }
  });

  it('ignores comments and malformed lines', () => {
    const p = readPatternFile([
      '; a comment',
      '*GOOD, fine',
      '0, 0,0, 0,1',
      'not, enough',
      '*EMPTY, no lines'
    ].join('\n'));
    expect(p.map((x) => x.name)).toEqual(['GOOD']);
    expect(p[0].lines.length).toBe(1);
  });
});

describe('hatch explosion', () => {
  const square: HatchEntity = {
    type: 'hatch', layer: '0', color: { kind: 'byLayer' },
    patternName: 'LINE', solid: false, angle: 0, scale: 1,
    loops: [{
      kind: 'polyline', closed: true,
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    }],
    definitionLines: [
      { angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 2 }, dashes: [] }
    ]
  };

  it('draws pattern lines clipped to the boundary', () => {
    const lines = explodeHatch(square);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) {
      if (l.type !== 'line') throw new Error('expected lines');
      /* horizontal, inside the square, spanning its full width */
      expect(l.start.y).toBeCloseTo(l.end.y, 9);
      expect(l.start.y).toBeGreaterThanOrEqual(-1e-9);
      expect(l.start.y).toBeLessThanOrEqual(10 + 1e-9);
      expect(Math.abs(l.end.x - l.start.x)).toBeCloseTo(10, 6);
    }
  });

  it('honours scale and angle', () => {
    const dense = explodeHatch({ ...square, scale: 0.5 });
    const sparse = explodeHatch({ ...square, scale: 2 });
    expect(dense.length).toBeGreaterThan(sparse.length);

    const rotated = explodeHatch({ ...square, angle: 90 });
    expect(rotated.length).toBeGreaterThan(3);
    for (const l of rotated) {
      if (l.type !== 'line') throw new Error('expected lines');
      expect(l.start.x).toBeCloseTo(l.end.x, 6);       /* now vertical */
    }
  });

  it('dashes split the runs', () => {
    const dashed = explodeHatch({
      ...square,
      definitionLines: [
        { angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 5 }, dashes: [2, -2] }
      ]
    });
    expect(dashed.length).toBeGreaterThan(2);
    for (const l of dashed) {
      if (l.type !== 'line') throw new Error('expected lines');
      expect(Math.abs(l.end.x - l.start.x)).toBeLessThanOrEqual(2 + 1e-6);
    }
  });

  it('solid fills produce no line work', () => {
    expect(explodeHatch({ ...square, solid: true })).toEqual([]);
  });

  it('explodes a hatch that came back off a DWG', () => {
    const d = readDwg(dwgOf('R2000'));
    const hatch = d.entities.find(
      (e) => e.type === 'hatch' && !e.solid);
    expect(hatch).toBeTruthy();
    if (hatch?.type === 'hatch') {
      const lines = explodeHatch(hatch);
      /* the fixture's hatch carries its own definition lines */
      expect(hatch.definitionLines?.length ?? 0).toBeGreaterThan(0);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.type === 'line')).toBe(true);
    }
  });
});
