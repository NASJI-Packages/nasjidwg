/* nasjidwg — the DXF path: what the reference's own DXF says that the
 * reader used to drop, now carried through to DWG.
 *
 *   - every non-current paper-space layout (BLOCK *Paper_Space<n> with
 *     its entities, linked from its LAYOUT object)
 *   - ACAD_TABLE and MULTILEADER, decoded into the model's table and
 *     mleader entities instead of tag-sealed unknowns the DWG writer
 *     cannot use
 *   - ACAD_PROXY_OBJECT in the 2018 spelling (71/97 version words,
 *     160/161/162 sizes) with its xdata, which for some applications is
 *     the whole object
 *
 * The fixtures are hand-written token by token in the reference's
 * spelling, so the tests pin the format knowledge itself. */

import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import type { Drawing, Entity } from '../src/core/model.js';

const dxf = (rows: (string | number)[]): string => rows.map(String).join('\n') + '\n';

const entitiesOf = (d: Drawing): Entity[] => [
  ...d.entities, ...(d.paperSpace ?? []),
  ...Object.values(d.blocks).flatMap((b) => b.entities)
];

/* ------------------------------------------------------------------ */

const layoutsFixture = (): string => dxf([
  0, 'SECTION', 2, 'TABLES',
  0, 'TABLE', 2, 'BLOCK_RECORD', 5, '1', 100, 'AcDbSymbolTable', 70, 3,
  0, 'BLOCK_RECORD', 5, '1F', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord',
  2, '*Model_Space', 340, '22',
  0, 'BLOCK_RECORD', 5, 'AA0', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord',
  2, '*Paper_Space', 340, 'A9E',
  0, 'BLOCK_RECORD', 5, '2078', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord',
  2, '*Paper_Space7', 340, '2076',
  0, 'ENDTAB',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 5, '20', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockBegin',
  2, '*Model_Space', 70, 0, 10, 0, 20, 0, 30, 0, 3, '*Model_Space', 1, '',
  0, 'ENDBLK', 5, '21', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd',
  0, 'BLOCK', 5, 'ABC', 330, 'AA0', 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbBlockBegin',
  2, '*Paper_Space', 70, 0, 10, 0, 20, 0, 30, 0, 3, '*Paper_Space', 1, '',
  0, 'ENDBLK', 5, 'ABD', 330, 'AA0', 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbBlockEnd',
  /* the non-current layout: its entities live INSIDE the block */
  0, 'BLOCK', 5, '20A5', 330, '2078', 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbBlockBegin',
  2, '*Paper_Space7', 70, 0, 10, 0, 20, 0, 30, 0, 3, '*Paper_Space7', 1, '',
  0, 'LINE', 5, '20A6', 330, '2078', 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbLine',
  10, 1, 20, 2, 30, 0, 11, 3, 21, 4, 31, 0,
  0, 'CIRCLE', 5, '20A7', 330, '2078', 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbCircle',
  10, 5, 20, 5, 30, 0, 40, 2.5,
  0, 'ENDBLK', 5, '20A8', 330, '2078', 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbBlockEnd',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 5, '30', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbLine',
  10, 0, 20, 0, 30, 0, 11, 1, 21, 1, 31, 0,
  0, 'LINE', 5, '31', 330, 'AA0', 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbLine',
  10, 0, 20, 0, 30, 0, 11, 2, 21, 2, 31, 0,
  0, 'ENDSEC',
  0, 'SECTION', 2, 'OBJECTS',
  0, 'DICTIONARY', 5, 'C', 330, 0, 100, 'AcDbDictionary', 281, 1,
  3, 'ACAD_LAYOUT', 350, '1A',
  0, 'DICTIONARY', 5, '1A', 330, 'C', 100, 'AcDbDictionary', 281, 1,
  3, 'Model', 350, '22', 3, 'Plan 1 of 4', 350, 'A9E', 3, 'Plan 4 of 4', 350, '2076',
  0, 'LAYOUT', 5, '22', 330, '1A', 100, 'AcDbPlotSettings', 1, '', 2, 'none_device',
  4, '', 6, '', 7, '', 70, 688, 100, 'AcDbLayout', 1, 'Model', 70, 1, 71, 0,
  10, 0, 20, 0, 11, 12, 21, 9, 12, 0, 22, 0, 32, 0, 330, '1F',
  0, 'LAYOUT', 5, 'A9E', 330, '1A', 100, 'AcDbPlotSettings', 1, '', 2, 'none_device',
  4, '', 6, '', 7, '', 70, 688, 100, 'AcDbLayout', 1, 'Plan 1 of 4', 70, 1, 71, 1,
  10, 0, 20, 0, 11, 12, 21, 9, 12, 0, 22, 0, 32, 0, 330, 'AA0',
  0, 'LAYOUT', 5, '2076', 330, '1A', 100, 'AcDbPlotSettings', 1, '', 2, 'none_device',
  4, '', 6, '', 7, '', 70, 688, 100, 'AcDbLayout', 1, 'Plan 4 of 4', 70, 1, 71, 4,
  10, 0, 20, 0, 11, 12, 21, 9, 12, 0, 22, 0, 32, 0, 330, '2078',
  0, 'ENDSEC',
  0, 'EOF'
]);

describe('extra paper-space layouts through DXF', () => {
  const d = readDxf(layoutsFixture());

  it('keeps the non-current layout as *Paper_Space2, the current spaces as ENTITIES', () => {
    expect(Object.keys(d.blocks)).toEqual(['*Paper_Space2']);
    expect(d.blocks['*Paper_Space2'].entities.map((e) => e.type)).toEqual(['line', 'circle']);
    expect(d.blocks['*Paper_Space2'].handle).toBe('2078');
    expect(d.entities.length).toBe(1);
    expect(d.paperSpace?.length).toBe(1);
  });

  it('links every LAYOUT to its block the way the DWG reader names them', () => {
    const byName = new Map((d.layouts ?? []).map((l) => [l.name, l.blockName]));
    expect(byName.get('Model')).toBe('*Model_Space');
    expect(byName.get('Plan 1 of 4')).toBe('*Paper_Space');
    expect(byName.get('Plan 4 of 4')).toBe('*Paper_Space2');
  });

  it('round-trips through the DXF writer', () => {
    const again = readDxf(writeDxf(d));
    expect(again.blocks['*Paper_Space2']?.entities.map((e) => e.type)).toEqual(['line', 'circle']);
    expect(again.layouts?.find((l) => l.name === 'Plan 4 of 4')?.blockName).toBe('*Paper_Space2');
    expect(again.paperSpace?.length).toBe(1);
  });

  it('is written to DWG as a layout of its own and read back with its entities', () => {
    const res = writeDwg2018(d);
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const extra = Object.keys(back.blocks).find((nm) => /^\*paper_space2$/i.test(nm));
    expect(extra).toBeDefined();
    expect(back.blocks[extra!].entities.map((e) => e.type)).toEqual(['line', 'circle']);
    const l = back.layouts?.find((x) => x.name === 'Plan 4 of 4');
    expect(l?.blockName).toBe(extra);
    expect(l?.tabOrder).toBe(4);
    expect(back.layouts?.map((x) => x.name).sort()).toEqual(['Model', 'Plan 1 of 4', 'Plan 4 of 4']);
    expect(back.entities.length).toBe(1);
    expect(back.paperSpace?.length).toBe(1);
    expect(back.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

const tableFixture = (): string => dxf([
  0, 'SECTION', 2, 'TABLES',
  0, 'TABLE', 2, 'BLOCK_RECORD', 5, '1', 100, 'AcDbSymbolTable', 70, 2,
  0, 'BLOCK_RECORD', 5, '1F', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, '*Model_Space',
  0, 'BLOCK_RECORD', 5, '15E4', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, 'SUPPORT',
  0, 'ENDTAB',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'ACAD_TABLE', 5, '775', 330, '1F', 100, 'AcDbEntity', 8, 'T',
  100, 'AcDbBlockReference', 2, '*T15', 10, 500.5, 20, 547.25, 30, 0,
  100, 'AcDbTable', 280, 0, 342, 'BB7', 343, '82C', 11, 1, 21, 0, 31, 0,
  90, 22, 91, 2, 92, 2, 93, 2, 94, 0, 95, 0, 96, 0, 281, 1,
  141, 11, 141, 27, 142, 52, 142, 96,
  /* row 0: a title spanning both columns, its merged-away neighbour */
  171, 1, 172, 0, 173, 0, 174, 0, 175, 2, 176, 1, 91, 262144, 178, 0, 145, 0, 92, 0,
  301, 'CELL_VALUE', 93, 4, 90, 4, 1, '{\\L\\C4;LEGEND}', 94, 0, 300, '', 302, 'LEGEND', 304, 'ACVALUE_END',
  171, 1, 172, 0, 173, 1, 174, 0, 175, 1, 176, 1, 91, 0, 178, 0, 145, 0, 92, 0,
  301, 'CELL_VALUE', 93, 7, 90, 0, 94, 0, 300, '', 302, '', 304, 'ACVALUE_END',
  /* row 1: a block cell and a text cell spelled the older way (3 + 1) */
  171, 2, 172, 0, 173, 0, 174, 0, 175, 1, 176, 1, 91, 1, 178, 0, 145, 0,
  340, '15E4', 144, 1, 179, 0, 170, 5, 92, 0,
  301, 'CELL_VALUE', 93, 1, 90, 4, 94, 0, 300, '', 302, '', 304, 'ACVALUE_END',
  171, 1, 172, 8, 173, 0, 174, 0, 175, 1, 176, 1, 91, 401920, 178, 0, 145, 0, 140, 2.5,
  3, 'PIPE ', 1, 'SUPPORT',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'OBJECTS',
  0, 'DICTIONARY', 5, 'C', 330, 0, 100, 'AcDbDictionary', 281, 1, 3, 'ACAD_TABLESTYLE', 350, 'BB6',
  0, 'DICTIONARY', 5, 'BB6', 330, 'C', 100, 'AcDbDictionary', 281, 1, 3, 'Standard', 350, 'BB7',
  0, 'ENDSEC',
  0, 'EOF'
]);

describe('ACAD_TABLE through DXF', () => {
  const d = readDxf(tableFixture());
  const t = d.entities.find((e) => e.type === 'table');

  it('decodes the grid, the merges, the block cell and both text spellings', () => {
    expect(t?.type).toBe('table');
    if (t?.type !== 'table') return;
    expect(t.handle).toBe('775');
    expect(t.position).toEqual({ x: 500.5, y: 547.25, z: 0 });
    expect(t.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(t.numRows).toBe(2);
    expect(t.numColumns).toBe(2);
    expect(t.rowHeights).toEqual([11, 27]);
    expect(t.columnWidths).toEqual([52, 96]);
    expect(t.blockName).toBe('*T15');
    expect(t.styleName).toBe('Standard');
    expect(t.cells.length).toBe(4);
    expect(t.cells[0]).toEqual({ contentType: 1, spanColumns: 2, text: '{\\L\\C4;LEGEND}' });
    expect(t.cells[1]).toEqual({ contentType: 1 });
    expect(t.cells[2]).toEqual({ contentType: 2, blockName: 'SUPPORT', alignment: 5 });
    expect(t.cells[3]).toEqual({ contentType: 1, textHeight: 2.5, text: 'PIPE SUPPORT' });
    expect(d.warnings).toEqual([]);
  });

  it('reaches DWG as an ACAD_TABLE and reads back', () => {
    const res = writeDwg2018(d);
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const bt = back.entities.find((e) => e.type === 'table');
    expect(bt?.type).toBe('table');
    if (bt?.type !== 'table') return;
    expect(bt.numRows).toBe(2);
    expect(bt.numColumns).toBe(2);
    expect(bt.rowHeights).toEqual([11, 27]);
    expect(bt.columnWidths).toEqual([52, 96]);
    expect(bt.cells[0].text).toBe('{\\L\\C4;LEGEND}');
    expect(bt.cells[0].spanColumns).toBe(2);
    expect(bt.cells[3].text).toBe('PIPE SUPPORT');
    expect(back.warnings).toEqual([]);
  });

  it('a record without a grid stays a sealed unknown', () => {
    const bare = readDxf(dxf([
      0, 'SECTION', 2, 'ENTITIES',
      0, 'ACAD_TABLE', 5, '10', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockReference', 2, '*T1',
      10, 0, 20, 0, 30, 0, 100, 'AcDbTable', 280, 0,
      0, 'ENDSEC', 0, 'EOF'
    ]));
    expect(bare.entities[0]?.type).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */

const mleaderFixture = (blockContent: boolean): string => dxf([
  0, 'SECTION', 2, 'TABLES',
  0, 'TABLE', 2, 'STYLE', 5, '3', 100, 'AcDbSymbolTable', 70, 1,
  0, 'STYLE', 5, '10', 100, 'AcDbSymbolTableRecord', 100, 'AcDbTextStyleTableRecord',
  2, 'Notes', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, 2.5, 3, 'arial.ttf', 4, '',
  0, 'ENDTAB',
  0, 'TABLE', 2, 'BLOCK_RECORD', 5, '1', 100, 'AcDbSymbolTable', 70, 2,
  0, 'BLOCK_RECORD', 5, '1F', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, '*Model_Space',
  0, 'BLOCK_RECORD', 5, '2012', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, 'TAG',
  0, 'ENDTAB',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 5, '2013', 330, '2012', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockBegin',
  2, 'TAG', 70, 0, 10, 0, 20, 0, 30, 0, 3, 'TAG', 1, '',
  0, 'CIRCLE', 5, '2014', 330, '2012', 100, 'AcDbEntity', 8, '0', 100, 'AcDbCircle',
  10, 0, 20, 0, 30, 0, 40, 1,
  0, 'ENDBLK', 5, '2015', 330, '2012', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'MULTILEADER', 5, '1EC8', 330, '1F', 100, 'AcDbEntity', 8, 'N',
  100, 'AcDbMLeader', 270, 2,
  300, 'CONTEXT_DATA{',
  40, 1, 10, 428, 20, 140, 30, 0, 41, 3, 140, 2.5, 145, 1.5,
  174, 1, 175, 1, 176, 0, 177, 0,
  ...(blockContent ? [
    290, 0,
    296, 1, 341, '2012', 14, 0, 24, 0, 34, 1, 15, 155.5, 25, 429.5, 35, 0,
    16, 2, 26, 2, 36, 2, 46, 0.5, 93, -1073741824,
    ...Array.from({ length: 16 }, (_, i) => [47, i % 5 === 0 ? 1 : 0]).flat()
  ] : [
    290, 1, 304, 'RUPTURE DISK \\PSHEET 2',
    11, 0, 21, 0, 31, 1, 340, '10',
    12, 429.5, 22, 142.5, 32, 0, 13, 1, 23, 0, 33, 0, 42, 0.25, 43, 0, 44, 0, 45, 1,
    170, 1, 90, -1073741824, 171, 1, 172, 5, 91, -1073741824, 141, 0, 92, 13421772,
    291, 0, 292, 0, 173, 0, 293, 0, 142, 0, 143, 0, 294, 0, 295, 0, 296, 0
  ]),
  110, 418, 120, 87, 130, 0, 111, 1, 121, 0, 131, 0, 112, 0, 122, 1, 132, 0, 297, 0,
  302, 'LEADER{',
  290, 1, 291, 1, 10, 423, 20, 140, 30, 0, 11, 1, 21, 0, 31, 0, 90, 0, 40, 5,
  304, 'LEADER_LINE{', 10, 418, 20, 87, 30, 0, 10, 420, 20, 100, 30, 0, 91, 0, 305, '}',
  304, 'LEADER_LINE{', 10, 400, 20, 80, 30, 0, 91, 1, 305, '}',
  271, 0,
  303, '}',
  302, 'LEADER{',
  290, 1, 291, 1, 10, 500, 20, 140, 30, 0, 11, -1, 21, 0, 31, 0, 90, 0, 40, 5,
  304, 'LEADER_LINE{', 10, 510, 20, 90, 30, 0, 91, 0, 305, '}',
  271, 0,
  303, '}',
  272, 9, 273, 9,
  301, '}',
  340, '1DB6', 90, 17105920, 170, 1, 91, -1056964608, 341, '13', 171, -2,
  290, 1, 291, 1, 41, 5, 42, 2.5, 172, blockContent ? 1 : 2, 343, '10',
  173, 1, 95, 1, 174, 1, 175, 0, 92, -1056964608, 292, 0,
  ...(blockContent ? [344, '2012'] : []),
  93, -1056964608, 10, 1, 20, 1, 30, 1, 43, 0, 176, 0, 293, 0,
  294, 0, 178, 0, 179, 1, 45, 1, 271, 0, 272, 9, 273, 9, 295, 0,
  0, 'ENDSEC',
  0, 'SECTION', 2, 'OBJECTS',
  0, 'DICTIONARY', 5, 'C', 330, 0, 100, 'AcDbDictionary', 281, 1, 3, 'ACAD_MLEADERSTYLE', 350, '1DB5',
  0, 'DICTIONARY', 5, '1DB5', 330, 'C', 100, 'AcDbDictionary', 281, 1, 3, 'Annotative', 350, '1DB6',
  0, 'ENDSEC',
  0, 'EOF'
]);

describe('MULTILEADER through DXF', () => {
  it('decodes the context data, every leader and line, and the text content', () => {
    const d = readDxf(mleaderFixture(false));
    const m = d.entities.find((e) => e.type === 'mleader');
    expect(m?.type).toBe('mleader');
    if (m?.type !== 'mleader') return;
    expect(m.handle).toBe('1EC8');
    expect(m.scale).toBe(1);
    expect(m.textHeight).toBe(3);
    expect(m.arrowSize).toBe(2.5);
    expect(m.text).toBe('RUPTURE DISK \\PSHEET 2');
    expect(m.textPosition).toEqual({ x: 429.5, y: 142.5, z: 0 });
    expect(m.textRotation).toBe(0.25);
    expect(m.textStyle).toBe('Notes');
    expect(m.styleName).toBe('Annotative');
    expect(m.hasLanding).toBe(true);
    expect(m.hasDogleg).toBe(true);
    expect(m.blockName).toBeUndefined();
    expect(m.leaders.length).toBe(2);
    expect(m.leaders[0].landing).toEqual({ x: 423, y: 140, z: 0 });
    expect(m.leaders[0].doglegVector).toEqual({ x: 1, y: 0, z: 0 });
    expect(m.leaders[0].doglegLength).toBe(5);
    expect(m.leaders[0].lines).toEqual([
      [{ x: 418, y: 87, z: 0 }, { x: 420, y: 100, z: 0 }],
      [{ x: 400, y: 80, z: 0 }]
    ]);
    expect(m.leaders[1].doglegVector).toEqual({ x: -1, y: 0, z: 0 });
    expect(m.leaders[1].lines).toEqual([[{ x: 510, y: 90, z: 0 }]]);
    expect(d.warnings).toEqual([]);
  });

  it('decodes block content through the BLOCK_RECORD table', () => {
    const d = readDxf(mleaderFixture(true));
    const m = d.entities.find((e) => e.type === 'mleader');
    expect(m?.type).toBe('mleader');
    if (m?.type !== 'mleader') return;
    expect(m.text).toBeUndefined();
    expect(m.blockName).toBe('TAG');
    expect(m.blockPosition).toEqual({ x: 155.5, y: 429.5, z: 0 });
    expect(m.blockScale).toEqual({ x: 2, y: 2, z: 2 });
    expect(m.blockRotation).toBe(0.5);
  });

  it('reaches DWG as a MULTILEADER and reads back', () => {
    for (const block of [false, true]) {
      const d = readDxf(mleaderFixture(block));
      const res = writeDwg2018(d);
      expect(res.skipped).toEqual([]);
      const back = readDwg(res.data);
      const m = entitiesOf(back).find((e) => e.type === 'mleader');
      expect(m?.type).toBe('mleader');
      if (m?.type !== 'mleader') return;
      expect(m.leaders.length).toBe(2);
      expect(m.leaders[0].lines.length).toBe(2);
      expect(m.leaders[0].lines[0][1]).toEqual({ x: 420, y: 100, z: 0 });
      expect(m.leaders[0].landing).toEqual({ x: 423, y: 140, z: 0 });
      if (block) {
        expect(m.blockName).toBe('TAG');
        expect(m.blockPosition).toEqual({ x: 155.5, y: 429.5, z: 0 });
      } else {
        expect(m.text).toBe('RUPTURE DISK \\PSHEET 2');
        expect(m.textPosition).toEqual({ x: 429.5, y: 142.5, z: 0 });
      }
      expect(back.warnings).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */

const proxyObjectFixture = (): string => dxf([
  0, 'SECTION', 2, 'CLASSES',
  0, 'CLASS', 1, 'OBJECT_PTR', 2, 'CAseDLPNTableRecord', 3, 'ASE-LPNTableRecord',
  90, 1, 91, 6, 280, 0, 281, 0,
  0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES',
  0, 'TABLE', 2, 'APPID', 5, '9', 100, 'AcDbSymbolTable', 70, 2,
  0, 'APPID', 5, '12', 100, 'AcDbSymbolTableRecord', 100, 'AcDbRegAppTableRecord', 2, 'ACAD', 70, 0,
  0, 'APPID', 5, '13', 100, 'AcDbSymbolTableRecord', 100, 'AcDbRegAppTableRecord', 2, 'DCO15', 70, 0,
  0, 'ENDTAB',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'OBJECTS',
  0, 'DICTIONARY', 5, 'C', 330, 0, 100, 'AcDbDictionary', 281, 1, 3, 'ACAD_DBCONNECT', 350, 'AFAC',
  0, 'DICTIONARY', 5, 'AFAC', 330, 'C', 100, 'AcDbDictionary', 281, 1, 3, 'RoomLink1', 350, 'AFAD',
  /* the reference's 2018 spelling: 71/97 the version words, 162/161 the
     (empty) data sizes, and the whole content as DCO15 xdata */
  0, 'ACAD_PROXY_OBJECT', 5, 'AFAD', 102, '{ACAD_REACTORS', 330, 'AFAC', 102, '}', 330, 'AFAC',
  100, 'AcDbProxyObject', 90, 499, 91, 500, 71, 27, 97, 50, 70, 0, 162, 0, 161, 0, 94, 0,
  1001, 'DCO15', 1000, 'jet_dbsamples...Room(RoomLink1)', 1000, 'ROOM', 1000, '1252',
  1000, 'ASCII', 1070, 12, 1070, 5, 1070, 0, 1070, 0, 1070, 1024,
  0, 'ENDSEC',
  0, 'EOF'
]);

describe('ACAD_PROXY_OBJECT in the 2018 spelling, with its xdata', () => {
  const d = readDxf(proxyObjectFixture());
  const p = d.proxyObjects?.[0];

  it('reads the split version word and carries the xdata', () => {
    expect(d.proxyObjects?.length).toBe(1);
    expect(p?.name).toBe('RoomLink1');
    expect(p?.sourceType).toBe('OBJECT_PTR');
    expect(p?.appClass?.cppName).toBe('CAseDLPNTableRecord');
    expect(p?.proxyVersion).toBe(27);
    expect(p?.proxyMaint).toBe(50);
    expect(p?.fromDxf).toBe(false);
    expect(p?.data).toBeUndefined();
    expect(p?.xdata?.length).toBe(1);
    expect(p?.xdata?.[0].appName).toBe('DCO15');
    expect(p?.xdata?.[0].values.length).toBe(9);
    expect(p?.xdata?.[0].values[0]).toEqual({ code: 1000, value: 'jet_dbsamples...Room(RoomLink1)' });
    expect(p?.xdata?.[0].values[8]).toEqual({ code: 1070, value: 1024 });
  });

  it('survives the DXF writer with its xdata and a registered APPID', () => {
    const text = writeDxf(d);
    expect(text).toContain('\n1001\nDCO15\n');
    const again = readDxf(text);
    expect(again.appIds).toContain('DCO15');
    const q = again.proxyObjects?.[0];
    expect(q?.name).toBe('RoomLink1');
    expect(q?.proxyVersion).toBe(27);
    expect(q?.proxyMaint).toBe(50);
    expect(q?.xdata).toEqual(p?.xdata);
  });

  it('is written to DWG as a plain object of its class carrying the EED, and reads back', () => {
    /* the form the reference's own DWG gives such records: an empty body
       under the class's type number, the object being its EED — the
       reader hands it back as a sealed object of that class */
    const res = writeDwg2018(d);
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.proxyObjects ?? []).toEqual([]);
    const q = back.unknownObjects?.find((u) => u.name === 'RoomLink1');
    expect(q?.sourceType).toBe('OBJECT_PTR');
    expect(q?.appClass?.cppName).toBe('CAseDLPNTableRecord');
    expect(q?.data).toBeUndefined();
    expect(q?.xdata?.length).toBe(1);
    expect(q?.xdata?.[0].appName).toBe('DCO15');
    expect(q?.xdata?.[0].values).toEqual(p?.xdata?.[0].values);
    expect(back.appIds).toContain('DCO15');
    expect(back.warnings).toEqual([]);
    /* and it survives a further DWG generation the same way — the
       sealed object goes out again under its class with its EED */
    const res2 = writeDwg2018(back);
    expect(res2.skipped).toEqual([]);
    const third = readDwg(res2.data);
    const q3 = third.unknownObjects?.find((u) => u.name === 'RoomLink1');
    expect(q3?.sourceType).toBe('OBJECT_PTR');
    expect(q3?.xdata?.[0].values).toEqual(p?.xdata?.[0].values);
  });

  it('the 2018 size groups: 160 opens the graphics, 161/162 the data bits', () => {
    const e = readDxf(dxf([
      0, 'SECTION', 2, 'ENTITIES',
      0, 'ACAD_PROXY_ENTITY', 5, '20', 100, 'AcDbEntity', 8, '0', 100, 'AcDbProxyEntity',
      90, 498, 91, 500, 71, 27, 97, 50, 70, 0,
      160, 4, 310, 'DEADBEEF',
      162, 7, 161, 53, 310, 'DEADBEEF0102E0',
      330, '2A', 94, 0,
      0, 'ENDSEC', 0, 'EOF'
    ])).entities[0];
    expect(e?.type).toBe('proxy');
    if (e?.type !== 'proxy') return;
    expect(e.proxyVersion).toBe(27);
    expect(e.proxyMaint).toBe(50);
    expect(Buffer.from(e.graphicsData!, 'base64')).toEqual(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
    expect(Buffer.from(e.data!, 'base64').length).toBe(7);
    expect(e.dataBits).toBe(53);
    expect(e.refs).toEqual([{ code: 4, value: '2A' }]);
  });
});

/* ------------------------------------------------------------------ */

describe('objects with nothing to write are reported, not dropped in silence', () => {
  it('a data-less sealed object lands in skipped by name', () => {
    const d = readDxf(dxf([
      0, 'SECTION', 2, 'OBJECTS',
      0, 'DICTIONARY', 5, 'C', 330, 0, 100, 'AcDbDictionary', 281, 1, 3, 'ACME', 350, 'D1',
      0, 'ACME_STORE', 5, 'D1', 330, 'C', 100, 'AcDbAcmeStore', 70, 1,
      0, 'ENDSEC', 0, 'EOF'
    ]));
    expect(d.unknownObjects?.[0]?.sourceType).toBe('ACME_STORE');
    const res = writeDwg2018(d);
    expect(res.skipped).toEqual(['ACME_STORE (no retained record bits)']);
  });
});
