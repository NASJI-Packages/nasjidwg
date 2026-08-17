/* nasjidwg — DXF codec round-trip tests. */

import { describe, expect, it } from 'vitest';
import type {
  Drawing, Entity, HatchEntity, InsertEntity, MTextEntity, PolylineEntity,
  TextEntity
} from '../src/core/model.js';
import { emptyDrawing } from '../src/core/model.js';
import { writeDxf } from '../src/dxf/writer.js';
import { readDxf } from '../src/dxf/reader.js';

/* toBeCloseTo(_, 9) asserts |a-b| < 0.5e-9 — the required 1e-9 tolerance */
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

const one = <T extends Entity['type']>(d: Drawing, type: T) => {
  const found = d.entities.filter((e) => e.type === type);
  expect(found.length, `expected exactly one ${type}`).toBe(1);
  return found[0] as Extract<Entity, { type: T }>;
};

const buildDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.layers.push(
    { name: 'walls', color: { kind: 'rgb', rgb: 0x1234ab }, on: true, frozen: false, locked: false },
    { name: 'ghost', color: { kind: 'aci', index: 3 }, on: false, frozen: false, locked: false },
    { name: 'vault', color: { kind: 'aci', index: 5 }, on: true, frozen: false, locked: true }
  );
  d.blocks['door'] = {
    name: 'door',
    basePoint: { x: 0, y: 0, z: 0 },
    entities: [{
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 0.9, y: 0, z: 0 }
    }]
  };
  d.entities.push(
    {
      type: 'line', layer: 'walls', color: { kind: 'byLayer' },
      start: { x: 1, y: 2, z: 0 }, end: { x: 100.5, y: -3.25, z: 0 }
    },
    {
      type: 'circle', layer: '0', color: { kind: 'aci', index: 1 },
      center: { x: 10, y: 20, z: 0 }, radius: 7.75
    },
    {
      type: 'arc', layer: '0', color: { kind: 'byLayer' },
      center: { x: -5, y: 4, z: 0 }, radius: 3,
      startAngle: 0.25, endAngle: 2.5
    },
    {
      type: 'polyline', layer: 'walls', color: { kind: 'rgb', rgb: 0x00c0ff },
      closed: true, constantWidth: 0.35,
      vertices: [
        { x: 0, y: 0, bulge: 0.5, startWidth: 0.1, endWidth: 0.2 },
        { x: 10, y: 0 },
        { x: 10, y: 5, bulge: -0.25 }
      ]
    },
    {
      type: 'ellipse', layer: '0', color: { kind: 'byLayer' },
      center: { x: 5, y: 5, z: 0 }, majorAxis: { x: 4, y: 1, z: 0 },
      ratio: 0.5, startParam: 0.5, endParam: 2.5      /* PARTIAL — must survive */
    },
    {
      type: 'spline', layer: '0', color: { kind: 'byLayer' },
      degree: 3, closed: false,
      controlPoints: [
        { x: 0, y: 0, z: 0 }, { x: 3, y: 8, z: 0 },
        { x: 7, y: -2, z: 0 }, { x: 12, y: 4, z: 0 }
      ],
      knots: [0, 0, 0, 0, 1, 1, 1, 1],
      weights: [1, 2, 1, 1]
    },
    {
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 1, y: 2, z: 0 }, text: 'Hello DXF',
      height: 2.5, rotation: 0.3
    },
    {
      type: 'mtext', layer: '0', color: { kind: 'byLayer' },
      position: { x: 4, y: 9, z: 0 }, text: 'First line\nSecond line',
      height: 3, rotation: 0, attachment: 1
    },
    {
      type: 'hatch', layer: '0', color: { kind: 'byLayer' },
      patternName: 'ANSI31', solid: false, angle: 45, scale: 2,
      loops: [
        {
          kind: 'polyline', closed: true,
          vertices: [{ x: 0, y: 0, bulge: 0.3 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }]
        },
        { kind: 'circle', center: { x: 10, y: 6 }, radius: 2.5 }
      ]
    },
    {
      type: 'insert', layer: '0', color: { kind: 'byLayer' },
      blockName: 'door', position: { x: 3, y: 4, z: 0 },
      scale: { x: 2, y: 2, z: 1 }, rotation: Math.PI / 6
    }
  );
  return d;
};

describe('DXF round-trip', () => {
  const d2 = readDxf(writeDxf(buildDrawing()));

  it('geometry survives with 1e-9 tolerance', () => {
    const line = one(d2, 'line');
    near(line.start.x, 1); near(line.start.y, 2);
    near(line.end.x, 100.5); near(line.end.y, -3.25);
    expect(line.layer).toBe('walls');

    const circle = one(d2, 'circle');
    near(circle.center.x, 10); near(circle.center.y, 20); near(circle.radius, 7.75);
    expect(circle.color).toEqual({ kind: 'aci', index: 1 });

    const arc = one(d2, 'arc');
    near(arc.center.x, -5); near(arc.center.y, 4); near(arc.radius, 3);
    near(arc.startAngle, 0.25); near(arc.endAngle, 2.5);
  });

  it('lwpolyline keeps bulge, per-vertex widths and constant width', () => {
    const pl = one(d2, 'polyline') as PolylineEntity;
    expect(pl.closed).toBe(true);
    expect(pl.vertices.length).toBe(3);
    near(pl.vertices[0].bulge ?? 0, 0.5);
    near(pl.vertices[0].startWidth ?? 0, 0.1);
    near(pl.vertices[0].endWidth ?? 0, 0.2);
    expect(pl.vertices[1].bulge ?? 0).toBe(0);
    near(pl.vertices[2].bulge ?? 0, -0.25);
    near(pl.constantWidth ?? 0, 0.35);
    expect(pl.color).toEqual({ kind: 'rgb', rgb: 0x00c0ff });
  });

  it('partial ellipse keeps its exact parameters (no sampling)', () => {
    const el = one(d2, 'ellipse');
    near(el.center.x, 5); near(el.center.y, 5);
    near(el.majorAxis.x, 4); near(el.majorAxis.y, 1);
    near(el.ratio, 0.5);
    near(el.startParam, 0.5);
    near(el.endParam, 2.5);
  });

  it('spline keeps degree, knots, control points and weights exactly', () => {
    const sp = one(d2, 'spline');
    expect(sp.degree).toBe(3);
    expect(sp.closed).toBe(false);
    expect(sp.controlPoints.length).toBe(4);
    near(sp.controlPoints[1].x, 3); near(sp.controlPoints[1].y, 8);
    near(sp.controlPoints[2].x, 7); near(sp.controlPoints[2].y, -2);
    expect(sp.knots).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(sp.weights).toEqual([1, 2, 1, 1]);
  });

  it('text stays text; mtext stays mtext with its line break', () => {
    const tx = one(d2, 'text') as TextEntity;
    expect(tx.text).toBe('Hello DXF');
    near(tx.height, 2.5);
    near(tx.rotation, 0.3);

    const mt = one(d2, 'mtext') as MTextEntity;
    expect(mt.text).toBe('First line\nSecond line');
    near(mt.height, 3);
    expect(mt.attachment).toBe(1);
  });

  it('hatch keeps BOTH loops: bulged polyline and exact circle', () => {
    const h = one(d2, 'hatch') as HatchEntity;
    expect(h.solid).toBe(false);
    expect(h.patternName).toBe('ANSI31');
    near(h.angle, 45);
    near(h.scale, 2);
    expect(h.loops.length).toBe(2);
    const poly = h.loops.find((l) => l.kind === 'polyline');
    const circ = h.loops.find((l) => l.kind === 'circle');
    expect(poly && circ).toBeTruthy();
    if (poly?.kind === 'polyline') {
      expect(poly.vertices.length).toBe(4);
      near(poly.vertices[0].bulge ?? 0, 0.3);
      near(poly.vertices[2].x, 20); near(poly.vertices[2].y, 12);
    }
    if (circ?.kind === 'circle') {
      near(circ.center.x, 10); near(circ.center.y, 6); near(circ.radius, 2.5);
    }
  });

  it('block definition and insert survive', () => {
    expect(d2.blocks['door']).toBeTruthy();
    expect(d2.blocks['door'].entities.length).toBe(1);
    expect(d2.blocks['door'].entities[0].type).toBe('line');
    const ins = one(d2, 'insert') as InsertEntity;
    expect(ins.blockName).toBe('door');
    near(ins.position.x, 3); near(ins.position.y, 4);
    near(ins.scale.x, 2); near(ins.scale.y, 2);
    near(ins.rotation, Math.PI / 6);
  });

  it('layer color, off flag and lock flag survive', () => {
    const byName = new Map(d2.layers.map((l) => [l.name, l]));
    expect(byName.get('walls')?.color).toEqual({ kind: 'rgb', rgb: 0x1234ab });
    expect(byName.get('walls')?.on).toBe(true);
    expect(byName.get('ghost')?.on).toBe(false);
    expect(byName.get('ghost')?.color).toEqual({ kind: 'aci', index: 3 });
    expect(byName.get('vault')?.locked).toBe(true);
    expect(byName.get('vault')?.on).toBe(true);
  });

  it('round-trip produces no warnings', () => {
    expect(d2.warnings).toEqual([]);
  });
});

describe('Arabic policy', () => {
  const LOGICAL = 'مرحبا (اختبار) 123';

  it('writes MTEXT with presentation forms, never raw logical Arabic', () => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, text: LOGICAL, height: 5, rotation: 0
    } as TextEntity);
    const dxf = writeDxf(d);

    /* complex script must ride the MTEXT engine, never TEXT */
    expect(dxf).toContain('\nMTEXT\n');
    expect(dxf).not.toMatch(/\nTEXT\n/);

    /* everything above ASCII travels as \U+XXXX — no raw Arabic bytes */
    expect(dxf).not.toMatch(/[؀-ۿﭐ-ﻼ]/);

    /* the escapes must encode PRESENTATION FORMS (U+FB50..U+FEFC), and no
       escape may encode a logical Arabic letter (U+0600..U+06FF) */
    const escaped = [...dxf.matchAll(/\\U\+([0-9A-F]{4})/g)]
      .map((m) => parseInt(m[1], 16));
    expect(escaped.length).toBeGreaterThan(0);
    expect(escaped.some((cp) => cp >= 0xfb50 && cp <= 0xfefc)).toBe(true);
    expect(escaped.some((cp) => cp >= 0x0600 && cp <= 0x06ff)).toBe(false);
  });

  it('reads the exact logical string back (unshaped, brackets unmirrored)', () => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, text: LOGICAL, height: 5, rotation: 0
    } as TextEntity);
    const d2 = readDxf(writeDxf(d));
    /* complex-script text comes back through the MTEXT lane */
    const mt = d2.entities.find((e) => e.type === 'mtext') as MTextEntity;
    expect(mt).toBeTruthy();
    expect(mt.text).toBe(LOGICAL);
  });
});

describe('legacy records', () => {
  it('heavyweight POLYLINE + VERTEX + SEQEND becomes a polyline with bulges', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'POLYLINE', '8', '0', '66', '1', '70', '1', '40', '0.5', '41', '0.5',
      '0', 'VERTEX', '8', '0', '10', '0', '20', '0', '42', '1',
      '0', 'VERTEX', '8', '0', '10', '4', '20', '0',
      '0', 'VERTEX', '8', '0', '10', '4', '20', '3',
      '0', 'SEQEND',
      '0', 'ENDSEC', '0', 'EOF', ''
    ].join('\n');
    const d = readDxf(dxf);
    const pl = one(d, 'polyline') as PolylineEntity;
    expect(pl.closed).toBe(true);
    expect(pl.vertices.length).toBe(3);
    near(pl.vertices[0].bulge ?? 0, 1);
    near(pl.vertices[1].startWidth ?? 0, 0.5);   /* POLYLINE default width */
  });

  it('ATTRIB records after INSERT land on insert.attributes', () => {
    const dxf = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'title', '10', '0', '20', '0',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '8', '0', '66', '1', '2', 'title', '10', '5', '20', '5',
      '0', 'ATTRIB', '8', '0', '10', '6', '20', '6', '40', '2.5', '1', 'Sheet 1', '2', 'TITLE',
      '0', 'SEQEND',
      '0', 'ENDSEC', '0', 'EOF', ''
    ].join('\n');
    const d = readDxf(dxf);
    const ins = one(d, 'insert') as InsertEntity;
    expect(ins.blockName).toBe('title');
    expect(ins.attributes?.length).toBe(1);
    expect(ins.attributes?.[0].text).toBe('Sheet 1');
    near(ins.attributes?.[0].height ?? 0, 2.5);
  });
});

describe('tolerant reader', () => {
  it('truncated garbage yields an empty drawing plus warnings, no throw', () => {
    const garbage = 'this is not\na dxf file\n0\nSECTION\n2\nENTIT';
    let d: Drawing | null = null;
    expect(() => { d = readDxf(garbage); }).not.toThrow();
    expect(d!.entities).toEqual([]);
    expect(d!.warnings.length).toBeGreaterThan(0);
  });

  it('empty input does not throw', () => {
    expect(() => readDxf('')).not.toThrow();
  });
});

/* the dimensioning sizes travel through DXF the same way they travel
 * through DWG — one vars record, plain numbers */
describe('DXF header DIM vars', () => {
  it('round-trip through the ASCII writer and reader', () => {
    const d = emptyDrawing();
    d.header.vars = {
      DIMASZ: 1.75, DIMTXT: 0.9, DIMSCALE: 50, DIMDEC: 3, PDMODE: 34, PDSIZE: 1.5
    };
    d.entities.push({
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
    });
    const text = writeDxf(d);
    expect(text).toContain('$DIMASZ');
    const back = readDxf(text);
    expect(back.header.vars?.DIMASZ).toBeCloseTo(1.75, 9);
    expect(back.header.vars?.DIMTXT).toBeCloseTo(0.9, 9);
    expect(back.header.vars?.DIMSCALE).toBeCloseTo(50, 9);
    expect(back.header.vars?.DIMDEC).toBe(3);
    expect(back.header.vars?.PDMODE).toBe(34);
    expect(back.header.vars?.PDSIZE).toBeCloseTo(1.5, 9);
  });
});
