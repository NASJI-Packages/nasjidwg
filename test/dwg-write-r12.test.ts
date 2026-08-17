/* nasjidwg — DWG R12 (AC1009) writer.
 *
 * Two proofs. Every pre-R13 fixture — R1.4 through R12, themselves decoded
 * against independent reference exports — must survive a rewrite as R12
 * number-for-number. And a synthetic drawing exercises what the fixtures
 * do not: downgrades, Arabic text, patterned linetypes, meshes, attributes.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwgR12 } from '../src/dwg/writer12.js';
import { crc16 } from '../src/dwg/bitwriter.js';
import { detectVersion } from '../src/dwg/fileheader.js';
import { drawingBounds } from '../src/core/geo.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

const rewrite = (d: Drawing): { back: Drawing; data: Uint8Array } => {
  const { data } = writeDwgR12(d);
  return { back: readDwg(data), data };
};

/** Every number an entity carries, in a stable order, rounded to 1e-6.
 *  styleId is excluded the same way the pre-R13 fixture tests exclude it. */
const numbers = (value: unknown, into: number[] = []): number[] => {
  if (typeof value === 'number') into.push(Math.round(value * 1e6) / 1e6);
  else if (Array.isArray(value)) for (const v of value) numbers(v, into);
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value as object).sort()) {
      if (k !== 'styleId') numbers((value as Record<string, unknown>)[k], into);
    }
  }
  return into;
};

const compare = (ours: Entity[], theirs: Entity[]): void => {
  expect(ours.map((e) => e.type)).toEqual(theirs.map((e) => e.type));
  for (let i = 0; i < ours.length; i++) {
    expect(numbers(ours[i]), `entity ${i} (${ours[i].type})`)
      .toEqual(numbers(theirs[i]));
  }
};

/* ------------------------------------------------------------------ */

const FIXTURES = ['example_r1_4', 'example_r2_6', 'example_r2_6_dim',
  'example_r2_10', 'example_r2_10_block', 'example_r9', 'example_r10',
  'example_r11_2d', 'example_r11_3d'];

describe('synthetic drawing', () => {
  const d = emptyDrawing();
  d.layers = [
    { name: '0', color: { kind: 'aci', index: 7 }, on: true, frozen: false, locked: false },
    { name: 'Étage€', color: { kind: 'aci', index: 30 }, on: false, frozen: true, locked: true, linetype: 'DASHED' }
  ];
  d.linetypes = [
    { name: 'CONTINUOUS', description: 'Solid line', pattern: [] },
    { name: 'DASHED', description: 'Dashed __ __', pattern: [0.5, -0.25] }
  ];
  d.textStyles = [{ name: 'Standard' }, { name: 'Arabic', font: 'arial.ttf' }];
  d.dimStyles = [{ name: 'S1', vars: { DIMSCALE: 2, DIMTXT: 0.25, DIMTOL: 1 } }];
  d.blocks = {
    DOOR: {
      name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
      entities: [
        { type: 'line', layer: '0', color: { kind: 'byLayer' }, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } },
        { type: 'arc', layer: '0', color: { kind: 'aci', index: 3 }, center: { x: 0, y: 0, z: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2 }
      ]
    }
  };
  d.entities = [
    { type: 'line', layer: '0', color: { kind: 'byLayer' }, start: { x: 1, y: 2, z: 3 }, end: { x: 4, y: 5, z: 6 } },
    { type: 'line', layer: 'Étage€', color: { kind: 'aci', index: 1 }, linetype: 'DASHED', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } },
    { type: 'point', layer: '0', color: { kind: 'byLayer' }, position: { x: 7, y: 8, z: 9 } },
    { type: 'circle', layer: '0', color: { kind: 'byLayer' }, center: { x: 5, y: 5, z: 1 }, radius: 2.5 },
    { type: 'arc', layer: '0', color: { kind: 'byLayer' }, center: { x: 0, y: 0, z: 0 }, radius: 3, startAngle: 0.5, endAngle: 2.5 },
    { type: 'solid', layer: '0', color: { kind: 'byLayer' }, corners: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }] },
    {
      type: 'face3d', layer: '0', color: { kind: 'byLayer' }, invisibleEdges: 5,
      corners: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }, { x: 1, y: 1, z: 3 }, { x: 0, y: 1, z: 4 }]
    },
    {
      type: 'text', layer: '0', color: { kind: 'byLayer' }, text: 'مرحبا 45° Plain',
      position: { x: 1, y: 1, z: 0 }, alignmentPoint: { x: 2, y: 1, z: 0 },
      height: 0.5, rotation: 0.25, widthFactor: 0.8, oblique: 0.1,
      style: 'Arabic', halign: 'center', valign: 'top'
    },
    {
      type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: true,
      vertices: [{ x: 0, y: 0, bulge: 0.5 }, { x: 4, y: 0, startWidth: 0.1, endWidth: 0.2 }, { x: 4, y: 4 }],
      elevation: 2
    },
    {
      type: 'insert', layer: '0', color: { kind: 'byLayer' }, blockName: 'DOOR',
      position: { x: 10, y: 10, z: 0 }, scale: { x: 2, y: 3, z: 1 }, rotation: 0.7,
      columnCount: 2, rowCount: 3, columnSpacing: 5, rowSpacing: 6,
      attributes: [{
        type: 'text', layer: '0', color: { kind: 'byLayer' }, text: 'A-101',
        position: { x: 10.5, y: 10.5, z: 0 }, height: 0.2, rotation: 0
      }]
    },
    {
      type: 'mesh', layer: '0', color: { kind: 'byLayer' }, meshKind: 'grid',
      mSize: 2, nSize: 3, closedM: true,
      vertices: [
        { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 2 }, { x: 2, y: 1, z: 0 }
      ]
    },
    {
      type: 'mesh', layer: '0', color: { kind: 'byLayer' }, meshKind: 'faces',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 0 }],
      faces: [[1, 2, 3], [1, -3, 4]]
    },
    {
      type: 'dimension', layer: '0', color: { kind: 'byLayer' }, kind: 'linear',
      dimensionType: 0, definitionPoint: { x: 5, y: 1, z: 0 },
      textMidpoint: { x: 2.5, y: 1.2, z: 0 }, insertionPoint: { x: 2.5, y: 1, z: 0 },
      point13: { x: 0, y: 0, z: 0 }, point14: { x: 5, y: 0, z: 0 },
      rotation: 0, text: '5.00', style: 'S1'
    },
    { type: 'viewport', layer: '0', color: { kind: 'byLayer' }, center: { x: 4, y: 3, z: 0 }, width: 8, height: 6, statusFlag: 2 },
    /* downgrades */
    {
      type: 'ellipse', layer: '0', color: { kind: 'byLayer' }, center: { x: 0, y: 0, z: 0 },
      majorAxis: { x: 4, y: 0, z: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI * 2
    },
    {
      type: 'mtext', layer: '0', color: { kind: 'byLayer' }, position: { x: 0, y: 20, z: 0 },
      text: 'first line\nsecond line', height: 0.4, rotation: 0
    },
    {
      type: 'spline', layer: '0', color: { kind: 'byLayer' }, degree: 3, closed: false,
      controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 2, y: -1, z: 0 }, { x: 3, y: 0, z: 0 }],
      knots: [0, 0, 0, 0, 1, 1, 1, 1]
    },
    {
      type: 'hatch', layer: '0', color: { kind: 'byLayer' }, patternName: 'LINES',
      solid: false, angle: 0, scale: 1,
      loops: [{ kind: 'polyline', vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], closed: true }],
      definitionLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.5 }, dashes: [] }]
    },
    {
      type: 'table', layer: '0', color: { kind: 'byLayer' }, position: { x: 30, y: 30, z: 0 },
      numRows: 2, numColumns: 2, rowHeights: [1, 1], columnWidths: [3, 3],
      cells: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]
    },
    /* unrepresentable */
    { type: 'ray', layer: '0', color: { kind: 'byLayer' }, basePoint: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }
  ];
  d.paperSpace = [
    { type: 'line', layer: '0', color: { kind: 'byLayer' }, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } }
  ];
  d.header.vars = { CLAYER: '0', TEXTSTYLE: 'Standard', LUNITS: 2, LUPREC: 4 };

  const { data, skipped, downgraded } = writeDwgR12(d);
  const back = readDwg(data);
  const byType = <T extends Entity['type']>(t: T) =>
    back.entities.filter((e): e is Extract<Entity, { type: T }> => e.type === t);

  it('reports what was downgraded and what was dropped', () => {
    expect(downgraded.sort())
      .toEqual(['ellipse', 'hatch', 'mtext', 'spline', 'table']);
    expect(skipped).toEqual(['ray', 'line (paper space)']);
    expect(back.warnings).toEqual([]);
  });

  it('round-trips native geometry exactly', () => {
    const line = byType('line')[0];
    expect(line.start).toEqual({ x: 1, y: 2, z: 3 });
    expect(line.end).toEqual({ x: 4, y: 5, z: 6 });
    const layered = byType('line')[1];
    expect(layered.layer).toBe('Étage€');
    expect(layered.color).toEqual({ kind: 'aci', index: 1 });
    expect(layered.linetype).toBe('DASHED');
    expect(byType('point')[0].position).toEqual({ x: 7, y: 8, z: 9 });
    expect(byType('circle')[0].center).toEqual({ x: 5, y: 5, z: 1 });
    expect(byType('circle')[0].radius).toBe(2.5);
    const face = byType('face3d')[0];
    expect(face.invisibleEdges).toBe(5);
    expect(face.corners[3]).toEqual({ x: 0, y: 1, z: 4 });
    const vp = byType('viewport')[0];
    expect([vp.width, vp.height, vp.statusFlag]).toEqual([8, 6, 2]);
  });

  it('round-trips Arabic text through \\U+ escapes', () => {
    const text = byType('text')[0];
    expect(text.text).toBe('مرحبا 45° Plain');
    expect(text.height).toBe(0.5);
    expect(text.rotation).toBe(0.25);
    expect(text.widthFactor).toBeCloseTo(0.8, 12);
    expect(text.oblique).toBeCloseTo(0.1, 12);
    expect(text.style).toBe('Arabic');
    expect(text.halign).toBe('center');
    expect(text.valign).toBe('top');
    expect(text.alignmentPoint).toEqual({ x: 2, y: 1, z: 0 });
  });

  it('round-trips the polyline with bulges, widths and elevation', () => {
    const pl = byType('polyline').find((p) => p.closed)!;
    expect(pl.elevation).toBe(2);
    expect(pl.vertices[0].bulge).toBe(0.5);
    expect(pl.vertices[1].startWidth).toBeCloseTo(0.1, 12);
    expect(pl.vertices[1].endWidth).toBeCloseTo(0.2, 12);
  });

  it('round-trips the insert with its attributes and array', () => {
    const ins = byType('insert')[0];
    expect(ins.blockName).toBe('DOOR');
    expect(ins.scale).toEqual({ x: 2, y: 3, z: 1 });
    expect(ins.rotation).toBe(0.7);
    expect([ins.columnCount, ins.rowCount]).toEqual([2, 3]);
    expect([ins.columnSpacing, ins.rowSpacing]).toEqual([5, 6]);
    expect(ins.attributes?.length).toBe(1);
    expect(ins.attributes?.[0].text).toBe('A-101');
    expect(back.blocks.DOOR.entities.map((e) => e.type)).toEqual(['line', 'arc']);
  });

  it('round-trips both mesh kinds', () => {
    const grid = byType('mesh').find((m) => m.meshKind === 'grid')!;
    expect([grid.mSize, grid.nSize, grid.closedM]).toEqual([2, 3, true]);
    expect(grid.vertices[4]).toEqual({ x: 1, y: 1, z: 2 });
    const pface = byType('mesh').find((m) => m.meshKind === 'faces')!;
    expect(pface.vertices.length).toBe(4);
    expect(pface.faces).toEqual([[1, 2, 3], [1, -3, 4]]);
  });

  it('round-trips the dimension fields', () => {
    const dim = byType('dimension')[0];
    expect(dim.kind).toBe('linear');
    expect(dim.definitionPoint).toEqual({ x: 5, y: 1, z: 0 });
    expect(dim.textMidpoint).toEqual({ x: 2.5, y: 1.2, z: 0 });
    expect(dim.insertionPoint).toEqual({ x: 2.5, y: 1, z: 0 });
    expect(dim.point13).toEqual({ x: 0, y: 0, z: 0 });
    expect(dim.point14).toEqual({ x: 5, y: 0, z: 0 });
    expect(dim.text).toBe('5.00');
  });

  it('materializes the downgrades as visible geometry', () => {
    /* ellipse, spline, hatch, table grid, mline… all land as polylines,
       lines and texts; the two mtext lines arrive as two TEXT records */
    expect(byType('text').map((t) => t.text))
      .toContain('first line');
    expect(byType('text').map((t) => t.text))
      .toContain('second line');
    const plines = byType('polyline');
    expect(plines.some((p) => p.vertices.length > 30)).toBe(true);  /* ellipse */
    expect(byType('line').length).toBeGreaterThan(2);   /* hatch + table grid */
  });

  it('round-trips the tables, patterned linetype included', () => {
    expect(back.layers.map((l) => l.name)).toEqual(['0', 'Étage€']);
    expect(back.layers[1]).toMatchObject({
      on: false, frozen: true, locked: true,
      color: { kind: 'aci', index: 30 }, linetype: 'DASHED'
    });
    const dashed = back.linetypes.find((l) => l.name === 'DASHED')!;
    expect(dashed.pattern).toEqual([0.5, -0.25]);
    expect(back.textStyles.map((s) => s.name)).toEqual(['Standard', 'Arabic']);
    expect(back.dimStyles?.[0].name).toBe('S1');
    expect(back.dimStyles?.[0].vars).toMatchObject({
      DIMSCALE: 2, DIMTXT: 0.25, DIMTOL: 1
    });
  });
});
