/* nasjidwg — PDF/DGN/DWF underlay entities.
 *
 * An underlay places a page of an external document behind the drawing.
 * The entity holds the placement and points at a definition object that
 * names the file and the page inside it, and several placements normally
 * share one definition. Both halves have to survive every container and
 * DXF, and the sharing has to survive with them.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018
} from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, UnderlayEntity } from '../src/core/model.js';

const underlaysOf = (d: Drawing): UnderlayEntity[] => [
  ...d.entities, ...(d.paperSpace ?? [])
].filter((e): e is UnderlayEntity => e.type === 'underlay');

/** Three placements of one PDF page, plus a DGN and a DWF alongside. */
const build = (): Drawing => {
  const d = emptyDrawing();
  const pdf = (x: number, y: number, rotation: number): UnderlayEntity => ({
    type: 'underlay', layer: '0', color: { kind: 'byLayer' },
    underlayKind: 'pdf',
    path: '../../../dxf.pdf', itemName: '1',
    position: { x, y, z: 0 },
    scale: { x: 1.1, y: 1.1, z: 1.1 },
    rotation,
    flags: 30, contrast: 67, fade: 12,
    clip: [
      { x: 7, y: 3.000519187844929 },
      { x: 4.811503527941795, y: 0 },
      { x: 0, y: 0 }
    ]
  });
  d.entities.push(
    pdf(1508.487568332031, 1954.811392707071, 5 * Math.PI / 180),
    pdf(300, 200, 0),
    pdf(-40.5, 12.25, Math.PI / 3),
    {
      type: 'underlay', layer: '0', color: { kind: 'byLayer' },
      underlayKind: 'dgn',
      path: 'site/plan.dgn', itemName: 'Model',
      position: { x: 10, y: 20, z: 0 },
      scale: { x: 2, y: 2, z: 1 }, rotation: 0,
      flags: 2, contrast: 100, fade: 0
    },
    {
      type: 'underlay', layer: '0', color: { kind: 'byLayer' },
      underlayKind: 'dwf',
      path: 'sheets/A-101.dwf', itemName: 'Sheet 1',
      position: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }, rotation: 0,
      flags: 2, contrast: 100, fade: 0
    }
  );
  return d;
};

/** Every field an underlay carries, in a stable order. */
const shape = (u: UnderlayEntity): unknown[] => [
  u.underlayKind, u.path, u.itemName,
  Math.round(u.position.x * 1e9) / 1e9, Math.round(u.position.y * 1e9) / 1e9,
  Math.round(u.scale.x * 1e9) / 1e9, Math.round(u.scale.y * 1e9) / 1e9,
  Math.round(u.rotation * 1e9) / 1e9,
  u.flags ?? null, u.contrast ?? null, u.fade ?? null,
  u.clip?.length ?? 0
];

describe('underlay round trip', () => {
  const src = build();

  it.each([
    ['R2000', writeDwg2000], ['R2004', writeDwg2004],
    ['R2007', writeDwg2007], ['R2018', writeDwg2018]
  ])('survives the %s container', (name, write) => {
    const { data, skipped } = write(src);
    expect(skipped.filter((s) => s.includes('underlay')), name).toEqual([]);
    const back = readDwg(data);
    expect(back.warnings, name).toEqual([]);
    const a = underlaysOf(src), b = underlaysOf(back);
    expect(b.length, name).toBe(a.length);
    expect(b.map(shape), name).toEqual(a.map(shape));
  });

  it('survives ASCII DXF', () => {
    const back = readDxf(writeDxf(src));
    const a = underlaysOf(src), b = underlaysOf(back);
    expect(b.length).toBe(a.length);
    expect(b.map(shape)).toEqual(a.map(shape));
  });

  it('carries all three kinds with their own definitions', () => {
    const back = readDwg(writeDwg2018(src).data);
    const kinds = underlaysOf(back).map((u) => u.underlayKind);
    expect(kinds.filter((k) => k === 'pdf').length).toBe(3);
    expect(kinds).toContain('dgn');
    expect(kinds).toContain('dwf');
    const dgn = underlaysOf(back).find((u) => u.underlayKind === 'dgn')!;
    expect(dgn.path).toBe('site/plan.dgn');
    expect(dgn.itemName).toBe('Model');
  });

  it('shares one definition across placements of the same page', () => {
    /* three placements of one page must not write three definitions;
       the DXF names each definition once in its dictionary */
    const lines = writeDxf(src).split('\n');
    const text = lines.join('\n');
    /* group codes sit on the even lines: count the definition records,
       not the CLASSES entry that also names the type */
    let defs = 0;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      if (lines[i].trim() === '0' && lines[i + 1].trim() === 'PDFDEFINITION') {
        defs++;
      }
    }
    expect(defs).toBe(1);
    expect(text).toContain('DGNDEFINITION');
    expect(text).toContain('DWFDEFINITION');
    expect(text).toContain('ACAD_PDFDEFINITIONS');
  });

  it('keeps the clip boundary point for point', () => {
    const back = readDwg(writeDwg2004(src).data);
    const u = underlaysOf(back).find((e) => e.underlayKind === 'pdf')!;
    expect(u.clip?.length).toBe(3);
    expect(u.clip![0].y).toBeCloseTo(3.000519187844929, 9);
    expect(u.clip![1].x).toBeCloseTo(4.811503527941795, 9);
  });
});
