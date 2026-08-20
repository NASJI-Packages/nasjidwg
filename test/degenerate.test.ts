/* nasjidwg — degenerate curvature: the arc that isn't one.
 *
 * Real drawings are full of arc-fit leftovers. A polyline vertex carries a
 * bulge of 3e-12 across a 99-unit chord (a circle of radius 7e12); an ARC
 * is stored with its two angles bit-identical; a hatch boundary edge runs
 * all but a thousandth of a radian of a full turn the wrong way round.
 * AutoCAD draws every one of them as the hairline it is. Read them
 * literally instead and a 5-unit sliver of a chair becomes a 4000-unit
 * disc, a zero-length arc becomes a whole circle, and the drawing's
 * extents — and with them the plotted page — grow by six orders of
 * magnitude. Each case here is measured off a real file (BLOCKS.dwg,
 * 246,377 entities) and checked against AutoCAD 2027's own answer.
 */

import { describe, expect, it } from 'vitest';
import { emptyDrawing } from '../src/core/model.js';
import {
  arcSweep, boundaryPoints, contentBounds, entityBounds, flattenPolyline
} from '../src/core/geo.js';
import { writeSvg } from '../src/export/svg.js';
import { writePdf } from '../src/export/pdf.js';
import type { Drawing, Entity } from '../src/core/model.js';

const TAU = Math.PI * 2;
const text = (r: { data: Uint8Array }): string =>
  Array.from(r.data, (b) => String.fromCharCode(b)).join('');

const withEntity = (e: Entity): Drawing => {
  const d = emptyDrawing();
  d.entities.push(e);
  return d;
};

describe('a bulge too small to be curvature', () => {
  /* handle 2C1246 of BLOCKS.dwg: bulge 3.366e-12 on a 99.244-unit chord,
     an implied radius of 7.37e12 */
  const junk = (bulge: number): Entity => ({
    type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
    vertices: [{ x: 0, y: 0, bulge }, { x: 100, y: 0 }]
  });

  it('flattens to its chord, with nothing in between', () => {
    expect(flattenPolyline(junk(1e-12).vertices as never, false))
      .toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it('bounds exactly as the chord does', () => {
    const b = entityBounds(junk(1e-12))!;
    expect(b.min).toEqual({ x: 0, y: 0 });
    expect(b.max).toEqual({ x: 100, y: 0 });
  });

  it('draws as one straight line in SVG and in the PDF', () => {
    const svg = writeSvg(withEntity(junk(1e-12)));
    /* one move, one line, no sampled run of arc points */
    expect(svg).toMatch(/d="M0,0 L100,0"/);
    const pdf = text(writePdf(withEntity(junk(1e-12))));
    expect(pdf).not.toMatch(/ c\n/);        /* no cubic segments at all */
  });

  it('leaves a bulge that is real alone', () => {
    /* 1e-3 bows the 100-unit chord by 0.05: small, drawn, and kept */
    const b = entityBounds(junk(1e-3))!;
    expect(b.max.y - b.min.y).toBeCloseTo(0.05, 4);
    /* and a fillet-sized one is untouched: a quarter turn of radius 0.5 */
    const f = entityBounds({
      type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
      vertices: [{ x: 0, y: 0, bulge: Math.tan(Math.PI / 8) }, { x: 0.5, y: 0.5 }]
    })!;
    expect(f.max.y - f.min.y).toBeCloseTo(0.5, 6);
    expect(f.min.x).toBeCloseTo(0, 6);
  });
});

describe('an arc whose two angles are the same', () => {
  /* handle 12BE5F of BLOCKS.dwg: (50 . 4.97538) (51 . 4.97538), radius
     421.875 — AutoCAD frames the block that holds it at 3.1 units */
  const zero = (r = 10): Entity => ({
    type: 'arc', layer: '0', color: { kind: 'byLayer' },
    center: { x: 0, y: 0, z: 0 }, radius: r,
    startAngle: 4.97538, endAngle: 4.97538
  });

  it('sweeps nothing, where a whole turn still sweeps a whole turn', () => {
    expect(arcSweep(4.97538, 4.97538)).toBe(0);
    expect(arcSweep(0, TAU)).toBe(TAU);
    expect(arcSweep(1.5, 1.5 + TAU)).toBe(TAU);
    expect(arcSweep(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(arcSweep(Math.PI * 1.5, 0)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('bounds as the point it draws, not as the circle it came from', () => {
    const b = entityBounds(zero())!;
    expect(b.max.x - b.min.x).toBeCloseTo(0, 9);
    expect(b.max.y - b.min.y).toBeCloseTo(0, 9);
    expect(b.min.x).toBeCloseTo(10 * Math.cos(4.97538), 9);
  });

  it('draws nothing at all', () => {
    const svg = writeSvg(withEntity(zero()));
    expect(svg).not.toMatch(/<path/);
    expect(text(writePdf(withEntity(zero())))).not.toMatch(/ c\n/);
  });

  it('still bounds a real arc by its run and a full one by its circle', () => {
    const quarter = entityBounds({
      type: 'arc', layer: '0', color: { kind: 'byLayer' },
      center: { x: 0, y: 0, z: 0 }, radius: 10, startAngle: 0,
      endAngle: Math.PI / 2
    })!;
    expect(quarter.min.x).toBeCloseTo(0, 9);
    expect(quarter.min.y).toBeCloseTo(0, 9);
    expect(quarter.max.x).toBeCloseTo(10, 9);
    expect(quarter.max.y).toBeCloseTo(10, 9);
    const full = entityBounds({
      type: 'arc', layer: '0', color: { kind: 'byLayer' },
      center: { x: 0, y: 0, z: 0 }, radius: 10, startAngle: 0, endAngle: TAU
    })!;
    expect(full.min).toEqual({ x: -10, y: -10 });
    expect(full.max).toEqual({ x: 10, y: 10 });
  });

  it('keeps a hairline of megaunit radius off the page', () => {
    /* handle A5927 of BLOCKS.dwg: radius 7.29e6 swept 2e-5 — 145 units of
       arc. Boxed as its circle it made a 14,000,000-unit page. */
    const d = withEntity({
      type: 'arc', layer: '0', color: { kind: 'byLayer' },
      center: { x: 7.292e6, y: 0, z: 0 }, radius: 7.292e6,
      startAngle: Math.PI - 1e-5, endAngle: Math.PI + 1e-5
    });
    d.entities.push({
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: -50, z: 0 }, end: { x: 0, y: 50, z: 0 }
    });
    const b = contentBounds(d)!;
    expect(b.max.x - b.min.x).toBeLessThan(1);
    expect(b.max.y - b.min.y).toBeLessThan(200);
  });
});

describe('a hatch edge that runs all but a hair of a full turn', () => {
  /* handle 2C1241 of BLOCKS.dwg: a boundary arc of radius 1969.322 whose
     ends are 4.96 units apart, flagged clockwise so the sampler took the
     long way and filled a 3938-unit disc. AutoCAD frames the reference
     that holds it at 1.66 units. */
  const edgeHatch = (ccw: boolean, a0: number, a1: number): Entity => ({
    type: 'hatch', layer: '0', color: { kind: 'byLayer' },
    patternName: 'LINE', solidFill: false, loops: [{
      kind: 'edges',
      edges: [
        {
          kind: 'arc', center: { x: 0, y: -1969.322 }, radius: 1969.322,
          startAngle: a0, endAngle: a1, ccw
        },
        {
          kind: 'line',
          start: { x: 1969.322 * Math.cos(a1), y: -1969.322 + 1969.322 * Math.sin(a1) },
          end: { x: 1969.322 * Math.cos(a0), y: -1969.322 + 1969.322 * Math.sin(a0) }
        }
      ]
    }]
  });

  it('samples the hair, not the disc', () => {
    const a0 = Math.PI / 2 - 0.00126, a1 = Math.PI / 2 + 0.00126;
    const pts = boundaryPoints((edgeHatch(false, a0, a1) as
      Extract<Entity, { type: 'hatch' }>).loops[0]);
    for (const p of pts) {
      expect(Math.abs(p.x)).toBeLessThan(10);
      expect(Math.abs(p.y)).toBeLessThan(10);
    }
    const b = entityBounds(edgeHatch(false, a0, a1))!;
    expect(b.max.x - b.min.x).toBeLessThan(10);
    expect(b.max.y - b.min.y).toBeLessThan(1);
  });

  it('leaves a boundary that really does go the long way', () => {
    /* 190 degrees clockwise is authored geometry, not a leftover: block
       cay4 of BLOCKS.dwg carries this arc and its mirror image, and the
       two must come out with the same sweep */
    const b = entityBounds(edgeHatch(false, 4.02010223769765, 6.976938906975314))!;
    /* the long way reaches the top and the left of the circle (y just
       under 0, x just over -1969); the short way would reach the bottom
       and the right instead (y down at -3938, x up at +1969) */
    expect(b.max.y).toBeGreaterThan(-10);
    expect(b.min.x).toBeLessThan(-1960);
  });

  it('leaves an island that really is a whole circle', () => {
    const b = entityBounds(edgeHatch(true, 0, TAU))!;
    expect(b.max.x - b.min.x).toBeCloseTo(2 * 1969.322, 6);
  });
});
