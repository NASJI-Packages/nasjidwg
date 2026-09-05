/* R13/R14 acceptance regressions — the record set and field widths that
 * AutoCAD 2027 requires before it opens an AC1014 file (campaign round 4;
 * every rule here was pinned externally with accoreconsole):
 *   - a DIMSTYLE "STANDARD" and MLINESTYLE "STANDARD" must exist, with the
 *     ACAD_MLINESTYLE dictionary naming the style;
 *   - simple entities spell thickness as a full BD and extrusion as a full
 *     3BD (the one-bit BT/BE shortcuts are R2000 inventions — with them the
 *     drawing is refused, ErrorStatus 53);
 *   - dimension styles ride through for every version from R13 on.
 */
import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwgR14, writeDwg2000, writeDwg2004, writeDwg2007 } from '../src/dwg/writer.js';
import { decodeObjectBody, makeContext } from '../src/dwg/objects.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, XdataValue } from '../src/core/model.js';

const lineDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.entities = [{
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 50, z: 0 }
  }];
  return d;
};

describe('R14 required records', () => {
  const back = readDwg(writeDwgR14(lineDrawing()).data);

  it('synthesizes DIMSTYLE STANDARD', () => {
    expect(back.dimStyles?.map((s) => s.name)).toEqual(['STANDARD']);
  });

  it('synthesizes MLINESTYLE STANDARD with the two ±0.5 elements', () => {
    const ms = back.mlineStyles?.[0];
    expect(ms?.name).toBe('STANDARD');
    expect(ms?.elements.map((e) => e.offset)).toEqual([0.5, -0.5]);
    expect(ms?.startAngle).toBeCloseTo(Math.PI / 2, 12);
  });

  it('round-trips the lone line through the full-width R14 fields', () => {
    const line = back.entities.find((e) => e.type === 'line');
    expect(line && line.type === 'line' && line.end.x).toBe(100);
  });
});

describe('dimension styles ride through the R13+ writers', () => {
  it('writes the source dimStyles at R2000 and resolves dimension.style', () => {
    const d = lineDrawing();
    d.dimStyles = [{ name: 'S1', vars: { DIMSCALE: 2 } }];
    d.entities.push({
      type: 'dimension', layer: '0', color: { kind: 'byLayer' },
      dimensionType: 33, kind: 'linear', style: 'S1',
      definitionPoint: { x: 0, y: 0, z: 0 }
    });
    const back = readDwg(writeDwg2000(d).data);
    expect(back.dimStyles?.map((s) => s.name).sort()).toEqual(['S1', 'Standard']);
    const dim = back.entities.find((e) => e.type === 'dimension');
    expect(dim && dim.type === 'dimension' && dim.style).toBe('S1');
  });
});

/* Before R2007 a column MTEXT is two entities: the first column names
 * the second by handle in its ACAD_MTEXT_COLUMNS xdata. The reference
 * folds them back into one on load only when an ACDB_RECOMPOSE_DATA
 * record under the named objects dictionary lists the first column
 * (externally proven on its own R2000 DXF of the Text-and-Tables sample:
 * with the record the census reads MTEXT=1, without it MTEXT=2, the
 * entities otherwise identical). */
describe('column MTEXT before R2007 lists its first column for recomposition', () => {
  const columnInfo: XdataValue[] = [
    { code: 1000, value: 'ACAD_MTEXT_COLUMN_INFO_BEGIN' },
    { code: 1070, value: 75 }, { code: 1070, value: 1 },
    { code: 1070, value: 79 }, { code: 1070, value: 1 },
    { code: 1070, value: 76 }, { code: 1070, value: 2 },
    { code: 1070, value: 78 }, { code: 1070, value: 0 },
    { code: 1070, value: 48 }, { code: 1040, value: 200 },
    { code: 1070, value: 49 }, { code: 1040, value: 10 },
    { code: 1000, value: 'ACAD_MTEXT_COLUMN_INFO_END' }
  ];
  const column = (x: number, text: string, handle: string, extra: XdataValue[] = []): Entity => ({
    type: 'mtext', layer: '0', color: { kind: 'byLayer' },
    position: { x, y: 0, z: 0 }, height: 3, rotation: 0, width: 200,
    text, handle,
    xdata: [{ appName: 'ACAD', values: [...columnInfo, ...extra] }]
  });
  const columnDrawing = (): Drawing => {
    const d = emptyDrawing();
    d.entities = [
      column(0, 'first column', '1A0', [
        { code: 1000, value: 'ACAD_MTEXT_COLUMNS_BEGIN' },
        { code: 1070, value: 47 }, { code: 1070, value: 2 },
        { code: 1005, value: '1A1' },
        { code: 1000, value: 'ACAD_MTEXT_COLUMNS_END' }
      ]),
      column(210, 'second column', '1A1')
    ];
    return d;
  };
  const recompose = (back: Drawing) =>
    back.xrecords?.find((x) => x.name === 'ACDB_RECOMPOSE_DATA');
  const firstColumn = (back: Drawing) =>
    back.entities.find((e) => e.type === 'mtext' && e.text === 'first column');

  it.each([
    ['R14', writeDwgR14], ['R2000', writeDwg2000], ['R2004', writeDwg2004]
  ] as const)('%s: one XRECORD naming the first column, under the NOD', (_v, write) => {
    const back = readDwg(write(columnDrawing(), { preserveHandles: true }).data);
    const parent = firstColumn(back);
    expect(parent?.handle).toBeDefined();
    expect(recompose(back)?.values).toEqual([
      { code: 90, value: 1 }, { code: 330, value: parent!.handle }
    ]);
    /* the first column still names the second by its written handle */
    const second = back.entities.find((e) => e.type === 'mtext' && e.text === 'second column');
    const ref = parent?.xdata?.[0].values.find((v) => v.code === 1005);
    expect(ref && 'value' in ref && ref.value).toBe(second?.handle);
  });

  it('R2007 carries the columns natively: no record', () => {
    const back = readDwg(writeDwg2007(columnDrawing()).data);
    expect(recompose(back)).toBeUndefined();
  });

  it('a drawing without column MTEXT writes no record', () => {
    const back = readDwg(writeDwgR14(lineDrawing()).data);
    expect(recompose(back)).toBeUndefined();
  });
});

/* An INSERT of a block the drawing does not define is dropped before the
 * handles are handed out: dropped at encoding time instead, its handle
 * stayed in the R13/R14 sibling chain and the block header's first/last
 * links, and the reference refused the file (ErrorStatus 53 on a block
 * reduced to one LINE and one such INSERT). */
describe('an INSERT of an undefined block leaves the R14 chain whole', () => {
  it('drops the insert, reports it, and links the remaining entity to nothing', () => {
    const d = emptyDrawing();
    d.blocks.B = {
      name: 'B', basePoint: { x: 0, y: 0, z: 0 }, entities: [{
        type: 'insert', layer: '0', color: { kind: 'byLayer' },
        blockName: 'MISSING', position: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }, rotation: 0
      }, {
        type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
      }]
    };
    const res = writeDwgR14(d);
    expect(res.skipped).toContain('insert:MISSING');
    const back = readDwg(res.data, { retainRecords: true });
    expect(back.blocks.B?.entities.map((e) => e.type)).toEqual(['line']);
    const line = back.blocks.B.entities[0];
    const raw = decodeObjectBody(
      new Uint8Array(Buffer.from(line.record!.data, 'base64')),
      makeContext('R14', new Map())
    );
    expect(raw?.typeName).toBe('LINE');
    expect([raw?.prev, raw?.next]).toEqual([0, 0]);
  });
});
