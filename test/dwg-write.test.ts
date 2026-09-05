/* nasjidwg — DWG R2000 writer round-trip: what we write, our
 * oracle-validated reader must read back identically. */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { ByteSink } from '../src/dwg/bitwriter.js';
import { writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018, writeDwgR14 } from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

const build = (): Drawing => {
  const d = emptyDrawing();
  d.layers.push(
    { name: 'walls', color: { kind: 'aci', index: 1 }, on: true, frozen: false, locked: false },
    { name: 'hidden', color: { kind: 'aci', index: 3 }, on: false, frozen: true, locked: true }
  );
  d.linetypes.push({ name: 'DASHED', description: 'dash dash', pattern: [12.7, -6.35] });
  d.textStyles.push({ name: 'Notes', font: 'arial.ttf', widthFactor: 0.9 });
  d.blocks['door'] = {
    name: 'door',
    basePoint: { x: 1, y: 2, z: 0 },
    entities: [{
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 0.9, y: 0, z: 0 }
    }]
  };
  d.entities.push(
    { type: 'line', layer: 'walls', color: { kind: 'byLayer' },
      start: { x: 1, y: 2, z: 0 }, end: { x: 100.5, y: -3.25, z: 0 } },
    { type: 'line', layer: '0', color: { kind: 'aci', index: 5 },
      start: { x: 0, y: 0, z: 3 }, end: { x: 5, y: 5, z: 7 } },
    { type: 'point', layer: '0', color: { kind: 'byLayer' },
      position: { x: 7, y: 8, z: 0 } },
    { type: 'circle', layer: 'walls', color: { kind: 'byLayer' },
      center: { x: 10, y: 20, z: 0 }, radius: 7.75 },
    { type: 'arc', layer: '0', color: { kind: 'byLayer' },
      center: { x: -5, y: 4, z: 0 }, radius: 3, startAngle: 0.25, endAngle: 2.5 },
    { type: 'ellipse', layer: '0', color: { kind: 'byLayer' },
      center: { x: 5, y: 5, z: 0 }, majorAxis: { x: 4, y: 1, z: 0 },
      ratio: 0.5, startParam: 0.5, endParam: 2.5 },
    { type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: true,
      constantWidth: 0.35,
      vertices: [
        { x: 0, y: 0, bulge: 0.5, startWidth: 0.1, endWidth: 0.2 },
        { x: 10, y: 0 }, { x: 10, y: 5, bulge: -0.25 }
      ] },
    { type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 1, y: 2, z: 0 }, text: 'Hello DWG', height: 2.5,
      rotation: 0.3, style: 'Notes' },
    { type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 9, z: 0 }, text: 'مرحبا بالعالم', height: 5,
      rotation: 0 },
    { type: 'mtext', layer: '0', color: { kind: 'byLayer' },
      position: { x: 4, y: 9, z: 0 }, text: 'First\nSecond', height: 3,
      rotation: 0.2, attachment: 1 },
    { type: 'insert', layer: '0', color: { kind: 'byLayer' },
      blockName: 'door', position: { x: 3, y: 4, z: 0 },
      scale: { x: 2, y: 2, z: 1 }, rotation: Math.PI / 6 },
    { type: 'spline', layer: '0', color: { kind: 'byLayer' },
      degree: 3, closed: false,
      controlPoints: [
        { x: 0, y: 0, z: 0 }, { x: 3, y: 8, z: 0 },
        { x: 7, y: -2, z: 0 }, { x: 12, y: 4, z: 0 }
      ],
      knots: [0, 0, 0, 0, 1, 1, 1, 1], weights: [1, 2, 1, 1] },
    { type: 'solid', layer: '0', color: { kind: 'byLayer' },
      corners: [
        { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 },
        { x: 4, y: 3, z: 0 }, { x: 0, y: 3, z: 0 }
      ] },
    { type: 'ray', layer: '0', color: { kind: 'byLayer' },
      basePoint: { x: 1, y: 1, z: 0 }, direction: { x: 0.6, y: 0.8, z: 0 } },
    { type: 'xline', layer: '0', color: { kind: 'byLayer' },
      basePoint: { x: 2, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    { type: 'face3d', layer: '0', color: { kind: 'byLayer' },
      corners: [
        { x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 2 },
        { x: 4, y: 3, z: 3 }, { x: 0, y: 3, z: 4 }
      ], invisibleEdges: 5 }
  );
  d.paperSpace = [{
    type: 'circle', layer: '0', color: { kind: 'byLayer' },
    center: { x: 50, y: 50, z: 0 }, radius: 9
  } as Entity];
  return d;
};

describe('DWG R2000 write round-trip', () => {
  const src = build();
  const { data, skipped } = writeDwg2000(src);
  const back = readDwg(data);

  it('produces a structurally valid file our reader accepts', () => {
    expect(skipped).toEqual([]);
    expect(back.header.version).toBe('R2000');
    expect(back.warnings.filter((w) => w.includes('could not be decoded')))
      .toEqual([]);
  });

  it('round-trips every entity with exact geometry', () => {
    expect(back.entities.length).toBe(src.entities.length);
    const byType = (d: Drawing, t: string) =>
      d.entities.filter((e) => e.type === t);

    const lines = byType(back, 'line');
    expect(lines.length).toBe(2);
    const l1 = lines.find((l) => l.type === 'line' && l.start.x === 1);
    if (l1?.type !== 'line') throw new Error('line lost');
    near(l1.end.x, 100.5); near(l1.end.y, -3.25);
    expect(l1.layer).toBe('walls');
    const l2 = lines.find((l) => l.type === 'line' && (l as { start: { z: number } }).start.z === 3);
    expect(l2).toBeTruthy();

    const [c] = byType(back, 'circle');
    if (c.type !== 'circle') throw new Error('circle');
    near(c.center.x, 10); near(c.radius, 7.75);

    const [a] = byType(back, 'arc');
    if (a.type !== 'arc') throw new Error('arc');
    near(a.startAngle, 0.25); near(a.endAngle, 2.5);

    const [el] = byType(back, 'ellipse');
    if (el.type !== 'ellipse') throw new Error('ellipse');
    near(el.majorAxis.x, 4); near(el.ratio, 0.5);
    near(el.startParam, 0.5); near(el.endParam, 2.5);

    const [pl] = byType(back, 'polyline');
    if (pl.type !== 'polyline') throw new Error('polyline');
    expect(pl.closed).toBe(true);
    expect(pl.vertices.length).toBe(3);
    near(pl.vertices[0].bulge ?? 0, 0.5);
    near(pl.vertices[0].startWidth ?? 0, 0.1);
    near(pl.constantWidth ?? 0, 0.35);

    const texts = byType(back, 'text');
    expect(texts.length).toBe(2);
    const t1 = texts.find((t) => t.type === 'text' && t.text === 'Hello DWG');
    expect(t1).toBeTruthy();
    if (t1?.type === 'text') { near(t1.height, 2.5); near(t1.rotation, 0.3); }
    /* Arabic survives the DWG byte path back to logical order */
    const t2 = texts.find((t) => t.type === 'text' && t.text === 'مرحبا بالعالم');
    expect(t2).toBeTruthy();

    const [mt] = byType(back, 'mtext');
    if (mt.type !== 'mtext') throw new Error('mtext');
    expect(mt.text).toBe('First\nSecond');
    near(mt.rotation, 0.2);

    const [ins] = byType(back, 'insert');
    if (ins.type !== 'insert') throw new Error('insert');
    expect(ins.blockName.toLowerCase()).toBe('door');
    near(ins.position.x, 3); near(ins.scale.x, 2);
    near(ins.rotation, Math.PI / 6);

    const [sp] = byType(back, 'spline');
    if (sp.type !== 'spline') throw new Error('spline');
    expect(sp.degree).toBe(3);
    expect(sp.controlPoints.length).toBe(4);
    expect(sp.knots).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(sp.weights).toEqual([1, 2, 1, 1]);

    const [so] = byType(back, 'solid');
    if (so.type !== 'solid') throw new Error('solid');
    near(so.corners[2].x, 4); near(so.corners[2].y, 3);

    expect(byType(back, 'ray').length).toBe(1);
    expect(byType(back, 'xline').length).toBe(1);

    const [f3] = byType(back, 'face3d');
    if (f3.type !== 'face3d') throw new Error('face3d');
    near(f3.corners[3].z ?? 0, 4);
    expect(f3.invisibleEdges).toBe(5);
  });

  it('round-trips tables, blocks and paper space', () => {
    expect(back.layers.map((l) => l.name).sort())
      .toEqual(['0', 'hidden', 'walls']);
    const hidden = back.layers.find((l) => l.name === 'hidden')!;
    expect(hidden.on).toBe(false);
    expect(hidden.frozen).toBe(true);
    expect(hidden.locked).toBe(true);
    expect(back.linetypes.some((lt) => lt.name === 'DASHED')).toBe(true);
    const dashed = back.linetypes.find((lt) => lt.name === 'DASHED')!;
    expect(dashed.pattern.length).toBe(2);
    near(dashed.pattern[0], 12.7);
    expect(back.textStyles.some((st) => st.name === 'Notes')).toBe(true);
    expect(Object.keys(back.blocks).map((n) => n.toLowerCase())).toContain('door');
    const door = back.blocks[Object.keys(back.blocks).find((n) => /door/i.test(n))!];
    expect(door.entities.length).toBe(1);
    near(door.basePoint.x, 1);
    expect(back.paperSpace?.length).toBe(1);
  });

  it('re-writes its own read-back identically (fixpoint)', () => {
    const again = readDwg(writeDwg2000(back).data);
    expect(again.entities.length).toBe(back.entities.length);
    expect(again.layers.length).toBe(back.layers.length);
  });
});

describe('DWG R2018 (AC1032) write round-trip', () => {
  const src = build();
  const { data, skipped } = writeDwg2018(src);
  const back = readDwg(data);

  it('produces a valid AC1032 file our reader accepts', () => {
    expect(skipped).toEqual([]);
    expect(String.fromCharCode(...data.subarray(0, 6))).toBe('AC1032');
    expect(back.header.version).toBe('R2018');
    expect(back.warnings.filter((w) => w.includes('could not be decoded')))
      .toEqual([]);
  });

  it('matches the other containers entity-for-entity', () => {
    const r2000 = readDwg(writeDwg2000(src).data);
    const counts = (d: Drawing) => {
      const c: Record<string, number> = {};
      for (const e of d.entities) c[e.type] = (c[e.type] ?? 0) + 1;
      return c;
    };
    expect(counts(back)).toEqual(counts(r2000));
    const geo = (d: Drawing) => d.entities
      .filter((e) => e.type === 'line')
      .flatMap((e) => e.type === 'line' ? [e.start.x, e.start.y, e.end.x, e.end.y] : [])
      .sort((a, b) => a - b);
    expect(geo(back)).toEqual(geo(r2000));
    expect(back.layers.length).toBe(r2000.layers.length);
  });
});

describe('header round-trip', () => {
  const source = (): Drawing => {
    const d = emptyDrawing();
    d.header.linetypeScale = 3.5;
    d.header.insUnits = 6;
    d.header.extMin = { x: -5, y: -7, z: 0 };
    d.header.extMax = { x: 15, y: 25, z: 0 };
    d.header.vars = {
      DIMASZ: 1.75, DIMTXT: 0.9, DIMSCALE: 50, DIMGAP: 0.31, DIMDEC: 3,
      PDMODE: 34, PDSIZE: 1.5
    };
    d.entities.push({
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 20, z: 0 }
    });
    return d;
  };

  it.each([
    ['R2000', writeDwg2000], ['R2004', writeDwg2004],
    ['R2007', writeDwg2007], ['R2018', writeDwg2018]
  ])('%s keeps its header variables', (_name, write) => {
    const back = readDwg(write(source()).data);
    near(back.header.linetypeScale as number, 3.5);
    expect(back.header.insUnits).toBe(6);
    near(back.header.extMin!.x, -5);
    near(back.header.extMax!.y, 25);
    near(back.header.vars?.DIMASZ as number, 1.75);
    near(back.header.vars?.DIMTXT as number, 0.9);
    near(back.header.vars?.DIMSCALE as number, 50);
    near(back.header.vars?.DIMGAP as number, 0.31);
    expect(back.header.vars?.DIMDEC).toBe(3);
    /* the point glyph: PDMODE 1 draws nothing at all, so losing it makes a
       consumer invent dots the file never had */
    expect(back.header.vars?.PDMODE).toBe(34);
    near(back.header.vars?.PDSIZE as number, 1.5);
    expect(back.entities.length).toBe(1);
  });
});

describe('assembly byte sink', () => {
  it('speaks the assemblers\' dialect byte for byte', () => {
    const sink = new ByteSink();
    const model: number[] = [];
    sink.push(0xca, 0x0d);            model.push(0xca, 0x0d);
    sink.append([1, 2, 3]);           model.push(1, 2, 3);
    sink.append(Uint8Array.from([4, 5])); model.push(4, 5);
    sink.set(0, 0xff);                model[0] = 0xff;
    expect(sink.length).toBe(model.length);
    expect(sink.at(0)).toBe(0xff);
    expect(Array.from(sink.view(2))).toEqual(model.slice(2));
    expect(Array.from(sink.bytes())).toEqual(model);
  });

  it('grows past the plain-Array cap a large objects section used to hit', () => {
    /* V8 stops growing a plain Array at 112,813,858 elements — push
       throws RangeError "Invalid array length" — which is exactly where
       a 246k-entity drawing's objects section landed and writeDwg2018
       died. The sink has no such ceiling. */
    const sink = new ByteSink();
    const chunk = new Uint8Array(1 << 20).fill(0xab);
    while (sink.length <= 112_813_858) sink.append(chunk);
    sink.push(0xcd);                  /* the push that used to throw */
    expect(sink.at(sink.length - 1)).toBe(0xcd);
    expect(sink.at(sink.length - 2)).toBe(0xab);
  });
});

describe('external references', () => {
  /* Two attachments — one overlaid — with the records the referenced
     file lends the drawing (`xref|name`), plus a stray dependent layer
     whose attachment is not in the drawing at all. Modelled on the
     reference's A-01 sheet (Wall Base / Grid Plan), whose rewrite it
     opens with both attachments resolved and AUDIT clean. */
  const build = (): Drawing => {
    const d = emptyDrawing();
    d.blocks['Wall Base'] = {
      name: 'Wall Base', basePoint: { x: 0, y: 0, z: 0 }, entities: [],
      xref: { path: '.\\Res\\Wall Base.dwg' }
    };
    d.blocks['Grid Plan'] = {
      name: 'Grid Plan', basePoint: { x: 0, y: 0, z: 0 }, entities: [],
      xref: { path: 'X:\\shared\\Grid Plan.dwg', overlay: true }
    };
    d.linetypes.push({
      name: 'Wall Base|DASHED', description: 'dashed', pattern: [0.5, -0.25],
      xrefDependent: true
    });
    d.layers.push(
      { name: 'Wall Base|A-WALL', color: { kind: 'aci', index: 3 }, on: true,
        frozen: false, locked: false, linetype: 'Wall Base|DASHED', xrefDependent: true },
      { name: 'Grid Plan|GRID', color: { kind: 'aci', index: 131 }, on: true,
        frozen: false, locked: false, xrefDependent: true },
      /* no "Gone" attachment: this one has nothing to belong to */
      { name: 'Gone|A-DOOR', color: { kind: 'aci', index: 1 }, on: true,
        frozen: false, locked: false, xrefDependent: true }
    );
    d.textStyles.push({ name: 'Wall Base|Notes', font: 'arial.ttf', xrefDependent: true });
    const insert = (blockName: string, x: number): Entity => ({
      type: 'insert', layer: '0', color: { kind: 'byLayer' }, blockName,
      position: { x, y: 0, z: 0 }
    });
    d.entities.push(insert('Wall Base', 0), insert('Grid Plan', 10), insert('Wall Base', 20));
    return d;
  };

  const writers = [
    ['2018', writeDwg2018], ['2007', writeDwg2007],
    ['2004', writeDwg2004], ['2000', writeDwg2000]
  ] as const;
  for (const [label, write] of writers) {
    it(`${label}: an attachment keeps its path, overlay flag and dependent records`, () => {
      const res = write(build());
      /* only the record with no attachment to belong to stays home */
      expect(res.skipped).toContain('1 xref-dependent table records');
      const back = readDwg(res.data);
      expect(back.blocks['Wall Base'].xref).toEqual({ path: '.\\Res\\Wall Base.dwg' });
      expect(back.blocks['Grid Plan'].xref).toEqual({ path: 'X:\\shared\\Grid Plan.dwg', overlay: true });
      expect(back.blocks['Wall Base'].entities).toEqual([]);
      const wall = back.layers.find((l) => l.name === 'Wall Base|A-WALL');
      expect(wall?.xrefDependent).toBe(true);
      expect(wall?.linetype).toBe('Wall Base|DASHED');
      expect(back.layers.find((l) => l.name === 'Grid Plan|GRID')?.xrefDependent).toBe(true);
      expect(back.layers.some((l) => l.name === 'Gone|A-DOOR')).toBe(false);
      expect(back.linetypes.find((lt) => lt.name === 'Wall Base|DASHED')?.xrefDependent).toBe(true);
      expect(back.textStyles.find((s) => s.name === 'Wall Base|Notes')?.xrefDependent).toBe(true);
      const inserts = back.entities.filter((e) => e.type === 'insert');
      expect(inserts.map((e) => e.type === 'insert' && e.blockName))
        .toEqual(['Wall Base', 'Grid Plan', 'Wall Base']);
    });
  }

  it('R14 keeps an attachment as a plain block and its records at home', () => {
    const res = writeDwgR14(build());
    expect(res.skipped).toContain('5 xref-dependent table records');
    const back = readDwg(res.data);
    expect(back.blocks['Wall Base'].xref).toBeUndefined();
    expect(back.layers.some((l) => /\|/.test(l.name))).toBe(false);
  });
});
