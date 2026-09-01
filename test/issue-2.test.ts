/* nasjidwg — issue #2: write-side losses the reader could not see.
 *
 * The same 72 MB production drawing as issue #1, through
 * readDwg → writeDwg2018({ preserveHandles: true }) → readDwg:
 *
 * - every OCS entity but ELLIPSE had its plane normal forged to +Z
 *   (698 arcs, 20 circles, 23 inserts, 50 polylines landed displaced;
 *   a forged ellipse normal already made AutoCAD 2027 refuse a file,
 *   ErrorStatus 53)
 * - XDATA / EED was never written (including two DIMENSION DSTYLE
 *   overrides)
 * - ATTRIB dropped center/middle alignment and minted a fresh handle
 *   despite preserveHandles; HATCH associative arrived undefined
 *   because the generating-entity handles were discarded
 *
 * Associative-with-no-boundary is an AutoCAD AUDIT error on every such
 * hatch, so a hatch without remappable handles still leaves as
 * non-associative — see r2018-oracle-fixes.test.ts. When the handles
 * do remap, the writer also rebuilds the reactor on each boundary
 * entity (the reader does not model reactors); without that back-link
 * AutoCAD 2027 AUDIT reports "Boundary Missing a Reactor — Remove
 * Associativity".
 */

import { describe, expect, it } from 'vitest';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, InsertEntity, TextEntity } from '../src/core/model.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2018, writeDwgR14 } from '../src/dwg/writer.js';

const byLayer = { kind: 'byLayer' } as const;
const MIRROR = { x: 0, y: 0, z: -1 };

const one = (e: Entity): Drawing => {
  const d = emptyDrawing();
  d.entities = [e];
  return d;
};

const writers = [
  ['R14', writeDwgR14],
  ['R2000', writeDwg2000],
  ['R2018', writeDwg2018]
] as const;

describe('issue #2: OCS extrusion is not forged to +Z', () => {
  it.each(writers)('%s: arc / circle / text / polyline / mtext / insert / dimension',
    (_v, write) => {
      const d = emptyDrawing();
      d.blocks.DOOR = {
        name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
        entities: [{
          type: 'line', layer: '0', color: byLayer,
          start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
        }]
      };
      d.entities = [
        {
          type: 'arc', layer: '0', color: byLayer,
          center: { x: 1, y: 2, z: 0 }, radius: 3, startAngle: 0.2, endAngle: 1.2,
          extrusion: MIRROR
        },
        {
          type: 'circle', layer: '0', color: byLayer,
          center: { x: 4, y: 5, z: 0 }, radius: 2, extrusion: MIRROR
        },
        {
          type: 'text', layer: '0', color: byLayer,
          position: { x: 0, y: 0, z: 0 }, text: 'n', height: 2.5, rotation: 0,
          extrusion: MIRROR
        },
        {
          type: 'mtext', layer: '0', color: byLayer,
          position: { x: 1, y: 1, z: 0 }, text: 'm', height: 2, rotation: 0,
          extrusion: MIRROR
        },
        {
          type: 'polyline', layer: '0', color: byLayer, closed: true,
          vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
          extrusion: MIRROR
        },
        {
          type: 'insert', layer: '0', color: byLayer, blockName: 'DOOR',
          position: { x: 8, y: 8, z: 0 }, rotation: 0, extrusion: MIRROR
        },
        {
          type: 'dimension', layer: '0', color: byLayer, kind: 'linear',
          dimensionType: 0, definitionPoint: { x: 5, y: 1, z: 0 },
          textMidpoint: { x: 2.5, y: 1.2, z: 0 },
          insertionPoint: { x: 2.5, y: 1, z: 0 },
          point13: { x: 0, y: 0, z: 0 }, point14: { x: 5, y: 0, z: 0 },
          rotation: 0, extrusion: MIRROR
        }
      ];
      const { data, skipped } = write(d);
      expect(skipped).toEqual([]);
      const back = readDwg(data);
      const types = ['arc', 'circle', 'text', 'mtext', 'polyline', 'insert',
        'dimension'] as const;
      for (const t of types) {
        const e = back.entities.find((q) => q.type === t);
        expect(e?.extrusion, t).toEqual(MIRROR);
      }
    });
});

describe('issue #2: XDATA / EED is written, not dropped', () => {
  const xdataDrawing = (): Drawing => {
    const d = emptyDrawing();
    d.entities = [
      {
        type: 'line', layer: '0', color: byLayer, handle: 'A1',
        start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 },
        xdata: [{
          appName: 'NASJI',
          values: [
            { code: 1000, value: 'hello xdata' },
            { code: 1002, value: '{' },
            { code: 1040, value: 3.25 },
            { code: 1070, value: 42 },
            { code: 1010, point: { x: 5, y: 6, z: 7 } },
            { code: 1005, value: 'A1' },
            { code: 1002, value: '}' }
          ]
        }]
      },
      {
        type: 'dimension', layer: '0', color: byLayer, kind: 'linear',
        dimensionType: 0, definitionPoint: { x: 5, y: 1, z: 0 },
        textMidpoint: { x: 2.5, y: 1.2, z: 0 },
        insertionPoint: { x: 2.5, y: 1, z: 0 },
        point13: { x: 0, y: 0, z: 0 }, point14: { x: 5, y: 0, z: 0 },
        rotation: 0,
        xdata: [{
          appName: 'ACAD',
          values: [
            { code: 1000, value: 'DSTYLE' },
            { code: 1002, value: '{' },
            { code: 1070, value: 40 },
            { code: 1040, value: 2.5 },
            { code: 1002, value: '}' }
          ]
        }]
      }
    ];
    return d;
  };

  it.each(writers)('%s: NASJI values and ACAD DSTYLE survive', (_v, write) => {
    const { data, skipped } = write(xdataDrawing());
    expect(skipped).toEqual([]);
    const back = readDwg(data);
    expect(back.appIds?.some((n) => n.toUpperCase() === 'NASJI')).toBe(true);

    const line = back.entities.find((e) => e.type === 'line');
    expect(line?.xdata?.length).toBe(1);
    const g = line!.xdata![0];
    expect(g.appName?.toUpperCase()).toBe('NASJI');
    expect(g.values[0]).toEqual({ code: 1000, value: 'hello xdata' });
    expect(g.values[1]).toEqual({ code: 1002, value: '{' });
    expect(g.values[2]).toEqual({ code: 1040, value: 3.25 });
    expect(g.values[3]).toEqual({ code: 1070, value: 42 });
    expect(g.values[4]).toEqual({ code: 1010, point: { x: 5, y: 6, z: 7 } });
    /* 1005 remaps onto the handle this file actually assigned */
    expect(g.values[5]).toEqual({
      code: 1005, value: (line!.handle ?? '').toUpperCase()
    });
    expect(g.values[6]).toEqual({ code: 1002, value: '}' });

    const dim = back.entities.find((e) => e.type === 'dimension');
    expect(dim?.xdata?.[0].appName?.toUpperCase()).toBe('ACAD');
    expect(dim?.xdata?.[0].values).toEqual([
      { code: 1000, value: 'DSTYLE' },
      { code: 1002, value: '{' },
      { code: 1070, value: 40 },
      { code: 1040, value: 2.5 },
      { code: 1002, value: '}' }
    ]);
  });
});

describe('issue #2: ATTRIB alignment and preserveHandles', () => {
  const justified = (): Drawing => {
    const d = emptyDrawing();
    d.blocks.TAG = {
      name: 'TAG', basePoint: { x: 0, y: 0, z: 0 },
      entities: [{
        type: 'line', layer: '0', color: byLayer,
        start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
      }]
    };
    d.entities = [{
      type: 'insert', layer: '0', color: byLayer, handle: '50',
      blockName: 'TAG', position: { x: 5, y: 5, z: 0 }, rotation: 0,
      attributes: [{
        type: 'text', layer: '0', color: byLayer, handle: '51',
        position: { x: 5, y: 5, z: 0 },
        alignmentPoint: { x: 6, y: 5.5, z: 0 },
        text: 'CENTERED', height: 2, rotation: 0,
        halign: 'center', valign: 'middle',
        attribute: 'attrib'
      }]
    }];
    return d;
  };

  const checkAlign = (back: Drawing): TextEntity => {
    const ins = back.entities.find((e) => e.type === 'insert') as InsertEntity;
    const attr = ins?.attributes?.[0];
    expect(attr?.attribute).toBe('attrib');
    expect(attr?.halign).toBe('center');
    expect(attr?.valign).toBe('middle');
    expect(attr?.alignmentPoint?.x).toBeCloseTo(6, 9);
    expect(attr?.alignmentPoint?.y).toBeCloseTo(5.5, 9);
    return attr!;
  };

  it.each(writers)('%s: center/middle and alignmentPoint survive', (_v, write) => {
    const { data, skipped } = write(justified());
    expect(skipped).toEqual([]);
    checkAlign(readDwg(data));
  });

  it('preserveHandles keeps the attrib handle, not a minted one', () => {
    const { data, skipped } = writeDwg2018(justified(), { preserveHandles: true });
    expect(skipped).toEqual([]);
    const back = readDwg(data);
    const attr = checkAlign(back);
    expect(attr.handle).toBe('51');
    const ins = back.entities.find((e) => e.type === 'insert') as InsertEntity;
    expect(ins.handle).toBe('50');
  });
});

describe('issue #2: HATCH associativity rides real boundary handles', () => {
  const square = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
  ];

  const linked = (): Drawing => {
    const d = emptyDrawing();
    d.entities = [
      {
        type: 'polyline', layer: '0', color: byLayer, handle: 'A1',
        closed: true, vertices: square
      },
      {
        type: 'hatch', layer: '0', color: byLayer,
        patternName: 'SOLID', solid: true, angle: 0, scale: 1,
        associative: true,
        loops: [{
          kind: 'polyline', closed: true, vertices: square,
          boundaryHandles: ['A1']
        }]
      }
    ];
    return d;
  };

  it.each(writers)('%s: remaps the polyline handle onto the hatch', (_v, write) => {
    const { data, skipped } = write(linked());
    expect(skipped).toEqual([]);
    const back = readDwg(data);
    const pl = back.entities.find((e) => e.type === 'polyline');
    const h = back.entities.find((e) => e.type === 'hatch');
    expect(h?.type).toBe('hatch');
    if (h?.type !== 'hatch') return;
    expect(h.associative).toBe(true);
    expect(h.loops[0].boundaryHandles).toEqual([(pl?.handle ?? '').toUpperCase()]);
  });

  it('preserveHandles keeps the source boundary handle', () => {
    const back = readDwg(writeDwg2018(linked(), { preserveHandles: true }).data);
    const h = back.entities.find((e) => e.type === 'hatch');
    expect(h?.type === 'hatch' && h.associative).toBe(true);
    if (h?.type !== 'hatch') return;
    expect(h.loops[0].boundaryHandles).toEqual(['A1']);
    expect(back.entities.find((e) => e.type === 'polyline')?.handle).toBe('A1');
  });

  it('associative with no remappable handles still leaves as non-associative', () => {
    const back = readDwg(writeDwg2018(one({
      type: 'hatch', layer: '0', color: byLayer,
      patternName: 'SOLID', solid: true, angle: 0, scale: 1,
      associative: true,
      loops: [{
        kind: 'polyline', closed: true, vertices: square,
        boundaryHandles: ['DEAD']
      }]
    })).data);
    const h = back.entities.find((e) => e.type === 'hatch');
    expect(h?.type === 'hatch' && h.associative).toBeUndefined();
  });
});
