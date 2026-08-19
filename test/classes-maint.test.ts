/* readClasses: R2004+ class records carry a five-bitlong tail (instance
 * count, dwg version, maintenance version, two unknowns). For values
 * under 256 a BL and the historically-misread BS encode identically, so
 * only a large maintenance version exposes the difference — real AutoCAD
 * 2027 files register MLEADERSTYLE with maint = 427, and the old BS read
 * misaligned every class record after it. */
import { describe, expect, it } from 'vitest';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { readClasses } from '../src/dwg/classes.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2007, writeDwg2018 } from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';

/** Build a 2004-layout CLASSES section (no sentinel) with the given
 *  records; each record's five-long tail takes explicit values so the
 *  encoding can exceed the 8-bit short forms. */
const buildSection = (records: {
  num: number; dxf: string; cpp: string; app: string; entity: boolean;
  instances: number; dwgVer: number; maintVer: number;
}[]): Uint8Array => {
  const w = new BitWriter();
  w.bs(Math.max(...records.map((r) => r.num)));   /* max class number */
  w.rc(0); w.rc(0); w.b(1);
  for (const r of records) {
    w.bs(r.num); w.bs(127);               /* number, proxy flags */
    w.t(r.app); w.t(r.cpp); w.t(r.dxf);
    w.b(0);                               /* was-a-proxy */
    w.bs(r.entity ? 0x1f2 : 0x1f3);       /* item class */
    w.bl(r.instances);
    w.bl(r.dwgVer); w.bl(r.maintVer);     /* the pair that held the bug */
    w.bl(0); w.bl(0);
  }
  w.align();
  const body = w.bytes();
  const out = new Uint8Array(4 + body.length + 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length + 2, true); /* RL size incl. CRC */
  out.set(body, 4);
  return out;
};

describe('readClasses R2004+ five-bitlong record tail', () => {
  it('survives a maintenance version above 255 (BL, not BS)', () => {
    const section = buildSection([
      { num: 500, dxf: 'MLEADERSTYLE', cpp: 'AcDbMLeaderStyle',
        app: 'ACDB_MLEADERSTYLE_CLASS', entity: false,
        instances: 1, dwgVer: 33, maintVer: 427 },
      { num: 501, dxf: 'SCALE', cpp: 'AcDbScale',
        app: 'ObjectDBX Classes', entity: false,
        instances: 33, dwgVer: 33, maintVer: 6 }
    ]);
    const classes = readClasses(section, 'R2004');
    /* the record AFTER the big-maint one is the alignment witness */
    expect(classes.get(500)?.dxfName).toBe('MLEADERSTYLE');
    expect(classes.get(501)?.dxfName).toBe('SCALE');
    expect(classes.get(501)?.cppName).toBe('AcDbScale');
    expect(classes.get(501)?.isEntity).toBe(false);
  });

  it('still reads small-valued tails (BS and BL agree bit-for-bit)', () => {
    const section = buildSection([
      { num: 500, dxf: 'IMAGE', cpp: 'AcDbRasterImage', app: 'ISM',
        entity: true, instances: 2, dwgVer: 0x19, maintVer: 0 },
      { num: 501, dxf: 'IMAGEDEF', cpp: 'AcDbRasterImageDef', app: 'ISM',
        entity: false, instances: 1, dwgVer: 0x19, maintVer: 0 }
    ]);
    const classes = readClasses(section, 'R2004');
    expect(classes.get(500)?.dxfName).toBe('IMAGE');
    expect(classes.get(500)?.isEntity).toBe(true);
    expect(classes.get(501)?.dxfName).toBe('IMAGEDEF');
  });
});

/* The R2007+ CLASSES section keeps its names in a string stream whose
 * size field is one RS through 0x7FFF bits and TWO words past that (high
 * word first, low word carrying the 0x8000 continuation flag). The writer
 * used to emit the single-word form always, silently truncating the size
 * — a drawing carrying a few hundred application classes (a real 72 MB
 * field file registers 245) wrote a CLASSES section that read back as
 * ZERO classes, and every class-typed record with it. */
describe('CLASSES string stream past 0x8000 bits', () => {
  const proxyHeavy = () => {
    const d = emptyDrawing();
    d.unknownObjects = Array.from({ length: 90 }, (_, i) => {
      const name = `NASJI_TEST_CLASS_${String(i).padStart(3, '0')}_` + 'X'.repeat(30);
      return {
        sourceType: name,
        appClass: {
          dxfName: name, cppName: 'AcDb' + name,
          appName: 'NasjiTestApp |Product Desc: string stream witness'
        },
        encoding: 2018, data: 'qg==', dataBits: 8      /* one 0xAA byte */
      };
    });
    return d;
  };

  it.each([['R2007', writeDwg2007], ['R2018', writeDwg2018]] as const)(
    '%s: 90 sealed classes survive the round trip', (_v, writer) => {
      const enc = _v === 'R2007' ? 2007 : 2018;
      const d = proxyHeavy();
      for (const u of d.unknownObjects!) u.encoding = enc;
      const back = readDwg(writer(d).data);
      const names = (back.unknownObjects ?? []).map((u) => u.sourceType).sort();
      expect(names.length).toBe(90);
      expect(names[0]).toBe('NASJI_TEST_CLASS_000_' + 'X'.repeat(30));
      expect(names[89]).toBe('NASJI_TEST_CLASS_089_' + 'X'.repeat(30));
    });
});
