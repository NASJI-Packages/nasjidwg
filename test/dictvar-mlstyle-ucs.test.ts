/* nasjidwg — four named-object families the DWG writers used to leave
 * behind, each pinned on the reference's own saves:
 *   - the variable dictionary (AcDbVariableDictionary → DICTIONARYVAR):
 *     read into `drawing.variables`, written natively from R2000 on,
 *     the header slots a release lacks joining it the way the
 *     reference's 2000 and 2004 saves spell them;
 *   - multiline styles beyond STANDARD: every `drawing.mlineStyles`
 *     record written (elements, colours, linetypes — a table index
 *     through R2013, a handle from R2018), MLINE.styleName and the
 *     header's CMLSTYLE pointing at them;
 *   - the UCS table: `drawing.ucs` written in every release with the
 *     R2000+ elevation / orthographic fields, the header's UCSNAME and
 *     PUCSNAME naming a record;
 *   - the MTEXT round-trip records: the 2008 paragraph codes an older
 *     release cannot show are flattened, the original kept under the
 *     entity's extension dictionary as ACAD_MTEXT_2008_RT (and the 2004
 *     spelling as ACAD_MTEXT_RT for 2000/R14), each with the reference's
 *     checksum of the text it restores over.
 */
import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018, writeDwgR14
} from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, MLineStyle, Ucs } from '../src/core/model.js';

const WRITERS = [
  ['R2018', writeDwg2018, 2018],
  ['R2007', writeDwg2007, 2007],
  ['R2004', writeDwg2004, 2004],
  ['R2000', writeDwg2000, 2000]
] as const;

const sumPos1 = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) * (i + 1);
  return n;
};

const mline = (style: string, y: number, lines: number): Entity => ({
  type: 'mline', layer: '0', color: { kind: 'byLayer' }, styleName: style,
  scale: 1, justification: 0, basePoint: { x: 0, y, z: 0 },
  vertices: [0, 50].map((x) => ({
    position: { x, y, z: 0 }, direction: { x: 1, y: 0, z: 0 },
    miterDirection: { x: 0, y: 1, z: 0 },
    lines: Array.from({ length: lines }, () => ({ segparms: [0] }))
  }))
});

const wall: MLineStyle = {
  name: 'WALL', description: 'two skins and a core', flags: 0x410,
  fillColor: { kind: 'aci', index: 8 },
  startAngle: Math.PI / 2, endAngle: Math.PI / 2,
  elements: [
    { offset: 1, color: { kind: 'aci', index: 1 }, linetype: 'DASHED' },
    { offset: 0, color: { kind: 'rgb', rgb: 0x2040c0 }, linetype: 'HIDDEN' },
    { offset: -1, color: { kind: 'aci', index: 3 }, linetype: 'ByBlock' },
    { offset: -1.5, color: { kind: 'byLayer' } }
  ]
};

const ucsList: Ucs[] = [
  {
    name: 'FRONT', origin: { x: 1, y: 2, z: 3 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 0, z: 1 }
  },
  {
    name: 'TILT', origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },
    yAxis: { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },
    elevation: 2.5, orthoViewType: 1, baseUcs: 'FRONT',
    orthoOrigins: [{ type: 1, origin: { x: 5, y: 6, z: 7 } }]
  }
];

const base = (): Drawing => {
  const d = emptyDrawing();
  d.linetypes.push({ name: 'DASHED', description: 'Dashed', pattern: [0.5, -0.25] });
  d.linetypes.push({ name: 'HIDDEN', description: 'Hidden', pattern: [0.25, -0.125] });
  d.mlineStyles = [wall];
  d.entities.push(mline('WALL', 0, 4), mline('STANDARD', 10, 2), mline('NoSuchStyle', 20, 2));
  d.ucs = ucsList;
  d.header.vars = { UCSNAME: 'TILT', PUCSNAME: 'FRONT', CMLSTYLE: 'WALL', DIMASSOC: 1, XCLIPFRAME: 0, INDEXCTL: 0, SOLIDHIST: 1 };
  d.variables = [
    { name: 'CTABLESTYLE', value: 'Standard' }, { name: 'CANNOSCALE', value: '1:1' },
    { name: 'LIGHTINGUNITS', value: '2' }, { name: 'PSOLHEIGHT', value: '80' }
  ];
  return d;
};

describe.each(WRITERS)('the variable dictionary (%s)', (_v, write, release) => {
  it('writes every variable natively and reads it back by name', () => {
    const res = write(base());
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    const vars = Object.fromEntries((back.variables ?? []).map((x) => [x.name, x.value]));
    expect(vars.CTABLESTYLE).toBe('Standard');
    expect(vars.CANNOSCALE).toBe('1:1');
    expect(vars.LIGHTINGUNITS).toBe('2');
    expect(vars.PSOLHEIGHT).toBe('80');
    /* a header slot the release lacks joins the dictionary as the
       reference's own saves spell it: DIMASSOC, INDEXCTL and XCLIPFRAME
       before 2004, SOLIDHIST before 2007 */
    if (release < 2004) {
      expect(vars.DIMASSOC).toBe('1');
      expect(vars.INDEXCTL).toBe('0');
      expect(vars.XCLIPFRAME).toBe('0');
    } else {
      expect(vars.DIMASSOC).toBeUndefined();
      expect(back.header.vars?.DIMASSOC).toBe(1);
    }
    expect(vars.SOLIDHIST).toBe(release < 2007 ? '1' : undefined);
    /* nothing of it is sealed: the dictionary and its records are the
       model's own */
    expect((back.unknownObjects ?? []).filter((u) => /DICTIONARYVAR/i.test(u.sourceType))).toEqual([]);
    expect(back.structureHandles?.ACDBVARIABLEDICTIONARY).toBeDefined();
  });

  it('a 2000-era DIMASSOC kept in the dictionary feeds the header slot of a later release', () => {
    const d = emptyDrawing();
    d.variables = [{ name: 'DIMASSOC', value: '0' }];
    const back = readDwg(write(d).data);
    if (release >= 2004) expect(back.header.vars?.DIMASSOC).toBe(0);
    expect(back.variables?.find((x) => x.name === 'DIMASSOC')?.value).toBe('0');
  });

  it('keeps the source handles under preserveHandles', () => {
    const d = base();
    d.variables = [{ name: 'CANNOSCALE', value: '1:2', handle: '3E8' }];
    d.structureHandles = { ACDBVARIABLEDICTIONARY: '3E7' };
    const back = readDwg(write(d, { preserveHandles: true }).data);
    expect(back.variables?.find((x) => x.name === 'CANNOSCALE')?.handle).toBe('3E8');
    expect(back.structureHandles?.ACDBVARIABLEDICTIONARY).toBe('3E7');
  });
});

it('R14 has no variable dictionary: reported, not written', () => {
  const res = writeDwgR14(base());
  expect(res.skipped.some((s) => /drawing variables/.test(s))).toBe(true);
  expect(readDwg(res.data).variables).toBeUndefined();
});

describe.each([...WRITERS, ['R14', writeDwgR14, 14] as const])('multiline styles (%s)', (_v, write, release) => {
  it('writes the drawing\'s styles beside STANDARD, and MLINE + CMLSTYLE point at them', () => {
    const res = write(base());
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    const names = (back.mlineStyles ?? []).map((s) => s.name).sort();
    expect(names).toEqual(['STANDARD', 'WALL']);
    const w = back.mlineStyles!.find((s) => s.name === 'WALL')!;
    expect(w.description).toBe('two skins and a core');
    expect(w.flags).toBe(0x410);
    expect(w.fillColor).toEqual({ kind: 'aci', index: 8 });
    expect(w.startAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(w.elements.map((e) => e.offset)).toEqual([1, 0, -1, -1.5]);
    expect(w.elements[0].color).toEqual({ kind: 'aci', index: 1 });
    /* a true colour needs the 2004 CMC; before that the nearest ACI */
    if (release >= 2004) expect(w.elements[1].color).toEqual({ kind: 'rgb', rgb: 0x2040c0 });
    else expect(w.elements[1].color.kind).toBe('aci');
    expect(w.elements[3].color).toEqual({ kind: 'byLayer' });
    /* the linetype: a handle from R2018, the table index before (the
       reference's own re-saves carry 1 and 2 for DASHED and HIDDEN) */
    expect(w.elements.map((e) => e.linetype ?? 'ByLayer'))
      .toEqual(['DASHED', 'HIDDEN', 'ByBlock', 'ByLayer']);
    const styles = back.entities.filter((e) => e.type === 'mline').map((e) => e.type === 'mline' ? e.styleName : '');
    /* an unknown style name falls back to STANDARD */
    expect(styles).toEqual(['WALL', 'STANDARD', 'STANDARD']);
    expect(back.header.vars?.CMLSTYLE).toBe('WALL');
  });

  it('a drawing without styles still gets STANDARD, and CMLSTYLE is it', () => {
    const d = emptyDrawing();
    d.entities.push(mline('STANDARD', 0, 2));
    const back = readDwg(write(d).data);
    expect(back.mlineStyles?.map((s) => s.name)).toEqual(['STANDARD']);
    expect(back.mlineStyles![0].elements.map((e) => e.offset)).toEqual([0.5, -0.5]);
    expect(back.header.vars?.CMLSTYLE).toBe('STANDARD');
  });

  it('a source "Standard" replaces the synthesized one and keeps its handle', () => {
    const d = emptyDrawing();
    d.mlineStyles = [{
      name: 'Standard', description: 'mine', handle: '2B0',
      elements: [{ offset: 0.25, color: { kind: 'byLayer' } }, { offset: -0.25, color: { kind: 'byLayer' } }]
    }];
    const back = readDwg(write(d, { preserveHandles: true }).data);
    expect(back.mlineStyles?.length).toBe(1);
    expect(back.mlineStyles![0].description).toBe('mine');
    expect(back.mlineStyles![0].elements.map((e) => e.offset)).toEqual([0.25, -0.25]);
    expect(back.mlineStyles![0].handle).toBe('2B0');
  });
});

describe.each([...WRITERS, ['R14', writeDwgR14, 14] as const])('the UCS table (%s)', (_v, write, release) => {
  it('writes every named UCS and the header pointers that name one', () => {
    const res = write(base());
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    expect(back.ucs?.map((u) => u.name)).toEqual(['FRONT', 'TILT']);
    const tilt = back.ucs!.find((u) => u.name === 'TILT')!;
    expect(tilt.origin).toEqual({ x: 0, y: 0, z: 0 });
    expect(tilt.xAxis.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(tilt.yAxis.x).toBeCloseTo(-Math.SQRT1_2, 12);
    if (release >= 2000) {
      expect(tilt.elevation).toBe(2.5);
      expect(tilt.orthoViewType).toBe(1);
      expect(tilt.baseUcs).toBe('FRONT');
      expect(tilt.orthoOrigins).toEqual([{ type: 1, origin: { x: 5, y: 6, z: 7 } }]);
      const front = back.ucs!.find((u) => u.name === 'FRONT')!;
      expect(front.elevation).toBe(0);
      expect(front.baseUcs).toBeUndefined();
    } else {
      expect(tilt.elevation).toBeUndefined();
    }
    expect(back.header.vars?.UCSNAME).toBe('TILT');
    expect(back.header.vars?.PUCSNAME).toBe('FRONT');
  });

  it('keeps the record handles under preserveHandles', () => {
    const d = base();
    d.ucs = [{ ...ucsList[0], handle: '4D2' }];
    delete d.header.vars!.UCSNAME; delete d.header.vars!.PUCSNAME;
    const back = readDwg(write(d, { preserveHandles: true }).data);
    expect(back.ucs?.[0].handle).toBe('4D2');
    expect(back.header.vars?.UCSNAME).toBeUndefined();
  });
});

describe('MTEXT round-trip records', () => {
  const T2008 = '\\pxqc;Centred heading\\P\\pxi-3,l3,t3;1.\tIndented item\\P\\pxql;plain again';
  const T2004 = 'Centred heading\\P\\pi-7.5,l7.5,t7.5;1.\tIndented item\\Pplain again';
  const T2000 = 'Centred heading\\P1.\tIndented item\\Pplain again';
  const drawing = (text: string): Drawing => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'mtext', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, height: 2.5, rotation: 0, width: 80, text
    });
    return d;
  };
  /** The MTEXT, its extension dictionary and the records it lists. */
  const chain = (d: Drawing) => {
    const e = d.entities[0];
    const text = e.type === 'mtext' ? (e.raw ?? e.text) : '';
    const dict = (d.unknownObjects ?? []).find((u) => u.handle === e.xdict);
    const rec = (name: string) => {
      const en = dict?.entries?.find((x) => x.name === name);
      return en ? d.xrecords?.find((x) => x.handle === en.handle)?.values : undefined;
    };
    return { text, dict, rt2008: rec('ACAD_MTEXT_2008_RT'), rt2004: rec('ACAD_MTEXT_RT') };
  };

  it.each([
    ['R2007', writeDwg2007], ['R2004', writeDwg2004]
  ] as const)('%s: the 2004 spelling, the original under ACAD_MTEXT_2008_RT with the checksum of the written text', (_v, write) => {
    const back = readDwg(write(drawing(T2008)).data);
    const c = chain(back);
    expect(c.text).toBe(T2004);
    expect(c.dict?.ownerHandle).toBe(back.entities[0].handle);
    expect(c.dict?.entries?.map((x) => x.name)).toEqual(['ACAD_MTEXT_2008_RT']);
    expect(c.rt2008).toEqual([{ code: 40, value: sumPos1(T2004) }, { code: 1, value: T2008 }]);
    expect(c.rt2004).toBeUndefined();
  });

  it.each([
    ['R2000', writeDwg2000], ['R14', writeDwgR14]
  ] as const)('%s: no codes at all, ACAD_MTEXT_RT restores the 2004 spelling and ACAD_MTEXT_2008_RT the original', (_v, write) => {
    const back = readDwg(write(drawing(T2008)).data);
    const c = chain(back);
    expect(c.text).toBe(T2000);
    expect(c.dict?.entries?.map((x) => x.name)).toEqual(['ACAD_MTEXT_2008_RT', 'ACAD_MTEXT_RT']);
    expect(c.rt2008).toEqual([{ code: 40, value: sumPos1(T2004) }, { code: 1, value: T2008 }]);
    expect(c.rt2004).toEqual([{ code: 40, value: sumPos1(T2000) }, { code: 1, value: T2004 }]);
    /* and the entity is listed for recomposition: without the listing
       the reference restores the 2004 spelling and stops there */
    const recompose = back.xrecords?.find((x) => x.name === 'ACDB_RECOMPOSE_DATA');
    expect(recompose?.values).toEqual([
      { code: 90, value: 1 }, { code: 330, value: back.entities[0].handle }
    ]);
  });

  it('a text an older release can show needs no record', () => {
    const back = readDwg(writeDwg2004(drawing('plain\\Ptext')).data);
    expect(back.entities[0].xdict).toBeUndefined();
    expect(back.unknownObjects ?? []).toEqual([]);
    const only2004 = readDwg(writeDwg2004(drawing(T2004)).data);
    expect(only2004.entities[0].xdict).toBeUndefined();
    /* the 2004 spelling itself is what 2000 cannot show: one record */
    const c = chain(readDwg(writeDwg2000(drawing(T2004)).data));
    expect(c.text).toBe(T2000);
    expect(c.dict?.entries?.map((x) => x.name)).toEqual(['ACAD_MTEXT_RT']);
    expect(c.rt2004).toEqual([{ code: 40, value: sumPos1(T2000) }, { code: 1, value: T2004 }]);
  });

  it('R2018 carries the 2008 spelling itself and keeps no record', () => {
    const back = readDwg(writeDwg2018(drawing(T2008)).data);
    expect(chain(back).text).toBe(T2008);
    expect(back.entities[0].xdict).toBeUndefined();
  });

  it('a long original travels in 250-character pieces', () => {
    const long = '\\pxqc;' + 'word '.repeat(120);
    const c = chain(readDwg(writeDwg2004(drawing(long)).data));
    const pieces = (c.rt2008 ?? []).filter((v) => v.code === 1);
    expect(pieces.length).toBe(Math.ceil(long.length / 250));
    expect(pieces.every((v) => 'value' in v && String(v.value).length <= 250)).toBe(true);
    expect(pieces.map((v) => ('value' in v ? v.value : '')).join('')).toBe(long);
  });

  it('a source chain read from the file is carried, not duplicated (preserveHandles)', () => {
    /* an R2004-era entity: the 2004 spelling with the reference's own
       record beside it, as the reader returns it */
    const src = readDwg(writeDwg2004(drawing(T2008)).data);
    const again = readDwg(writeDwg2004(src, { preserveHandles: true }).data);
    const c = chain(again);
    expect(c.text).toBe(T2004);
    expect(c.dict?.entries?.map((x) => x.name)).toEqual(['ACAD_MTEXT_2008_RT']);
    expect(c.rt2008?.[1]).toEqual({ code: 1, value: T2008 });
    /* into 2000: the source's record stays, ACAD_MTEXT_RT joins it */
    const down = chain(readDwg(writeDwg2000(src, { preserveHandles: true }).data));
    expect(down.text).toBe(T2000);
    expect(down.dict?.entries?.map((x) => x.name).sort()).toEqual(['ACAD_MTEXT_2008_RT', 'ACAD_MTEXT_RT']);
    expect(down.rt2004).toEqual([{ code: 40, value: sumPos1(T2000) }, { code: 1, value: T2004 }]);
    expect(down.rt2008).toEqual([{ code: 40, value: sumPos1(T2004) }, { code: 1, value: T2008 }]);
    /* renumbered, the record is rebuilt from the source's values */
    const renum = chain(readDwg(writeDwg2000(src).data));
    expect(renum.rt2008).toEqual([{ code: 40, value: sumPos1(T2004) }, { code: 1, value: T2008 }]);
  });
});
