/* nasjidwg — the pre-R11 DWG writers (R10, R9, R2.6, R2.10), verified as
 * round trips through this library's own pre-R13 reader: the file comes
 * back with the right signature, zero warnings, and every native entity
 * number-for-number.
 *
 * Each release gets a sample drawing built from what it can hold natively
 * plus a couple of downgrade/skip cases. Text payloads travel as %% codes
 * and \U+ escapes, so any Unicode text survives; table names are raw
 * CP1252 bytes with no escape mechanism, so an accented name like
 * "Étage€" survives while anything outside CP1252 (e.g. an Arabic layer
 * name) comes back as "?" — that limit is asserted below, not hidden.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import {
  writeDwgR10, writeDwgR2_10, writeDwgR2_6, writeDwgR9
} from '../src/dwg/writer-pre13.js';
import { detectVersion } from '../src/dwg/fileheader.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, FileVersion } from '../src/core/model.js';
import type { DwgWriteResult } from '../src/dwg/writer.js';

/** Every number an entity carries, in a stable order, rounded to 1e-6.
 *  styleId is excluded the same way the R12 writer tests exclude it. */
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

interface Caps {
  version: FileVersion;
  write: (d: Drawing) => DwgWriteResult;
  r10: boolean;                           /* inline 3D, meshes */
  dim: boolean;                           /* the DIMENSION record exists */
  bigFont: boolean;                       /* STYLE carries a bigfont field */
}

const ACCENTED = 'Café مرحبا 45°';

/** A drawing of everything the release holds natively, plus an ellipse
 *  and an mtext (downgrades) and a viewport and a ray (skips). */
const sample = (caps: Caps): Drawing => {
  const d = emptyDrawing();
  const byLayer = { kind: 'byLayer' } as const;
  d.layers = [
    { name: '0', color: { kind: 'aci', index: 7 }, on: true, frozen: false, locked: false },
    { name: 'Étage€', color: { kind: 'aci', index: 30 }, on: false, frozen: true, locked: true, linetype: 'DASHED' },
    /* documents the CP1252 limit: this name cannot survive */
    { name: 'حوائط', color: { kind: 'aci', index: 5 }, on: true, frozen: false, locked: false }
  ];
  d.linetypes = [
    { name: 'CONTINUOUS', description: 'Solid line', pattern: [] },
    { name: 'DASHED', description: 'Dashed __ __', pattern: [0.5, -0.25] },
    { name: 'CENTER', description: 'Center ____ _ ____', pattern: [1.25, -0.25, 0.25, -0.25] }
  ];
  d.textStyles = [
    { name: 'Standard' },
    {
      name: 'Fancy', font: 'romans.shx', fixedHeight: 0.3, widthFactor: 0.9,
      bigFont: caps.bigFont ? 'big.shx' : undefined
    }
  ];
  d.dimStyles = [{ name: 'S1', vars: { DIMSCALE: 2, DIMTXT: 0.25 } }];
  d.blocks = {
    DOOR: {
      name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
      entities: [
        { type: 'line', layer: '0', color: byLayer, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } },
        { type: 'arc', layer: '0', color: { kind: 'aci', index: 3 }, center: { x: 0, y: 0, z: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2 }
      ]
    }
  };
  d.entities = [
    /* 0: flat line with colour + linetype on the accented layer */
    { type: 'line', layer: 'Étage€', color: { kind: 'aci', index: 1 }, linetype: 'DASHED', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } },
    /* 1: level line — a shared elevation before R10, inline 3D after */
    { type: 'line', layer: '0', color: byLayer, start: { x: 0, y: 5, z: 2 }, end: { x: 6, y: 5, z: 2 } },
    /* 2: sloped line — 3DLINE before R10 */
    { type: 'line', layer: '0', color: byLayer, start: { x: 1, y: 2, z: 3 }, end: { x: 4, y: 5, z: 6 } },
    { type: 'point', layer: '0', color: byLayer, position: { x: 7, y: 8, z: 9 } },
    { type: 'circle', layer: '0', color: byLayer, center: { x: 5, y: 5, z: 1 }, radius: 2.5 },
    { type: 'arc', layer: '0', color: byLayer, center: { x: 0, y: 0, z: 0 }, radius: 3, startAngle: 0.5, endAngle: 2.5 },
    { type: 'solid', layer: '0', color: byLayer, corners: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }] },
    /* 7: flat face; 8: true-3D face whose edge mask only R10 can keep */
    {
      type: 'face3d', layer: '0', color: byLayer,
      corners: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 2, z: 0 }, { x: 0, y: 2, z: 0 }]
    },
    {
      type: 'face3d', layer: '0', color: byLayer, invisibleEdges: 5,
      corners: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }, { x: 1, y: 1, z: 3 }, { x: 0, y: 1, z: 4 }]
    },
    {
      type: 'text', layer: '0', color: byLayer, text: ACCENTED,
      position: { x: 1, y: 1, z: 0 }, alignmentPoint: { x: 2, y: 1, z: 0 },
      height: 0.5, rotation: 0.25, widthFactor: 0.8, oblique: 0.1,
      style: 'Fancy', halign: 'center', valign: 'top'
    },
    {
      type: 'polyline', layer: '0', color: byLayer, closed: true,
      vertices: [{ x: 0, y: 0, bulge: 0.5 }, { x: 4, y: 0, startWidth: 0.1, endWidth: 0.2 }, { x: 4, y: 4 }],
      elevation: 2
    },
    {
      type: 'insert', layer: '0', color: byLayer, blockName: 'DOOR',
      position: { x: 10, y: 10, z: 0 }, scale: { x: 2, y: 3, z: 1 }, rotation: 0.7,
      columnCount: 2, rowCount: 3, columnSpacing: 5, rowSpacing: 6,
      attributes: [{
        type: 'text', layer: '0', color: byLayer, text: 'A-101',
        position: { x: 10.5, y: 10.5, z: 0 }, height: 0.2, rotation: 0
      }]
    },
    /* 12: dimension — native from R2.6, exploded geometry for R2.10 */
    {
      type: 'dimension', layer: '0', color: byLayer, kind: 'linear',
      dimensionType: 0, definitionPoint: { x: 5, y: 1, z: 0 },
      textMidpoint: { x: 2.5, y: 1.2, z: 0 }, insertionPoint: { x: 2.5, y: 1, z: 0 },
      point13: { x: 0, y: 0, z: 0 }, point14: { x: 5, y: 0, z: 0 },
      rotation: 0, text: '5.00', style: 'S1'
    },
    /* 13/14: meshes — native only on R10 */
    {
      type: 'mesh', layer: '0', color: byLayer, meshKind: 'grid',
      mSize: 2, nSize: 3, closedM: true,
      vertices: [
        { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 2 }, { x: 2, y: 1, z: 0 }
      ]
    },
    {
      type: 'mesh', layer: '0', color: byLayer, meshKind: 'faces',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 0 }],
      faces: [[1, 2, 3], [1, -3, 4]]
    },
    /* 15: skipped everywhere — the VIEWPORT record is an R11 invention */
    { type: 'viewport', layer: '0', color: byLayer, center: { x: 4, y: 3, z: 0 }, width: 8, height: 6, statusFlag: 2 },
    /* downgrades */
    {
      type: 'ellipse', layer: '0', color: byLayer, center: { x: 0, y: 0, z: 0 },
      majorAxis: { x: 4, y: 0, z: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI * 2
    },
    {
      type: 'mtext', layer: '0', color: byLayer, position: { x: 0, y: 20, z: 0 },
      text: 'first line\nsecond line', height: 0.4, rotation: 0
    },
    /* unrepresentable */
    { type: 'ray', layer: '0', color: byLayer, basePoint: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }
  ] as Entity[];
  d.paperSpace = [
    { type: 'line', layer: '0', color: byLayer, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } }
  ] as Entity[];
  if (caps.r10) {
    d.views = [{
      name: 'PLAN', center: { x: 5, y: 5 }, height: 20, width: 30,
      direction: { x: 0, y: 0, z: 1 }
    }];
    d.ucs = [{
      name: 'WALL', origin: { x: 1, y: 2, z: 3 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }
    }];
  }
  d.header.extMin = { x: 0, y: 0, z: 0 };
  d.header.extMax = { x: 30, y: 30, z: 9 };
  d.header.limMin = { x: 0, y: 0 };
  d.header.limMax = { x: 42, y: 30 };
  d.header.linetypeScale = 2.5;
  d.header.vars = { CLAYER: '0', TEXTSTYLE: 'Standard', LUNITS: 2, LUPREC: 4 };
  return d;
};

const CASES: Array<[string, Caps]> = [
  ['R10 (AC1006)', {
    version: 'R10', write: writeDwgR10, r10: true, dim: true, bigFont: true
  }],
  ['R9 (AC1004)', {
    version: 'R9', write: writeDwgR9, r10: false, dim: true, bigFont: true
  }],
  ['R2.6 (AC1003)', {
    version: 'R2.6', write: writeDwgR2_6, r10: false, dim: true, bigFont: true
  }],
  ['R2.10 (AC2.10)', {
    version: 'R2.10', write: writeDwgR2_10, r10: false, dim: false, bigFont: false
  }]
];

for (const [label, caps] of CASES) {
  describe(label, () => {
    const d = sample(caps);
    const { data, skipped, downgraded } = caps.write(d);
    const back = readDwg(data);
    /* natives: through the meshes on R10, the dimension on R9/R2.6, the
       insert on R2.10 — everything after is downgrade output */
    const nativeCount = caps.r10 ? 15 : caps.dim ? 13 : 12;
    const byType = <T extends Entity['type']>(t: T) =>
      back.entities.filter((e): e is Extract<Entity, { type: T }> => e.type === t);

    it('announces the right release and reads back clean', () => {
      expect(detectVersion(data)).toBe(caps.version);
      expect(back.header.version).toBe(caps.version);
      expect(back.warnings).toEqual([]);
    });

    it('reports what was downgraded and what was dropped', () => {
      const downs = caps.r10 ? ['ellipse', 'mtext']
        : caps.dim ? ['face3d(edges)', 'ellipse', 'mtext']
          : ['face3d(edges)', 'dimension', 'ellipse', 'mtext'];
      const skips = caps.r10 ? [] : ['mesh(grid)', 'mesh(faces)'];
      expect(downgraded).toEqual(downs);
      expect(skipped).toEqual([...skips, 'viewport', 'ray', 'line (paper space)']);
    });

    it('round-trips native entities number-for-number', () => {
      const expected = d.entities.slice(0, nativeCount).map((e) => {
        /* pre-R10 3DFACE has no edge-visibility word; the writer reports
           the loss and the comparison expects the face without it */
        if (!caps.r10 && e.type === 'face3d' && e.invisibleEdges) {
          const copy = { ...e };
          delete copy.invisibleEdges;
          return copy;
        }
        return e;
      });
      expect(back.entities.slice(0, nativeCount).map((e) => e.type))
        .toEqual(expected.map((e) => e.type));
      for (let i = 0; i < expected.length; i++) {
        expect(numbers(back.entities[i]), `entity ${i} (${expected[i].type})`)
          .toEqual(numbers(expected[i]));
      }
    });

    it('round-trips the tables, patterned linetypes included', () => {
      /* names are raw CP1252: the accented one survives, Arabic cannot */
      expect(back.layers.map((l) => l.name)).toEqual(['0', 'Étage€', '?????']);
      expect(back.layers[1]).toMatchObject({
        on: false, frozen: true, locked: true,
        color: { kind: 'aci', index: 30 }, linetype: 'DASHED'
      });
      const dashed = back.linetypes.find((l) => l.name === 'DASHED')!;
      expect(dashed.pattern).toEqual([0.5, -0.25]);
      const center = back.linetypes.find((l) => l.name === 'CENTER')!;
      expect(center.pattern).toEqual([1.25, -0.25, 0.25, -0.25]);
      expect(back.textStyles.map((s) => s.name)).toEqual(['Standard', 'Fancy']);
      const fancy = back.textStyles[1];
      expect(fancy.font).toBe('romans.shx');
      expect(fancy.fixedHeight).toBe(0.3);
      expect(fancy.widthFactor).toBeCloseTo(0.9, 12);
      expect(fancy.bigFont).toBe(caps.bigFont ? 'big.shx' : undefined);
    });

    it('round-trips blocks and the insert with its attributes', () => {
      expect(back.blocks.DOOR.entities.map((e) => e.type)).toEqual(['line', 'arc']);
      expect(back.blocks.DOOR.entities[1].color).toEqual({ kind: 'aci', index: 3 });
      const ins = byType('insert')[0];
      expect(ins.blockName).toBe('DOOR');
      expect(ins.scale).toEqual({ x: 2, y: 3, z: 1 });
      expect(ins.rotation).toBe(0.7);
      expect([ins.columnCount, ins.rowCount]).toEqual([2, 3]);
      expect([ins.columnSpacing, ins.rowSpacing]).toEqual([5, 6]);
      expect(ins.attributes?.length).toBe(1);
      expect(ins.attributes?.[0].text).toBe('A-101');
    });

    it('carries the dimension the way the release can', () => {
      if (caps.dim) {
        const dim = byType('dimension')[0];
        expect(dim.kind).toBe('linear');
        expect(dim.definitionPoint).toEqual({ x: 5, y: 1, z: 0 });
        expect(dim.textMidpoint).toEqual({ x: 2.5, y: 1.2, z: 0 });
        expect(dim.insertionPoint).toEqual({ x: 2.5, y: 1, z: 0 });
        expect(dim.point13).toEqual({ x: 0, y: 0, z: 0 });
        expect(dim.point14).toEqual({ x: 5, y: 0, z: 0 });
        expect(dim.text).toBe('5.00');
        /* the drawn form travels in a materialized anonymous block */
        expect(dim.blockName).toBe('*D0');
        expect(back.blocks['*D0'].entities.length).toBeGreaterThan(0);
      } else {
        /* R2.10 predates the record: the drawn form goes out inline */
        expect(byType('dimension')).toEqual([]);
        expect(byType('text').map((t) => t.text)).toContain('5.00');
      }
    });

    it('keeps extents, limits, LTSCALE and CLAYER', () => {
      expect(back.header.extMin).toEqual({ x: 0, y: 0, z: 0 });
      expect(back.header.extMax).toEqual({ x: 30, y: 30, z: 9 });
      expect(back.header.limMin).toEqual({ x: 0, y: 0 });
      expect(back.header.limMax).toEqual({ x: 42, y: 30 });
      expect(back.header.linetypeScale).toBe(2.5);
      expect(back.header.vars?.CLAYER).toBe('0');
      expect(back.header.vars?.TEXTSTYLE).toBe('Standard');
      expect(back.header.vars?.LUNITS).toBe(2);
      expect(back.header.vars?.LUPREC).toBe(4);
    });

    it('round-trips accented text through escapes', () => {
      const text = byType('text')[0];
      expect(text.text).toBe(ACCENTED);
      expect(text.height).toBe(0.5);
      expect(text.rotation).toBe(0.25);
      expect(text.widthFactor).toBeCloseTo(0.8, 12);
      expect(text.oblique).toBeCloseTo(0.1, 12);
      expect(text.style).toBe('Fancy');
      expect(text.halign).toBe('center');
      expect(text.valign).toBe('top');
      expect(text.alignmentPoint).toEqual({ x: 2, y: 1, z: 0 });
    });

    it('materializes the downgrades as visible geometry', () => {
      /* the full ellipse lands as one closed 64-point polyline, the mtext
         as its two lines of TEXT (on R2.10 the exploded dimension's lines
         come first, so the position check applies to the others) */
      if (caps.dim) expect(back.entities[nativeCount].type).toBe('polyline');
      const texts = byType('text').map((t) => t.text);
      expect(texts).toContain('first line');
      expect(texts).toContain('second line');
      expect(byType('polyline').some((p) => p.vertices.length === 64)).toBe(true);
    });

    if (caps.r10) {
      it('round-trips the VIEW and UCS tables (R10)', () => {
        expect(back.views?.[0]).toMatchObject({
          name: 'PLAN', center: { x: 5, y: 5 }, height: 20, width: 30,
          direction: { x: 0, y: 0, z: 1 }
        });
        expect(back.ucs?.[0]).toEqual({
          name: 'WALL', origin: { x: 1, y: 2, z: 3 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }
        });
      });

      it('round-trips both mesh kinds (R10)', () => {
        const grid = byType('mesh').find((m) => m.meshKind === 'grid')!;
        expect([grid.mSize, grid.nSize, grid.closedM]).toEqual([2, 3, true]);
        expect(grid.vertices[4]).toEqual({ x: 1, y: 1, z: 2 });
        const pface = byType('mesh').find((m) => m.meshKind === 'faces')!;
        expect(pface.vertices.length).toBe(4);
        expect(pface.faces).toEqual([[1, 2, 3], [1, -3, 4]]);
      });
    }
  });
}
