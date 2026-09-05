/* nasjidwg — heavy polylines (POLYLINE + VERTEX + SEQEND), vertex
 * identifiers and the dynamic block's true name.
 *
 * A 3D polyline keeps its Z, a spline-fit one keeps its frame apart from
 * the fitted curve, a curve-fit one marks the inserted vertices, an
 * LWPOLYLINE keeps its R2010+ vertex ids — through the DWG writer/reader
 * and the DXF writer/reader alike. */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2018 } from '../src/dwg/writer.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, PolylineEntity } from '../src/core/model.js';

const near = (a: number | undefined, b: number): void =>
  expect(a ?? NaN).toBeCloseTo(b, 9);

const build = (): Drawing => {
  const d = emptyDrawing();
  d.layers.push({ name: 'terrain', color: { kind: 'aci', index: 3 },
    on: true, frozen: false, locked: false });
  d.entities.push(
    /* a 3D polyline: Z on every vertex, closed, its own colour */
    { type: 'polyline', layer: 'terrain', color: { kind: 'aci', index: 1 },
      closed: true, heavy: '3d',
      vertices: [
        { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 5 },
        { x: 10, y: 10, z: -2.5 }, { x: 0, y: 10, z: 7.25 }
      ] },
    /* 3D by its Z alone: no `heavy`, still a POLYLINE */
    { type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
      vertices: [{ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }, { x: 3, y: 1, z: 4 }] },
    /* a heavy 2D polyline: bulges, widths, elevation, plinegen */
    { type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
      heavy: '2d', elevation: 3, plineGen: true,
      vertices: [
        { x: 0, y: 0, bulge: 0.5, startWidth: 0.1, endWidth: 0.2 },
        { x: 5, y: 0 },
        { x: 5, y: 5, startWidth: 0.3, endWidth: 0.3 }
      ] },
    /* spline-fit (quadratic): the frame apart from the fitted curve */
    { type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
      heavy: '2d', fit: 'quadratic',
      frame: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }],
      vertices: [
        { x: 0, y: 0 }, { x: 2.5, y: 2.5 }, { x: 5, y: 3.75 },
        { x: 7.5, y: 2.5 }, { x: 10, y: 0 }
      ] },
    /* curve-fit: the inserted vertex marked, a tangent on the first */
    { type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
      heavy: '2d', fit: 'curve',
      vertices: [
        { x: 0, y: 0, bulge: 0.2, tangent: 0.5 },
        { x: 2, y: 1, curveFit: true, bulge: 0.1 },
        { x: 4, y: 0 }
      ] },
    /* an LWPOLYLINE with vertex ids and plinegen */
    { type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: true,
      plineGen: true,
      vertices: [{ x: 0, y: 0, id: 1 }, { x: 1, y: 0, id: 2 }, { x: 1, y: 1, id: 3 }] },
    /* a plain LWPOLYLINE stays one */
    { type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }
  );
  return d;
};

const polylines = (d: Drawing): PolylineEntity[] =>
  d.entities.filter((e): e is PolylineEntity => e.type === 'polyline');

/** What every medium must bring back; `ids` is false where the format
 *  predates vertex identifiers (R2000). */
const check = (back: Drawing, ids = true): void => {
  const pl = polylines(back);
  expect(pl.length).toBe(7);
  const [p3d, byZ, p2d, spline, curve, lwIds, lw] = pl;

  expect(p3d.heavy).toBe('3d');
  expect(p3d.closed).toBe(true);
  expect(p3d.layer).toBe('terrain');
  expect(p3d.color).toEqual({ kind: 'aci', index: 1 });
  expect(p3d.vertices.map((v) => v.z)).toEqual([0, 5, -2.5, 7.25]);
  near(p3d.vertices[1].x, 10); near(p3d.vertices[2].y, 10);

  expect(byZ.heavy).toBe('3d');
  expect(byZ.vertices.map((v) => v.z)).toEqual([1, 2, 4]);

  expect(p2d.heavy).toBe('2d');
  expect(p2d.fit).toBeUndefined();
  near(p2d.elevation, 3);
  expect(p2d.plineGen).toBe(true);
  near(p2d.vertices[0].bulge, 0.5);
  near(p2d.vertices[0].startWidth, 0.1); near(p2d.vertices[0].endWidth, 0.2);
  expect(p2d.vertices[1].bulge ?? 0).toBe(0);
  near(p2d.vertices[2].startWidth, 0.3); near(p2d.vertices[2].endWidth, 0.3);
  expect(p2d.vertices.every((v) => v.z === undefined)).toBe(true);

  expect(spline.heavy).toBe('2d');
  expect(spline.fit).toBe('quadratic');
  expect(spline.frame?.length).toBe(3);
  near(spline.frame?.[1].x, 5); near(spline.frame?.[1].y, 5);
  expect(spline.vertices.length).toBe(5);
  near(spline.vertices[2].y, 3.75);

  expect(curve.fit).toBe('curve');
  expect(curve.vertices.length).toBe(3);
  expect(curve.vertices[0].curveFit).toBeUndefined();
  expect(curve.vertices[1].curveFit).toBe(true);
  near(curve.vertices[0].tangent, 0.5);
  expect(curve.vertices[2].tangent).toBeUndefined();
  near(curve.vertices[1].bulge, 0.1);

  expect(lwIds.heavy).toBeUndefined();
  expect(lwIds.closed).toBe(true);
  expect(lwIds.plineGen).toBe(true);
  if (ids) expect(lwIds.vertices.map((v) => v.id)).toEqual([1, 2, 3]);

  expect(lw.heavy).toBeUndefined();
  expect(lw.vertices.some((v) => v.z !== undefined || v.id)).toBe(false);
};

describe('heavy polylines: DWG round trip', () => {
  it('R2018 keeps Z, fit, frame, flags and vertex ids', () => {
    const back = readDwg(writeDwg2018(build()).data);
    expect(back.warnings).toEqual([]);
    check(back);
  });

  it('R2018 with preserved handles', () => {
    const d = build();
    const first = readDwg(writeDwg2018(d).data);
    const again = readDwg(writeDwg2018(first, { preserveHandles: true }).data);
    expect(again.warnings).toEqual([]);
    check(again);
    expect(polylines(again).map((p) => p.handle))
      .toEqual(polylines(first).map((p) => p.handle));
  });

  it('R2000 keeps everything but the ids it cannot spell', () => {
    const back = readDwg(writeDwg2000(build()).data);
    expect(back.warnings).toEqual([]);
    check(back, false);
  });
});

describe('heavy polylines: DXF round trip', () => {
  it('POLYLINE/VERTEX/SEQEND and LWPOLYLINE 91 both ways', () => {
    const text = writeDxf(build());
    /* the heavy ones are POLYLINE records, the light ones LWPOLYLINE */
    expect((text.match(/^POLYLINE\r?$/gm) ?? []).length).toBe(5);
    expect((text.match(/^LWPOLYLINE\r?$/gm) ?? []).length).toBe(2);
    expect((text.match(/^SEQEND\r?$/gm) ?? []).length).toBe(5);
    expect(text).toMatch(/AcDb3dPolylineVertex/);
    expect(text).toMatch(/AcDb2dVertex/);
    check(readDxf(text));
  });

  it('a POLYLINE read from DXF is written back as a POLYLINE, not flattened', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'POLYLINE', '8', '0', '66', '1', '70', '8',
      '0', 'VERTEX', '8', '0', '10', '0', '20', '0', '30', '1', '70', '32',
      '0', 'VERTEX', '8', '0', '10', '4', '20', '0', '30', '2', '70', '32',
      '0', 'VERTEX', '8', '0', '10', '4', '20', '3', '30', '3', '70', '32',
      '0', 'SEQEND',
      '0', 'ENDSEC', '0', 'EOF', ''
    ].join('\n');
    const d = readDxf(dxf);
    const p = polylines(d)[0];
    expect(p.heavy).toBe('3d');
    expect(p.vertices.map((v) => v.z)).toEqual([1, 2, 3]);
    const back = readDwg(writeDwg2018(d).data);
    expect(polylines(back)[0].vertices.map((v) => v.z)).toEqual([1, 2, 3]);
  });
});

describe('the dynamic block true name', () => {
  const SAMPLE = 'C:/Program Files/Autodesk/AutoCAD 2027/Sample/Sheet Sets/Architectural/A-01.dwg';
  const present = existsSync(SAMPLE);

  const allEntities = (d: Drawing): Entity[] => [
    ...d.entities, ...(d.paperSpace ?? []),
    ...Object.values(d.blocks).flatMap((b) => b.entities)
  ];

  /* every INSERT names a block the drawing defines — the dynamic block's
     references point at its anonymous representations (*B1, *B2), the
     promoted definition is what they derive from */
  const insertsResolve = (d: Drawing): boolean => allEntities(d)
    .filter((e) => e.type === 'insert')
    .every((e) => e.type === 'insert' && e.blockName in d.blocks);

  it.skipIf(!present)('a "*U" record with AcDbDynamicBlockTrueName reads under that name', () => {
    const d = readDwg(readFileSync(SAMPLE));
    expect(Object.keys(d.blocks)).toContain('Drawing Title');
    expect(Object.keys(d.blocks).some((n) => /^\*U\d+$/.test(n))).toBe(false);
    expect(d.blocks['Drawing Title'].entities.length).toBeGreaterThan(0);
    expect(insertsResolve(d)).toBe(true);
  });

  it.skipIf(!present)('and is written back as a named, non-anonymous block its INSERTs still find', () => {
    const d = readDwg(readFileSync(SAMPLE));
    const back = readDwg(writeDwg2018(d, { preserveHandles: true }).data);
    expect(Object.keys(back.blocks)).toContain('Drawing Title');
    expect(Object.keys(back.blocks).some((n) => /^\*U\d+$/.test(n))).toBe(false);
    expect(insertsResolve(back)).toBe(true);
    expect(back.blocks['Drawing Title'].entities.length)
      .toBe(d.blocks['Drawing Title'].entities.length);
  });
});
