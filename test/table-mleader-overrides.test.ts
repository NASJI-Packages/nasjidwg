/* nasjidwg — the per-cell formatting of an ACAD_TABLE and the block
 * labels of a MULTILEADER: what a schedule looks like beyond its text.
 * Every field round-trips through the DWG containers and the ASCII DXF
 * writer, read back by the library's own readers (which are certified
 * against the reference's saves of its samples for the same records). */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018 } from '../src/dwg/writer.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, MLeaderEntity, TableEntity, TextEntity } from '../src/core/model.js';

const byLayer = { kind: 'byLayer' } as const;

/** A block with two attribute definitions, a multileader showing it with
 *  both values, and a schedule with every override the model carries. */
const build = (): Drawing => {
  const d = emptyDrawing();
  d.textStyles.push({ name: 'Notes', font: 'arial.ttf' });
  const attdef = (tag: string, y: number, handle: string): TextEntity => ({
    type: 'text', layer: '0', color: byLayer, handle, attribute: 'attdef',
    position: { x: 0, y, z: 0 }, text: tag, height: 0.2, rotation: 0
  });
  d.blocks['CALLOUT'] = {
    name: 'CALLOUT', basePoint: { x: 0, y: 0, z: 0 },
    entities: [
      { type: 'circle', layer: '0', color: byLayer, center: { x: 0, y: 0, z: 0 }, radius: 1 },
      attdef('NUMBER', 0.2, 'A1'),
      attdef('SHEET', -0.4, 'A2')
    ]
  };
  d.blocks['SYMBOL'] = {
    name: 'SYMBOL', basePoint: { x: 0, y: 0, z: 0 },
    entities: [
      { type: 'line', layer: '0', color: byLayer, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } },
      attdef('CODE', 0, 'B1')
    ]
  };
  d.entities.push({
    type: 'mleader', layer: '0', color: byLayer,
    leaders: [{
      landing: { x: 10, y: 10, z: 0 }, doglegVector: { x: 1, y: 0, z: 0 }, doglegLength: 2,
      lines: [[{ x: 4, y: 4, z: 0 }, { x: 10, y: 10, z: 0 }]]
    }],
    blockName: 'CALLOUT', blockPosition: { x: 13, y: 10, z: 0 },
    blockScale: { x: 1, y: 1, z: 1 }, blockRotation: 0,
    scale: 1, arrowSize: 0.18, hasLanding: true, hasDogleg: true,
    attributes: [
      { attdef: 'A1', index: 1, text: '7', width: 0 },
      { attdef: 'A2', index: 2, text: 'A-101', width: 1.5 }
    ]
  } as Entity);
  d.entities.push({
    type: 'table', layer: '0', color: byLayer,
    position: { x: 1, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 },
    numRows: 3, numColumns: 2,
    rowHeights: [0.5, 0.4, 0.4], columnWidths: [2.5, 2.5],
    titleSuppressed: true, headerSuppressed: true,
    flowDirection: 1, horizontalMargin: 0.1, verticalMargin: 0.05,
    cells: [
      {
        text: 'SCHEDULE', spanColumns: 2, alignment: 5, textStyle: 'Notes',
        textHeight: 0.25, textColor: { kind: 'aci', index: 1 },
        fillColor: { kind: 'aci', index: 3 }, fillEnabled: true, rotation: 0.5,
        autofit: true,
        borders: {
          top: { color: { kind: 'aci', index: 2 }, lineweight: 50, visible: false },
          left: { visible: true },
          bottom: { lineweight: -1 }
        }
      },
      {},
      { text: 'A', alignment: 4, borders: { right: { color: { kind: 'rgb', rgb: 0xff0000 } } } },
      { text: 'B', textColor: { kind: 'byLayer' } },
      {
        contentType: 2, blockName: 'SYMBOL', alignment: 5,
        attributes: [{ attdef: 'B1', index: 1, text: 'S-1' }]
      },
      { text: 'C1', fillEnabled: false }
    ]
  } as Entity);
  return d;
};

const tableOf = (d: Drawing): TableEntity => {
  const t = d.entities.find((e) => e.type === 'table');
  expect(t?.type).toBe('table');
  return t as TableEntity;
};
const mleaderOf = (d: Drawing): MLeaderEntity => {
  const m = d.entities.find((e) => e.type === 'mleader');
  expect(m?.type).toBe('mleader');
  return m as MLeaderEntity;
};
const attdefHandles = (d: Drawing, block: string): (string | undefined)[] =>
  d.blocks[block].entities
    .filter((e): e is TextEntity => e.type === 'text' && e.attribute === 'attdef')
    .map((e) => e.handle?.toUpperCase());

/** What every container carries (the R2010+ form keeps a subset). */
const checkCommon = (back: Drawing): void => {
  const m = mleaderOf(back);
  expect(m.blockName).toBe('CALLOUT');
  expect(m.attributes?.map((a) => [a.index, a.text])).toEqual([[1, '7'], [2, 'A-101']]);
  expect(m.attributes?.[1].width).toBeCloseTo(1.5, 9);
  /* the labels name the definitions the block was written with, and the
     tags those definitions carry (the model keeps no ATTDEF tag, so the
     writers invent one — the label follows whatever was written) */
  const defs = attdefHandles(back, 'CALLOUT');
  expect(m.attributes?.map((a) => a.attdef)).toEqual(defs);
  expect(m.attributes?.every((a) => typeof a.tag === 'string' && a.tag.length > 0)).toBe(true);

  const t = tableOf(back);
  expect(t.numRows).toBe(3);
  expect(t.titleSuppressed).toBe(true);
  expect(t.headerSuppressed).toBe(true);
  const c0 = t.cells[0];
  expect(c0.text).toBe('SCHEDULE');
  expect(c0.spanColumns).toBe(2);
  expect(c0.alignment).toBe(5);
  expect(c0.textStyle).toBe('Notes');
  expect(c0.textColor).toEqual({ kind: 'aci', index: 1 });
  expect(c0.fillColor).toEqual({ kind: 'aci', index: 3 });
  expect(c0.rotation).toBeCloseTo(0.5, 9);
  expect(c0.borders?.top).toEqual({ color: { kind: 'aci', index: 2 }, lineweight: 50, visible: false });
  expect(c0.borders?.left).toEqual({ visible: true });
  expect(c0.borders?.bottom).toEqual({ lineweight: -1 });
  expect(t.cells[1].merged).toBe(true);
  expect(t.cells[2].alignment).toBe(4);
  /* a true colour survives the DWG CMC; the DXF spelling is an index */
  const right = t.cells[2].borders?.right?.color;
  expect(right && (right.kind === 'rgb' ? right.rgb : right.kind === 'aci' ? right.index : -1))
    .toSatisfy((v: number) => v === 0xff0000 || v === 1);
  expect(t.cells[3].textColor).toEqual({ kind: 'byLayer' });
  const blockCell = t.cells[4];
  expect(blockCell.contentType).toBe(2);
  expect(blockCell.blockName).toBe('SYMBOL');
  expect(blockCell.attributes?.map((a) => [a.index, a.text])).toEqual([[1, 'S-1']]);
  expect(blockCell.attributes?.[0].attdef).toBe(attdefHandles(back, 'SYMBOL')[0]);
  expect(typeof blockCell.attributes?.[0].tag).toBe('string');
};

/** The pre-2010 grammar and the DXF spelling carry everything. */
const checkFull = (back: Drawing): void => {
  checkCommon(back);
  const t = tableOf(back);
  const c0 = t.cells[0];
  expect(c0.textHeight).toBeCloseTo(0.25, 9);
  expect(c0.fillEnabled).toBe(true);
  expect(c0.autofit).toBe(true);
  expect(t.cells[5].fillEnabled).toBe(false);
  expect(t.flowDirection).toBe(1);
  expect(t.horizontalMargin).toBeCloseTo(0.1, 9);
  expect(t.verticalMargin).toBeCloseTo(0.05, 9);
};

describe('table cell overrides and multileader block labels', () => {
  it.each([
    ['R2000', writeDwg2000],
    ['R2004', writeDwg2004],
    ['R2007', writeDwg2007]
  ])('round-trip through the pre-2010 DWG record (%s)', (_name, write) => {
    const res = write(build());
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    checkFull(back);
  });

  it('round-trip through the R2018 linked-table record', () => {
    const res = writeDwg2018(build());
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    checkCommon(back);
  });

  it('round-trip through ASCII DXF', () => {
    const text = writeDxf(build());
    const back = readDxf(text);
    checkFull(back);
    /* the reference's own spelling: labels between 293 and 294, the
       cell's 177 word and its border groups, the table's 280/281 */
    expect(text).toMatch(/\n293\n0\n330\n[0-9A-F]+\n177\n1\n44\n0\n302\n7\n330\n[0-9A-F]+\n177\n2\n44\n1\.5\n302\nA-101\n294\n/);
    expect(text).toMatch(/\n93\n31\n94\n0\n95\n0\n96\n0\n280\n1\n281\n1\n70\n1\n40\n0\.1\n41\n0\.05\n/);
    /* 172 announces the overridden edges (top 1 + bottom 4 + left 8),
       283 is the file's "fill none" flag, the edges come right, bottom,
       left, top as lineweight / visibility / colour */
    expect(text).toMatch(/\n171\n1\n172\n13\n173\n0\n174\n1\n175\n2\n176\n1\n177\n21631\n/);
    expect(text).toMatch(/\n283\n0\n63\n3\n64\n1\n7\nNotes\n140\n0\.25\n276\n-1\n288\n0\n279\n50\n289\n1\n69\n2\n/);
  });

  it('keeps a DWG source through DXF and back', () => {
    const viaDwg = readDwg(writeDwg2000(build()).data);
    const back = readDxf(writeDxf(viaDwg));
    checkFull(back);
    const again = readDwg(writeDwg2004(back).data);
    checkFull(again);
  });
});
