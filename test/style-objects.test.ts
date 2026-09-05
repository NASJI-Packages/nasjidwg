/* nasjidwg — TABLESTYLE and MLEADERSTYLE as model objects.
 *
 * A drawing's table styles and multileader styles travel as
 * `drawing.tableStyles` / `drawing.mleaderStyles`, each table and
 * multileader naming its own through `styleName`. Both DWG generations
 * of the record (the pre-2010 row-style form and the R2010+ cell-style
 * map) and the reference's DXF spelling round-trip the values the
 * reference's own styles carry: margins, text styles and heights,
 * alignment, colours, fill, the six borders, the value format, and the
 * multileader's leader, landing, dogleg, arrowhead, text and block
 * settings. A drawing that names no style still gets a Standard. */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018 } from '../src/dwg/writer.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import { nearestAci } from '../src/core/color.js';
import type { Drawing, Entity, MLeaderStyle, TableStyle } from '../src/core/model.js';

const byLayer = { kind: 'byLayer' } as const;

const legend: TableStyle = {
  name: 'Drawing Legend',
  description: 'Legend',
  flowDirection: 1,
  flags: 1,
  horizontalMargin: 1.5,
  verticalMargin: 0.75,
  titleSuppressed: true,
  headerSuppressed: false,
  data: {
    textStyle: 'Notes', textHeight: 3, alignment: 4,
    textColor: byLayer, fillColor: { kind: 'aci', index: 254 }, fillOn: true,
    dataType: 4, unitType: 0, format: '%tc1',
    borders: [
      { lineweight: 50, visible: true, color: { kind: 'aci', index: 1 } },
      { lineweight: -2, visible: false, color: { kind: 'byBlock' } },
      { lineweight: 25, visible: true, color: { kind: 'rgb', rgb: 0x336699 } },
      { lineweight: -1, visible: true, color: byLayer },
      { lineweight: -2, visible: false, color: { kind: 'byBlock' } },
      { lineweight: 0, visible: true, color: { kind: 'aci', index: 5 } }
    ]
  },
  title: {
    textStyle: 'Notes', textHeight: 5, alignment: 5,
    textColor: { kind: 'aci', index: 2 }, fillColor: { kind: 'aci', index: 7 }, fillOn: false,
    borders: Array.from({ length: 6 }, () => ({ lineweight: -2, visible: true, color: { kind: 'byBlock' as const } }))
  },
  header: {
    textStyle: 'Standard', textHeight: 4, alignment: 5,
    textColor: { kind: 'byBlock' }, fillColor: { kind: 'aci', index: 7 }, fillOn: false,
    borders: Array.from({ length: 6 }, () => ({ lineweight: -2, visible: true, color: { kind: 'byBlock' as const } }))
  }
};

const metric: MLeaderStyle = {
  name: 'Metric',
  description: 'Metric notes',
  contentType: 2,
  drawMLeaderOrder: 1, drawLeaderOrder: 0,
  maxLeaderPoints: 3,
  firstSegmentAngle: 0.5, secondSegmentAngle: 0,
  leaderType: 2,
  lineColor: { kind: 'aci', index: 3 }, linetype: 'DASHED', lineweight: 35,
  landing: true, landingGap: 1.5,
  dogleg: true, doglegLength: 5,
  arrowBlock: 'ARROW', arrowSize: 2.5,
  defaultText: 'NOTE',
  textStyle: 'Notes',
  textLeftAttachment: 1, textRightAttachment: 1, textAngleType: 1, textAlignment: 0,
  textColor: { kind: 'rgb', rgb: 0x112233 }, textHeight: 3,
  textFrame: true, alwaysAlignLeft: false, alignSpace: 4,
  blockName: 'TAG', blockColor: { kind: 'byBlock' },
  blockScale: { x: 2, y: 2, z: 1 }, useBlockScale: true,
  blockRotation: 0.25, useBlockRotation: true, blockConnection: 1,
  scale: 1, propertyChanged: false, annotative: false, breakSize: 0.125,
  attachmentDirection: 0, topAttachment: 9, bottomAttachment: 9
};

const build = (): Drawing => {
  const d = emptyDrawing();
  d.textStyles.push({ name: 'Notes', font: 'arial.ttf' });
  d.linetypes.push({ name: 'DASHED', description: 'dash', pattern: [12.7, -6.35] });
  for (const nm of ['ARROW', 'TAG']) {
    d.blocks[nm] = {
      name: nm, basePoint: { x: 0, y: 0, z: 0 },
      entities: [{ type: 'circle', layer: '0', color: byLayer, center: { x: 0, y: 0, z: 0 }, radius: 1 }]
    };
  }
  d.tableStyles = [legend];
  d.mleaderStyles = [metric];
  d.entities = [
    {
      type: 'table', layer: '0', color: byLayer, position: { x: 30, y: 30, z: 0 },
      numRows: 2, numColumns: 2, rowHeights: [1, 1], columnWidths: [3, 3],
      cells: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }],
      styleName: 'Drawing Legend'
    },
    {
      type: 'mleader', layer: '0', color: byLayer,
      leaders: [{
        landing: { x: 5, y: 5, z: 0 }, doglegVector: { x: 1, y: 0, z: 0 }, doglegLength: 1,
        lines: [[{ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }]]
      }],
      text: 'NOTE', textPosition: { x: 6, y: 5, z: 0 }, textHeight: 0.2,
      styleName: 'Metric'
    },
    {
      type: 'mleader', layer: '0', color: byLayer,
      leaders: [{ lines: [[{ x: 0, y: 10, z: 0 }, { x: 5, y: 15, z: 0 }]] }],
      text: 'PLAIN', textPosition: { x: 6, y: 15, z: 0 }, textHeight: 0.2
    }
  ];
  return d;
};

const entitiesOf = (d: Drawing): Entity[] => [
  ...d.entities, ...(d.paperSpace ?? []),
  ...Object.values(d.blocks).flatMap((b) => b.entities)
];

const near = (a: number | undefined, b: number): void => {
  expect(a).toBeDefined();
  expect(a!).toBeCloseTo(b, 9);
};

/** What every codec must bring back of the two styles and their use. */
const checkStyles = (
  d: Drawing,
  opts: { r2010?: boolean; dxf?: boolean; pre2007?: boolean; aciOnly?: boolean } = {}
): void => {
  const names = (d.tableStyles ?? []).map((s) => s.name).sort();
  expect(names).toEqual(['Drawing Legend', 'Standard']);
  const t = d.tableStyles!.find((s) => s.name === 'Drawing Legend')!;
  expect(t.description).toBe('Legend');
  expect(t.flowDirection).toBe(1);
  near(t.horizontalMargin, 1.5);
  near(t.verticalMargin, 0.75);
  if (!opts.r2010) {
    expect(t.flags).toBe(1);
    expect(t.titleSuppressed).toBe(true);
    expect(t.headerSuppressed).toBe(false);
  }
  expect(t.data?.textStyle).toBe('Notes');
  near(t.data?.textHeight, 3);
  expect(t.data?.alignment).toBe(4);
  expect(t.data?.textColor).toEqual(byLayer);
  expect(t.data?.fillOn).toBe(true);
  expect(t.data?.fillColor).toEqual({ kind: 'aci', index: 254 });
  /* the value type and format are R2007+ fields; the R2000 DXF spelling
     has no group for them either */
  if (!opts.dxf && !opts.pre2007) {
    expect(t.data?.dataType).toBe(4);
    expect(t.data?.format).toBe('%tc1');
  }
  const b = t.data!.borders!;
  expect(b.map((x) => x.visible)).toEqual([true, false, true, true, false, true]);
  expect(b.map((x) => x.lineweight)).toEqual([50, -2, 25, -1, -2, 0]);
  expect(b[0].color).toEqual({ kind: 'aci', index: 1 });
  /* the DXF spelling has an index group only: a true colour lands on
     its nearest ACI there */
  expect(b[2].color).toEqual(opts.dxf
    ? { kind: 'aci', index: nearestAci(0x336699) } : { kind: 'rgb', rgb: 0x336699 });
  near(t.title?.textHeight, 5);
  expect(t.title?.textColor).toEqual({ kind: 'aci', index: 2 });
  expect(t.title?.fillOn).toBe(false);
  near(t.header?.textHeight, 4);
  expect(t.header?.textStyle).toBe('Standard');

  const mnames = (d.mleaderStyles ?? []).map((s) => s.name).sort();
  expect(mnames).toEqual(['Metric', 'Standard']);
  const m = d.mleaderStyles!.find((s) => s.name === 'Metric')!;
  expect(m.description).toBe('Metric notes');
  expect(m.contentType).toBe(2);
  expect(m.maxLeaderPoints).toBe(3);
  near(m.firstSegmentAngle, 0.5);
  expect(m.leaderType).toBe(2);
  expect(m.lineColor).toEqual({ kind: 'aci', index: 3 });
  expect(m.linetype).toBe('DASHED');
  expect(m.lineweight).toBe(35);
  expect(m.landing).toBe(true);
  near(m.landingGap, 1.5);
  expect(m.dogleg).toBe(true);
  near(m.doglegLength, 5);
  expect(m.arrowBlock).toBe('ARROW');
  near(m.arrowSize, 2.5);
  expect(m.defaultText).toBe('NOTE');
  expect(m.textStyle).toBe('Notes');
  /* an R2000 MLEADERSTYLE colour is a bare index: a true colour lands on
     its nearest ACI there (the TABLESTYLE keeps the full form in every
     release) */
  expect(m.textColor).toEqual(opts.aciOnly
    ? { kind: 'aci', index: nearestAci(0x112233) } : { kind: 'rgb', rgb: 0x112233 });
  near(m.textHeight, 3);
  expect(m.textFrame).toBe(true);
  near(m.alignSpace, 4);
  expect(m.blockName).toBe('TAG');
  expect(m.blockScale).toEqual({ x: 2, y: 2, z: 1 });
  near(m.blockRotation, 0.25);
  expect(m.blockConnection).toBe(1);
  near(m.breakSize, 0.125);
  if (opts.r2010) {
    expect(m.topAttachment).toBe(9);
    expect(m.bottomAttachment).toBe(9);
  }

  const table = entitiesOf(d).find((e) => e.type === 'table');
  expect(table?.type === 'table' && table.styleName).toBe('Drawing Legend');
  const mleaders = entitiesOf(d).filter((e) => e.type === 'mleader');
  expect(mleaders.map((e) => e.type === 'mleader' ? e.styleName : '').sort())
    .toEqual(['Metric', 'Standard']);
};

describe('table and multileader styles', () => {
  it('round-trip through R2018 (the cell-style map), handles preserved or not', () => {
    for (const preserveHandles of [false, true]) {
      const out = writeDwg2018(build(), { preserveHandles });
      const back = readDwg(out.data);
      expect(back.warnings).toEqual([]);
      checkStyles(back, { r2010: true });
      /* the record is decoded, not sealed */
      expect((back.unknownObjects ?? []).some((u) => /STYLE$/.test(u.sourceType))).toBe(false);
    }
  });

  it('round-trip through R2000, R2004 and R2007 (the row-style record)', () => {
    for (const [write, pre2007, aciOnly] of [
      [writeDwg2000, true, true], [writeDwg2004, true, false], [writeDwg2007, false, false]
    ] as const) {
      const back = readDwg(write(build()).data);
      expect(back.warnings).toEqual([]);
      checkStyles(back, { pre2007, aciOnly });
    }
  });

  it('keep their source handles under preserveHandles', () => {
    const d = build();
    d.tableStyles![0].handle = 'ABC1';
    d.mleaderStyles![0].handle = 'ABC2';
    const back = readDwg(writeDwg2018(d, { preserveHandles: true }).data);
    expect(back.tableStyles!.find((s) => s.name === 'Drawing Legend')!.handle).toBe('ABC1');
    expect(back.mleaderStyles!.find((s) => s.name === 'Metric')!.handle).toBe('ABC2');
    const again = readDwg(writeDwg2018(back, { preserveHandles: true }).data);
    expect(again.tableStyles!.find((s) => s.name === 'Drawing Legend')!.handle).toBe('ABC1');
  });

  it('round-trip through DXF in the reference\'s R2000 spelling', () => {
    const dxf = writeDxf(build());
    expect(dxf).toMatch(/\n0\r?\nTABLESTYLE\r?\n/);
    expect(dxf).toMatch(/\n0\r?\nMLEADERSTYLE\r?\n/);
    /* every style listed under its dictionary */
    expect(dxf).toMatch(/ACAD_TABLESTYLE/);
    expect(dxf).toMatch(/\n3\r?\nDrawing Legend\r?\n/);
    expect(dxf).toMatch(/\n3\r?\nMetric\r?\n/);
    const back = readDxf(dxf);
    expect(back.warnings).toEqual([]);
    checkStyles(back, { dxf: true });
  });

  it('are synthesized as Standard for a drawing that names none', () => {
    const d = build();
    delete d.tableStyles;
    delete d.mleaderStyles;
    for (const e of d.entities) if (e.type === 'table' || e.type === 'mleader') delete e.styleName;
    const back = readDwg(writeDwg2018(d).data);
    expect((back.tableStyles ?? []).map((s) => s.name)).toEqual(['Standard']);
    expect((back.mleaderStyles ?? []).map((s) => s.name)).toEqual(['Standard']);
    near(back.mleaderStyles![0].landingGap, 0.09);
    near(back.tableStyles![0].title?.textHeight, 0.25);
    for (const e of entitiesOf(back)) {
      if (e.type === 'table' || e.type === 'mleader') expect(e.styleName).toBe('Standard');
    }
    const viaDxf = readDxf(writeDxf(d));
    expect((viaDxf.tableStyles ?? []).map((s) => s.name)).toEqual(['Standard']);
    expect((viaDxf.mleaderStyles ?? []).map((s) => s.name)).toEqual(['Standard']);
  });

  it('travel without any table or multileader in the drawing', () => {
    const d = build();
    d.entities = [];
    const back = readDwg(writeDwg2018(d).data);
    expect(back.tableStyles!.map((s) => s.name).sort()).toEqual(['Drawing Legend', 'Standard']);
    expect(back.mleaderStyles!.map((s) => s.name).sort()).toEqual(['Metric', 'Standard']);
    const viaDxf = readDxf(writeDxf(d));
    expect(viaDxf.tableStyles!.map((s) => s.name).sort()).toEqual(['Drawing Legend', 'Standard']);
  });
});
