/* nasjidwg — four spellings pinned on the reference's own saves:
 *   - R13/R14 external references: the attachment is written as one
 *     (flags, path, no entity chain — the reference's R14 save of A-01,
 *     bit-walked), its dependent records flagged with the block handle;
 *   - a spline-fit polyline's VERTEX order: the first frame vertex, the
 *     whole fitted run, then the rest of the frame (the reference's DXF
 *     of its Road Profile and T-01 samples: 16, 8×n, 16, 16);
 *   - MTEXT paragraph codes before R2007, rewritten the way the
 *     reference's own 2004 / 2000 / R14 saves rewrite them;
 *   - `downgraded` names a dynamic block written static for its
 *     parameters and actions alone, and ACDB_RECOMPOSE_DATA lists the
 *     tables beside the column MTEXTs, ascending by handle.
 */
import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018, writeDwgR13, writeDwgR14
} from '../src/dwg/writer.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import { flattenMtextParagraphs } from '../src/text/mtext.js';
import type { Drawing, Entity, PolylineEntity, XdataValue } from '../src/core/model.js';

const line = (): Entity => ({
  type: 'line', layer: '0', color: { kind: 'byLayer' },
  start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 5, z: 0 }
});
const insert = (blockName: string, x: number): Entity => ({
  type: 'insert', layer: '0', color: { kind: 'byLayer' }, blockName,
  position: { x, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0
});

describe('R13/R14 external references', () => {
  const build = (): Drawing => {
    const d = emptyDrawing();
    d.blocks['Wall Base'] = {
      name: 'Wall Base', basePoint: { x: 0, y: 0, z: 0 }, entities: [],
      xref: { path: '.\\Res\\Wall Base.dwg' }
    };
    d.blocks['Grid Plan'] = {
      name: 'Grid Plan', basePoint: { x: 0, y: 0, z: 0 }, entities: [],
      xref: { path: '.\\Res\\Grid Plan.dwg', overlay: true }
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
      /* a detached attachment's leftover: nothing to belong to */
      { name: 'Gone|A-DOOR', color: { kind: 'aci', index: 1 }, on: true,
        frozen: false, locked: false, xrefDependent: true }
    );
    d.textStyles.push({ name: 'Wall Base|Notes', font: 'arial.ttf', xrefDependent: true });
    d.entities.push(line(), insert('Wall Base', 0), insert('Grid Plan', 10), insert('Wall Base', 20));
    return d;
  };

  it.each([['R14', writeDwgR14], ['R13', writeDwgR13]] as const)(
    '%s writes the attachment with its records; only the orphan stays home', (_label, write) => {
      const res = write(build());
      expect(res.skipped.filter((s) => /xref-dependent/.test(s)))
        .toEqual(['1 xref-dependent table records']);
      const back = readDwg(res.data);
      expect(back.blocks['Wall Base'].xref).toEqual({ path: '.\\Res\\Wall Base.dwg' });
      expect(back.blocks['Grid Plan'].xref).toEqual({ path: '.\\Res\\Grid Plan.dwg', overlay: true });
      expect(back.blocks['Wall Base'].entities).toEqual([]);
      const wall = back.layers.find((l) => l.name === 'Wall Base|A-WALL');
      expect(wall?.xrefDependent).toBe(true);
      expect(wall?.linetype).toBe('Wall Base|DASHED');
      expect(back.layers.find((l) => l.name === 'Grid Plan|GRID')?.xrefDependent).toBe(true);
      expect(back.layers.some((l) => l.name === 'Gone|A-DOOR')).toBe(false);
      expect(back.linetypes.find((lt) => lt.name === 'Wall Base|DASHED')?.xrefDependent).toBe(true);
      expect(back.textStyles.find((s) => s.name === 'Wall Base|Notes')?.xrefDependent).toBe(true);
      /* the drawing's own records are not flagged */
      expect(back.layers.find((l) => l.name === '0')?.xrefDependent).toBeFalsy();
      expect(back.entities.map((e) => e.type === 'insert' ? e.blockName : e.type))
        .toEqual(['line', 'Wall Base', 'Grid Plan', 'Wall Base']);
    });

  it('R14: the attachment survives a second generation', () => {
    const once = readDwg(writeDwgR14(build()).data);
    const twice = readDwg(writeDwgR14(once).data);
    expect(twice.blocks['Grid Plan'].xref).toEqual({ path: '.\\Res\\Grid Plan.dwg', overlay: true });
    expect(twice.layers.filter((l) => l.xrefDependent).map((l) => l.name).sort())
      .toEqual(['Grid Plan|GRID', 'Wall Base|A-WALL']);
  });
});

describe('spline-fit VERTEX order', () => {
  const spline = (): PolylineEntity => ({
    type: 'polyline', layer: '0', color: { kind: 'byLayer' }, closed: false,
    heavy: '2d', fit: 'cubic',
    frame: [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 4 }, { x: 9, y: 0 }],
    vertices: Array.from({ length: 9 }, (_, i) => ({ x: i * 9 / 8, y: Math.sin(i / 8 * Math.PI) * 3 }))
  });
  /** The 70 flag of every VERTEX in the file, in file order. */
  const vertexFlags = (dxf: string): number[] => {
    const rows = dxf.split(/\r?\n/);
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].trim() !== '0' || rows[i + 1]?.trim() !== 'VERTEX') continue;
      for (let j = i + 2; j < rows.length && rows[j].trim() !== '0'; j += 2) {
        if (rows[j].trim() === '70') out.push(Number(rows[j + 1]));
      }
    }
    return out;
  };

  it('DXF: the first frame vertex, the fitted run, the rest of the frame', () => {
    const d = emptyDrawing();
    d.entities.push(spline());
    const text = writeDxf(d);
    expect(vertexFlags(text)).toEqual([16, 8, 8, 8, 8, 8, 8, 8, 8, 8, 16, 16, 16]);
    const back = readDxf(text).entities[0] as PolylineEntity;
    expect(back.fit).toBe('cubic');
    expect(back.frame?.map((v) => v.x)).toEqual([0, 3, 6, 9]);
    expect(back.vertices).toHaveLength(9);
    expect(back.vertices[8].x).toBeCloseTo(9, 9);
  });

  it('DXF reader: the frame-first order reads back the same', () => {
    const d = emptyDrawing();
    d.entities.push(spline());
    const ours = writeDxf(d);
    /* move the three trailing frame records up behind the first one */
    const rows = ours.split(/\r?\n/);
    const starts: number[] = [];
    rows.forEach((r, i) => { if (r.trim() === '0' && rows[i + 1]?.trim() === 'VERTEX') starts.push(i); });
    const seqend = rows.findIndex((r, i) => r.trim() === '0' && rows[i + 1]?.trim() === 'SEQEND');
    const blocks = starts.map((s, k) => rows.slice(s, k + 1 < starts.length ? starts[k + 1] : seqend));
    const reordered = [blocks[0], ...blocks.slice(10), ...blocks.slice(1, 10)].flat();
    const swapped = [...rows.slice(0, starts[0]), ...reordered, ...rows.slice(seqend)].join('\n');
    const back = readDxf(swapped).entities[0] as PolylineEntity;
    expect(back.frame?.map((v) => v.x)).toEqual([0, 3, 6, 9]);
    expect(back.vertices).toHaveLength(9);
  });

  it.each([
    ['R14', writeDwgR14], ['2000', writeDwg2000], ['2018', writeDwg2018]
  ] as const)('DWG %s: frame and curve come back apart', (_label, write) => {
    const d = emptyDrawing();
    d.entities.push(spline());
    const back = readDwg(write(d).data).entities[0] as PolylineEntity;
    expect(back.fit).toBe('cubic');
    expect(back.frame?.map((v) => v.x)).toEqual([0, 3, 6, 9]);
    expect(back.vertices).toHaveLength(9);
    expect(back.vertices[4].y).toBeCloseTo(3, 9);
  });
});

describe('MTEXT paragraph codes before R2007', () => {
  /* the reference's 2008 spelling: alignment, indents and tab stops in
     multiples of the text height */
  const T2008 = '\\pxqc;Centred heading\\P\\pxi-3,l3,t3;1.\tIndented item\\P\\pxql;plain again';
  /* its 2004 spelling: indents and tab stops in drawing units */
  const T2004 = '\\pt6;{\\H1.6667x;\\L\\C4;GENERAL NOTES:\\P\\pi-9,l9,t9;}1.\tREFERENCE';

  it('2004: a 2008 text keeps its indents and tabs scaled by the height, loses alignment', () => {
    expect(flattenMtextParagraphs(T2008, 2004, 2.5))
      .toBe('Centred heading\\P\\pi-7.5,l7.5,t7.5;1.\tIndented item\\Pplain again');
    /* typed (centre/right/decimal) tab stops are 2008 only */
    expect(flattenMtextParagraphs('\\pxt2,c4,6;x\\P\\pxqj,b1,a0.5;y', 2004, 2))
      .toBe('\\pt4,12;x\\Py');
  });
  it('2004: a text without any \\px keeps its codes untouched, as the reference keeps them', () => {
    expect(flattenMtextParagraphs(T2004, 2004, 3)).toBe(T2004);
  });
  it('2000 and R14: every paragraph code goes, the rest stays', () => {
    expect(flattenMtextParagraphs(T2008, 2000, 2.5))
      .toBe('Centred heading\\P1.\tIndented item\\Pplain again');
    expect(flattenMtextParagraphs(T2004, 14, 3))
      .toBe('{\\H1.6667x;\\L\\C4;GENERAL NOTES:\\P}1.\tREFERENCE');
    expect(flattenMtextParagraphs(T2004, 13, 3))
      .toBe('{\\H1.6667x;\\L\\C4;GENERAL NOTES:\\P}1.\tREFERENCE');
  });
  it('2007 and later keep the text as it is; an escaped backslash is not a code', () => {
    expect(flattenMtextParagraphs(T2008, 2007, 2.5)).toBe(T2008);
    expect(flattenMtextParagraphs(T2008, 2018, 2.5)).toBe(T2008);
    expect(flattenMtextParagraphs('a\\\\pxq;b\\\\P', 2000, 1)).toBe('a\\\\pxq;b\\\\P');
  });

  const mtextDrawing = (text: string): Drawing => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'mtext', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, height: 2.5, rotation: 0, width: 80, text
    });
    return d;
  };
  const rawOf = (d: Drawing): string => {
    const e = d.entities[0];
    return e.type === 'mtext' ? (e.raw ?? e.text) : '';
  };

  it.each([
    ['2004', writeDwg2004, 'Centred heading\\P\\pi-7.5,l7.5,t7.5;1.\tIndented item\\Pplain again'],
    ['2000', writeDwg2000, 'Centred heading\\P1.\tIndented item\\Pplain again'],
    ['R14', writeDwgR14, 'Centred heading\\P1.\tIndented item\\Pplain again'],
    ['2007', writeDwg2007, T2008],
    ['2018', writeDwg2018, T2008]
  ] as const)('DWG %s writes what that release can show', (_label, write, expected) => {
    const back = readDwg(write(mtextDrawing(T2008)).data);
    expect(rawOf(back)).toBe(expected);
  });

  it('the R2000 DXF drops the codes the way the reference\'s 2000 save does', () => {
    const back = readDxf(writeDxf(mtextDrawing(T2008)));
    expect(rawOf(back)).toBe('Centred heading\\P1.\tIndented item\\Pplain again');
  });
});

describe('downgraded honesty for dynamic blocks', () => {
  const build = (): Drawing => {
    const d = emptyDrawing();
    d.blocks.ARROW = {
      name: 'ARROW', basePoint: { x: 0, y: 0, z: 0 }, entities: [line()],
      isDynamic: true,
      parameters: [{ kind: 'linear', name: 'Distance1' }, { kind: 'rotation', name: 'Angle1' }],
      actions: ['stretch']
    };
    d.blocks.PLAIN = { name: 'PLAIN', basePoint: { x: 0, y: 0, z: 0 }, entities: [line()] };
    d.entities.push(insert('ARROW', 0), insert('PLAIN', 20));
    return d;
  };
  const MESSAGE = 'dynamic block ARROW: 2 parameter(s) and 1 action(s) written static';

  it.each([
    ['R14', writeDwgR14], ['2000', writeDwg2000], ['2018', writeDwg2018]
  ] as const)('DWG %s: parameters and actions without visibility states are reported', (_label, write) => {
    const res = write(build());
    expect(res.downgraded).toEqual([MESSAGE]);
    const back = readDwg(res.data);
    expect(back.blocks.ARROW.entities).toHaveLength(1);
    expect(back.entities.filter((e) => e.type === 'insert')).toHaveLength(2);
  });

  it('DXF: the same report rides drawing.warnings', () => {
    const d = build();
    writeDxf(d);
    expect(d.warnings).toContain(MESSAGE);
    expect(d.warnings.filter((w) => /dynamic block/.test(w))).toHaveLength(1);
  });

  it('a block with nothing dynamic about it says nothing', () => {
    const d = emptyDrawing();
    d.blocks.PLAIN = { name: 'PLAIN', basePoint: { x: 0, y: 0, z: 0 }, entities: [line()] };
    d.entities.push(insert('PLAIN', 0));
    expect(writeDwg2018(d).downgraded).toEqual([]);
    writeDxf(d);
    expect(d.warnings).toEqual([]);
  });
});

describe('ACDB_RECOMPOSE_DATA lists the tables', () => {
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
  const table = (x: number, handle: string): Entity => ({
    type: 'table', layer: '0', color: { kind: 'byLayer' }, handle,
    position: { x, y: 30, z: 0 },
    numRows: 2, numColumns: 2, rowHeights: [1, 1], columnWidths: [3, 3],
    cells: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]
  });
  /* the tables' handles straddle the column parent's, so the record's
     order is the handle order and not the entity order */
  const build = (): Drawing => {
    const d = emptyDrawing();
    d.entities = [
      table(0, '2A0'),
      column(100, 'first column', '1A0', [
        { code: 1000, value: 'ACAD_MTEXT_COLUMNS_BEGIN' },
        { code: 1070, value: 47 }, { code: 1070, value: 2 },
        { code: 1005, value: '1A1' },
        { code: 1000, value: 'ACAD_MTEXT_COLUMNS_END' }
      ]),
      column(310, 'second column', '1A1'),
      table(400, 'A0')
    ];
    return d;
  };
  const recompose = (back: Drawing) =>
    back.xrecords?.find((x) => x.name === 'ACDB_RECOMPOSE_DATA');

  it.each([
    ['R14', writeDwgR14], ['2000', writeDwg2000], ['2004', writeDwg2004]
  ] as const)('%s: one 330 per table beside the column parent, ascending by handle', (label, write) => {
    const back = readDwg(write(build(), { preserveHandles: true }).data);
    /* the R14 spelling of ACAD_TABLE is one the reader does not decode
       yet: the record travels (the reference counts two tables) but
       comes back sealed, so the type is asserted from R2000 on */
    if (label !== 'R14') {
      expect(back.entities.filter((e) => e.type === 'table').map((e) => e.handle).sort())
        .toEqual(['2A0', 'A0']);
    }
    expect(recompose(back)?.values).toEqual([
      { code: 90, value: 1 },
      { code: 330, value: 'A0' }, { code: 330, value: '1A0' }, { code: 330, value: '2A0' }
    ]);
  });

  it('a table alone earns the record; R2007 writes none', () => {
    const d = emptyDrawing();
    d.entities = [table(0, 'B0')];
    const back = readDwg(writeDwg2000(d, { preserveHandles: true }).data);
    expect(recompose(back)?.values).toEqual([{ code: 90, value: 1 }, { code: 330, value: 'B0' }]);
    expect(recompose(readDwg(writeDwg2007(build()).data))).toBeUndefined();
  });

  it('DXF: the record names the tables and the column parent under their written handles', () => {
    const back = readDxf(writeDxf(build()));
    const rec = recompose(back);
    const listed = (rec?.values ?? [])
      .filter((v) => v.code === 330).map((v) => String(v.value).toUpperCase());
    const expected = back.entities
      .filter((e) => e.type === 'table' || (e.type === 'mtext' && e.text === 'first column'))
      .map((e) => (e.handle ?? '').toUpperCase())
      .sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
    expect(expected).toHaveLength(3);
    expect(listed).toEqual(expected);
  });
});
