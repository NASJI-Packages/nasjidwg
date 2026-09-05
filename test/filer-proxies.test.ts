/* nasjidwg — proxies under their own filer, DXF-born records as
 * DXF-format proxies, the R14 table head, and the space block headers'
 * numbers across generations.
 *
 * Four facts pinned against the reference (its 2027 console, its own
 * 2000/2004/2007/2018 saves of probe drawings, bit-walked):
 *
 *  1. A proxy record's head past the common data is the class id; in the
 *     R2004 family alone a NUL-closed "cn:<class>" text; the version word
 *     — before R2018 the drawing-format code of the filer that wrote the
 *     payload (23 R2000 … 33 R2018) in the low half and the maintenance
 *     number in the high, from R2018 two words; the from-DXF flag. R2007+
 *     keep "cn:" first in the record's string stream. A payload written
 *     by an R2007+ filer keeps its strings in that stream behind "cn:"
 *     in an R2007+ file, and inline — stream, size word, flag — in a
 *     pre-2007 one. The reference unwraps such a proxy of its OWN classes
 *     into the record on open (A-01 into 2018 and 2004, Structural -
 *     Metric into 2007 and 2004: AUDIT 0, FIELDs and ASSOC networks
 *     native in its DXFOUT).
 *  2. A record that arrived through DXF as tags leaves as a proxy in DXF
 *     FORMAT: version = the DXF's release code, maintenance 0x7FFFFFFE,
 *     from-DXF 1, payload `BL 499 (498 for an entity), BL class number,
 *     (BS code, value)* … BS 0` — real BD, point 3×BD, 16/8-bit BS, 32-bit
 *     BL, binary BL n + bytes, handle in the handle stream, text TV; an
 *     entity's AcDbEntity section left out. The reference opens such a
 *     proxy of its own classes as the record (102 FIELDs of A-01's DXF,
 *     native in its DXFOUT at AUDIT 0).
 *  3. The R14 ACAD_TABLE head is the R14 INSERT head: three explicit BD
 *     scales, not the R2000 data flag.
 *  4. Under preserveHandles the two space block headers keep their source
 *     numbers (the layouts' `blockHandle`, or the reader's MODEL_SPACE /
 *     PAPER_SPACE structure handles where a file carries no LAYOUT objects),
 *     so their extension dictionaries travel on every generation.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018, writeDwgR14
} from '../src/dwg/writer.js';
import { BitReader } from '../src/dwg/bitstream.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { detectVersion, readFileHeaderR2000, versionRank } from '../src/dwg/fileheader.js';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { readSections2007 } from '../src/dwg/sections2007.js';
import { readObjectMap } from '../src/dwg/objectmap.js';
import { readClasses } from '../src/dwg/classes.js';
import { SEAL_MAGIC } from '../src/dwg/objects.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, FileVersion, UnknownObject } from '../src/core/model.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const kindOf = (u: UnknownObject): string => (u.appClass?.dxfName ?? u.sourceType).toUpperCase();

const base = (): Drawing => {
  const d = emptyDrawing();
  d.header.version = 'R2000';
  d.layers = [{ name: '0', color: { kind: 'aci', index: 7 }, on: true, frozen: false, locked: false }];
  d.entities = [{
    type: 'line', handle: 'A0', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
  }];
  d.structureHandles = { NOD: 'C' };
  return d;
};

/** Sealed bits of a probe record: BL 1, BD 2.5 (and, from R2007, the
 *  string stream "Hello"). */
const probeBits = (): { data: string; dataBits: number } => {
  const w = new BitWriter();
  w.bl(1); w.bd(2.5);
  return { data: b64(w.bytes()), dataBits: w.pos };
};
const probeStrings = (): { strData: string; strBits: number } => {
  const w = new BitWriter();
  w.bs(5); for (const ch of 'Hello') w.rs(ch.charCodeAt(0));
  return { strData: b64(w.bytes()), strBits: w.pos };
};

/** The sections an object record lives in, per container generation. */
const sectionsOf = (data: Uint8Array): { v: number; objs: Uint8Array; handles: Uint8Array } => {
  const v = versionRank(detectVersion(data));
  if (v <= 2000) {
    const hdr = readFileHeaderR2000(data);
    const s = hdr.sections.find((q) => q.id === 2)!;
    return { v, objs: data, handles: data.subarray(s.address, s.address + s.size) };
  }
  const secs = v === 2007 ? readSections2007(data) : readSections2004(data);
  return { v, objs: secs.get('AcDb:AcDbObjects')!, handles: secs.get('AcDb:Handles')! };
};

interface ProxyRecord {
  type: number;
  classId: number;
  cn: string;                            /* the R2004 inline text */
  version: number;
  maint?: number;
  fromDxf: number;
  /** the payload: the data area past the head */
  payload: BitReader;
  payloadBits: number;
  /** R2007+: the record's string stream, as texts */
  strings: string[];
  handles: { code: number; value: number }[];
}

/** Walk one proxy OBJECT record of a file this library wrote: the common
 *  prologue, the proxy head in the release's spelling, the payload, the
 *  R2007+ string stream and the handle stream. */
const proxyRecord = (data: Uint8Array, handle: string): ProxyRecord => {
  const { v, objs, handles } = sectionsOf(data);
  const omap = readObjectMap(handles);
  let mi = -1;
  for (let i = 0; i < omap.count; i++) if (omap.handles[i] === parseInt(handle, 16)) mi = i;
  expect(mi, `record ${handle} in the object map`).toBeGreaterThanOrEqual(0);
  let p = omap.offsets[mi], size = 0, shift = 0;
  for (;;) {
    const w = objs[p] | (objs[p + 1] << 8);
    p += 2;
    size += (w & 0x7fff) * 2 ** shift;
    if (!(w & 0x8000)) break;
    shift += 15;
  }
  let hs = 0;
  if (v >= 2010) {
    let hshift = 0;
    for (;;) { const b = objs[p++]; hs += (b & 0x7f) * 2 ** hshift; if (!(b & 0x80)) break; hshift += 7; }
  }
  const body = objs.subarray(p, p + size);
  const r = new BitReader(body, 0, size * 8);
  let type: number, bitsize: number;
  if (v >= 2010) {
    const bb = r.bb();
    type = bb === 0 ? r.rc() : bb === 1 ? r.rc() + 0x1f0 : r.rs();
    bitsize = size * 8 - hs;
  } else {
    type = r.bs();
    bitsize = r.rl();
  }
  r.h();
  let eed = r.bs();
  while (eed > 0) { r.h(); for (let i = 0; i < eed; i++) r.rc(); eed = r.bs(); }
  r.bl();                                 /* reactor count */
  if (v >= 2004) r.b();                   /* xdict missing */
  if (v >= 2013) r.b();                   /* has ds data */
  const classId = r.bl();
  let cn = '';
  if (v === 2004) {
    const n = r.bs();
    for (let i = 0; i < n; i++) cn += String.fromCharCode(r.rc());
  }
  const version = r.bl();
  const maint = v >= 2018 ? r.bl() : undefined;
  const fromDxf = r.b();
  /* the R2007+ string stream closes the data area */
  let dataEnd = bitsize;
  const strings: string[] = [];
  if (v >= 2007) {
    const bit = (i: number): number => (body[i >> 3] >> (7 - (i & 7))) & 1;
    const rsAt = (at: number): number => new BitReader(body, at, at + 16).rs();
    if (bit(bitsize - 1)) {
      let sz = rsAt(bitsize - 17), hdr = 16;
      if (sz & 0x8000) { sz = (sz & 0x7fff) | (rsAt(bitsize - 33) << 15); hdr = 32; }
      dataEnd = bitsize - 1 - hdr - sz;
      const sr = new BitReader(body, dataEnd, dataEnd + sz);
      while (sr.pos + 8 <= dataEnd + sz) {
        const n = sr.bs();
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(sr.rs());
        strings.push(s);
      }
    } else {
      dataEnd = bitsize - 1;
    }
  }
  const payloadStart = r.pos;
  const hr = new BitReader(body, bitsize, size * 8);
  const hh: { code: number; value: number }[] = [];
  while (hr.pos + 8 <= size * 8) {
    const h = hr.h();
    if (h.code === 0 && h.value === 0) break;
    hh.push({ code: h.code, value: h.value });
  }
  return {
    type, classId, cn, version, maint, fromDxf,
    payload: new BitReader(body, payloadStart, dataEnd),
    payloadBits: dataEnd - payloadStart,
    strings, handles: hh
  };
};

/** The CLASSES number the file gave a class. */
const classNumberOf = (data: Uint8Array, dxfName: string): number => {
  const { v } = sectionsOf(data);
  let section: Uint8Array;
  let fv: FileVersion;
  if (v <= 2000) {
    const s = readFileHeaderR2000(data).sections.find((q) => q.id === 1)!;
    section = data.subarray(s.address, s.address + s.size);
    fv = 'R2000';
  } else {
    const secs = v === 2007 ? readSections2007(data) : readSections2004(data);
    section = secs.get('AcDb:Classes')!;
    fv = v === 2007 ? 'R2007' : v >= 2018 ? 'R2018' : 'R2004';
  }
  for (const c of readClasses(section, fv).values()) {
    if (c.dxfName === dxfName) return c.classNum;
  }
  return -1;
};

const sealOf = (d: Drawing, h: string): UnknownObject | undefined =>
  d.unknownObjects?.find((u) => u.handle === h);

/* ------------------------------------------------------------------ */

describe('a foreign-generation seal of one of the reference\'s own classes', () => {
  const scale = (encoding: number): UnknownObject => ({
    handle: 'E2', ownerHandle: 'C', name: 'S1', sourceType: 'SCALE', dictPath: [],
    appClass: { dxfName: 'SCALE', cppName: 'AcDbScale', appName: 'ObjectDBX Classes' },
    encoding, ...probeBits(),
    ...(encoding >= 2007 ? probeStrings() : {}),
    refs: [{ code: 5, value: 'A0' }]
  });
  const source = (encoding: number): Drawing => {
    const d = base();
    d.header.version = encoding === 2007 ? 'R2007' : encoding === 2018 ? 'R2018' : 'R2000';
    d.unknownObjects = [scale(encoding)];
    return d;
  };

  it.each([
    ['R2007 bits into R2018', 2007, writeDwg2018, 27],
    ['R2018 bits into R2007', 2018, writeDwg2007, 33],
    ['R2007 bits into R2004', 2007, writeDwg2004, 27],
    ['R2018 bits into R2000', 2018, writeDwg2000, 33],
    ['R2000 bits into R2018', 2000, writeDwg2018, 23]
  ] as const)('%s: a proxy under the filer that wrote the bits', (_n, enc, writer, code) => {
    const res = writer(source(enc), { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const rec = proxyRecord(res.data, 'E2');
    const V = versionRank(detectVersion(res.data));
    expect(rec.type).toBe(0x1f3);
    expect(rec.classId).toBe(classNumberOf(res.data, 'SCALE'));
    expect(rec.fromDxf).toBe(0);
    if (V >= 2018) { expect(rec.version).toBe(code); expect(rec.maint).toBe(0); }
    else expect(rec.version).toBe(code);            /* maintenance 0 in the high half */
    expect(rec.cn).toBe(V === 2004 ? 'cn:AcDbScale\0' : '');
    /* the payload: the data bits, then — an R2007+ payload's strings —
       in the record's own stream behind "cn:" (R2007+ file) or inline
       with size word and flag (pre-2007 file) */
    const probe = probeBits();
    expect(rec.payload.bl()).toBe(1);
    expect(rec.payload.bd()).toBe(2.5);
    if (V >= 2007) {
      expect(rec.payloadBits).toBe(probe.dataBits);
      expect(rec.strings).toEqual(enc >= 2007 ? ['cn:AcDbScale', 'Hello'] : ['cn:AcDbScale']);
    } else if (enc >= 2007) {
      const str = probeStrings();
      expect(rec.payloadBits).toBe(probe.dataBits + str.strBits + 16 + 1);
      expect(rec.payload.bs()).toBe(5);       /* "Hello" inline */
      for (const ch of 'Hello') expect(rec.payload.rs()).toBe(ch.charCodeAt(0));
      expect(rec.payload.rs()).toBe(str.strBits);
      expect(rec.payload.b()).toBe(1);
    } else {
      expect(rec.payloadBits).toBe(probe.dataBits);
    }
    /* the owner, then the seal's own reference, code for code */
    expect(rec.handles[0]).toEqual({ code: 4, value: 0xc });
    expect(rec.handles[rec.handles.length - 1]).toEqual({ code: 5, value: 0xa0 });
    /* the reader re-seals the record in its own generation: a rewrite is
       a fixed point */
    const back = readDwg(res.data);
    expect(back.proxyObjects ?? []).toEqual([]);
    const s = sealOf(back, 'E2');
    expect(s && kindOf(s)).toBe('SCALE');
    expect(s?.encoding).toBe(enc);
    expect(s?.data).toBe(probe.data);
    expect(s?.dataBits).toBe(probe.dataBits);
    if (enc >= 2007) {
      expect(s?.strData).toBe(probeStrings().strData);
      expect(s?.strBits).toBe(probeStrings().strBits);
    } else expect(s?.strData).toBeUndefined();
    expect(s?.refs).toEqual([{ code: 5, value: 'A0' }]);
    expect(s?.ownerHandle).toBe('C');
    expect(s?.dictPath).toEqual([]);
    const again = writer(back, { preserveHandles: true });
    expect(again.skipped).toEqual([]);
    const rec2 = proxyRecord(again.data, 'E2');
    expect(rec2.version).toBe(rec.version);
    expect(rec2.payloadBits).toBe(rec.payloadBits);
    expect(rec2.strings).toEqual(rec.strings);
    expect(sealOf(readDwg(again.data), 'E2')?.data).toBe(probe.data);
  });

  it('a class that is not the reference\'s keeps the private envelope, and stays home in R2004', () => {
    const d = source(2007);
    d.unknownObjects![0].appClass = { dxfName: 'ACME_NOTE', cppName: 'AcmeNote', appName: 'ACME' };
    d.unknownObjects![0].sourceType = 'ACME_NOTE';
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const rec = proxyRecord(res.data, 'E2');
    expect((rec.version & 0xffff0000) >>> 0).toBe(SEAL_MAGIC);
    expect(rec.version & 0xffff).toBe(2007);
    const s = sealOf(readDwg(res.data), 'E2');
    expect(s?.encoding).toBe(2007);
    expect(s?.data).toBe(probeBits().data);
    expect(writeDwg2004(d, { preserveHandles: true }).skipped).toEqual(['ACME_NOTE']);
  });

  it('an R14 target keeps a foreign seal home', () => {
    const res = writeDwgR14(source(2007), { preserveHandles: true });
    expect(res.skipped).toEqual(['SCALE']);
  });

  it('a class-versioned record keeps its version pair in CLASSES', () => {
    const d = source(2007);
    d.unknownObjects![0].appClass = {
      dxfName: 'SCALE', cppName: 'AcDbScale', appName: 'ObjectDBX Classes', dwgVersion: 28, maintVersion: 1
    };
    const res = writeDwg2018(d, { preserveHandles: true });
    const secs = readSections2004(res.data);
    const cls = [...readClasses(secs.get('AcDb:Classes')!, 'R2018').values()].find((c) => c.dxfName === 'SCALE');
    expect(cls?.dwgVersion).toBe(28);
    expect(cls?.maintVersion).toBe(1);
    expect(sealOf(readDwg(res.data), 'E2')?.appClass).toMatchObject({ dwgVersion: 28, maintVersion: 1 });
  });
});

/* ------------------------------------------------------------------ */

describe('a record that arrived through DXF as tags', () => {
  const field = (): UnknownObject => ({
    handle: 'F1', ownerHandle: 'C', name: 'TEXT', sourceType: 'FIELD', dictPath: [],
    appClass: { dxfName: 'FIELD', cppName: 'AcDbField', appName: 'ObjectDBX Classes' },
    tags: [
      [5, 'F1'], [102, '{ACAD_REACTORS'], [330, 'C'], [102, '}'], [330, 'C'],
      [100, 'AcDbField'], [1, '_text'], [90, '        1'], [340, 'A0'],
      [10, '1.0'], [20, '2.0'], [30, '3.0'], [280, '     1'], [310, '0102FF'], [70, '    -2']
    ]
  });
  const source = (): Drawing => {
    const d = base();
    d.header.version = 'R2000';
    d.unknownObjects = [field()];
    return d;
  };
  const checkPayload = (rec: ProxyRecord, clsNum: number, V: number): void => {
    const q = rec.payload;
    expect(q.bl()).toBe(499);
    expect(q.bl()).toBe(clsNum);
    const text = (): string => {
      if (V >= 2007) return '(stream)';
      const n = q.bs();
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(q.rc());
      return s;
    };
    expect(q.bs()).toBe(100); expect(text()).toBe(V >= 2007 ? '(stream)' : 'AcDbField\0');
    expect(q.bs()).toBe(1); expect(text()).toBe(V >= 2007 ? '(stream)' : '_text\0');
    expect(q.bs()).toBe(90); expect(q.bl()).toBe(1);
    expect(q.bs()).toBe(340);                       /* in the handle stream */
    expect(q.bs()).toBe(10); expect([q.bd(), q.bd(), q.bd()]).toEqual([1, 2, 3]);
    expect(q.bs()).toBe(280); expect(q.bs()).toBe(1);
    expect(q.bs()).toBe(310); expect(q.bl()).toBe(3);
    expect([q.rc(), q.rc(), q.rc()]).toEqual([1, 2, 0xff]);
    expect(q.bs()).toBe(70); expect(q.bs()).toBe(-2);   /* a signed 16-bit short */
    expect(q.bs()).toBe(0);
    expect(q.pos).toBe(q.endBit);
    if (V >= 2007) expect(rec.strings).toEqual(['cn:AcDbField', 'AcDbField', '_text']);
    expect(rec.handles[0]).toEqual({ code: 4, value: 0xc });
    expect(rec.handles[rec.handles.length - 1]).toEqual({ code: 5, value: 0xa0 });
  };

  it.each([
    ['R2018', writeDwg2018], ['R2007', writeDwg2007], ['R2004', writeDwg2004], ['R2000', writeDwg2000]
  ] as const)('%s: a DXF-format proxy under the DXF\'s release code, and a fixed point', (_n, writer) => {
    const res = writer(source(), { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const V = versionRank(detectVersion(res.data));
    const clsNum = classNumberOf(res.data, 'FIELD');
    const rec = proxyRecord(res.data, 'F1');
    expect(rec.type).toBe(0x1f3);
    expect(rec.classId).toBe(clsNum);
    expect(rec.fromDxf).toBe(1);
    if (V >= 2018) { expect(rec.version).toBe(23); expect(rec.maint).toBe(0x7ffffffe); }
    else expect(rec.version >>> 0).toBe(0x7fff0017);
    expect(rec.cn).toBe(V === 2004 ? 'cn:AcDbField\0' : '');
    checkPayload(rec, clsNum, V);
    /* read back: a proxy object, from DXF, its record whole */
    const back = readDwg(res.data);
    expect(back.unknownObjects?.some((u) => u.handle === 'F1') ?? false).toBe(false);
    const p = back.proxyObjects?.find((x) => x.handle === 'F1');
    expect(p?.fromDxf).toBe(true);
    expect(p?.name).toBe('TEXT');
    expect(p?.ownerHandle).toBe('C');
    expect(p?.refs).toEqual([{ code: 5, value: 'A0' }]);
    expect(p?.dataBits).toBe(rec.payloadBits);
    if (V >= 2007) expect(p?.strBits).toBeGreaterThan(0);
    /* written again: the same record */
    const again = writer(back, { preserveHandles: true });
    const rec2 = proxyRecord(again.data, 'F1');
    expect(rec2.version).toBe(rec.version);
    expect(rec2.maint).toBe(rec.maint);
    expect(rec2.fromDxf).toBe(1);
    checkPayload(rec2, classNumberOf(again.data, 'FIELD'), V);
  });

  it('a DXF-born entity: the AcDbEntity section is the prologue\'s, the payload opens with 498', () => {
    const d = base();
    d.header.version = 'R2018';
    d.entities.push({
      type: 'unknown', handle: 'E2', layer: '0', color: { kind: 'byLayer' }, sourceType: 'ACME_SHAPE',
      appClass: { dxfName: 'ACME_SHAPE', cppName: 'AcmeShape', appName: 'ACME' },
      tags: [[5, 'E2'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [62, '3'],
        [100, 'AcmeShape'], [90, '3'], [40, '1.5'], [340, 'A0'], [1, 'Hello']]
    });
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const p = back.entities.find((e): e is Extract<Entity, { type: 'proxy' }> => e.type === 'proxy');
    expect(p?.fromDxf).toBe(true);
    expect(p?.proxyVersion).toBe(33);
    expect(p?.proxyMaint).toBe(0x7ffffffe);
    expect(p?.refs).toEqual([{ code: 5, value: 'A0' }]);
    const q = new BitReader(Buffer.from(p!.data!, 'base64'), 0, p!.dataBits!);
    expect(q.bl()).toBe(498);
    expect(q.bl()).toBe(classNumberOf(res.data, 'ACME_SHAPE'));
    expect(q.bs()).toBe(100);                        /* AcmeShape, in the stream */
    expect(q.bs()).toBe(90); expect(q.bl()).toBe(3);
    expect(q.bs()).toBe(40); expect(q.bd()).toBe(1.5);
    expect(q.bs()).toBe(340);
    expect(q.bs()).toBe(1);
    expect(q.bs()).toBe(0);
    expect(q.pos).toBe(q.endBit);
  });

  it('R14 has no proxy record for it', () => {
    expect(writeDwgR14(source(), { preserveHandles: true }).skipped)
      .toEqual(['FIELD (no retained record bits)']);
  });

  it('a section view style travels flat under the root, unlisted by its dictionary, without its reactor', () => {
    /* the reference type-checks the entries of ACAD_SECTIONVIEWSTYLE before
       its lazy unwrap of a DXF-format proxy (listed: the entry is deleted,
       AUDIT 1 fix); flat under the root the same proxy unwraps at AUDIT 0
       and its DXFOUT lists the style natively — measured on A-01's DXF */
    const d = source();
    const style = d.unknownObjects![0];
    style.sourceType = 'ACDBSECTIONVIEWSTYLE';
    style.appClass = {
      dxfName: 'ACDBSECTIONVIEWSTYLE', cppName: 'AcDbSectionViewStyle', appName: 'ObjectDBX Classes'
    };
    style.name = 'Imperial24';
    style.ownerHandle = 'D1';
    style.dictPath = ['ACAD_SECTIONVIEWSTYLE'];
    style.reactors = ['D1'];
    style.tags = style.tags!.map(([c, v]) => (c === 330 ? [c, 'D1'] : [c, v]));
    d.unknownObjects!.push({
      handle: 'D1', ownerHandle: 'C', name: 'ACAD_SECTIONVIEWSTYLE', sourceType: 'DICTIONARY',
      typeCode: 42, encoding: 2000, hardOwner: false, cloning: 1, dictPath: [],
      entries: [{ name: 'Imperial24', handle: 'F1', code: 2 }]
    });
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const p = back.proxyObjects?.find((x) => x.handle === 'F1');
    expect(p?.fromDxf).toBe(true);
    expect(p?.ownerHandle).toBe('C');
    expect(p?.name).toBe('Imperial24');
    expect(p?.reactors ?? []).toEqual([]);
    /* the dictionary lost its only entry and was not written: nothing of
       the reference's own tree lists the proxy */
    expect(back.unknownObjects?.some((u) => u.entries?.some((e) => e.handle === 'F1')) ?? false).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('the R14 table head', () => {
  const table = (): Entity => ({
    type: 'table', handle: 'B0', layer: '0', color: { kind: 'byLayer' },
    position: { x: 24.5, y: 3.8, z: 0 }, direction: { x: 1, y: 0, z: 0 },
    numRows: 2, numColumns: 2, rowHeights: [0.3, 0.5], columnWidths: [1.5, 2.5],
    cells: [{ contentType: 1, text: 'A' }, { contentType: 1, text: 'B' }, { contentType: 1 }, { contentType: 1, text: 'D' }]
  });
  it.each([['R14', writeDwgR14], ['R2000', writeDwg2000]] as const)('%s: three explicit scales before R2000, the flag from it', (_n, writer) => {
    const d = base();
    d.entities.push(table());
    const res = writer(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const t = back.entities.find((e): e is Extract<Entity, { type: 'table' }> => e.type === 'table');
    expect(t).toBeTruthy();
    expect(t?.numRows).toBe(2);
    expect(t?.numColumns).toBe(2);
    expect(t?.columnWidths.map((w) => +w.toFixed(6))).toEqual([1.5, 2.5]);
    expect(t?.rowHeights.map((h) => +h.toFixed(6))).toEqual([0.3, 0.5]);
    expect(t?.position.x).toBeCloseTo(24.5);
    expect(t?.extrusion).toBeUndefined();          /* 0,0,1 is the default */
    expect(t?.cells.map((c) => c.text ?? '')).toEqual(['A', 'B', '', 'D']);
  });
});

/* ------------------------------------------------------------------ */

describe('the space block headers across generations', () => {
  const r14Xrecord = (): { data: string; dataBits: number } => {
    /* an R14 XRECORD: BL byte count, then (RS group, value) — one string */
    const run = new BitWriter();
    run.rs(1); run.rs(5); run.rc(30); for (const ch of 'Model') run.rc(ch.charCodeAt(0));
    const bytes = run.bytes();
    const w = new BitWriter();
    w.bl(bytes.length); w.raw(bytes);
    return { data: b64(w.bytes()), dataBits: w.pos };
  };
  const source = (): Drawing => {
    const d = base();
    d.header.version = 'R14';
    d.layouts = [
      { name: 'Model', handle: 'BA5', blockName: '*MODEL_SPACE', blockHandle: '18', tabOrder: 0 },
      { name: 'Layout1', handle: 'BA6', blockName: '*PAPER_SPACE', blockHandle: '15', tabOrder: 1 }
    ];
    d.unknownObjects = [
      {
        handle: '1A556', ownerHandle: '18', sourceType: 'DICTIONARY', typeCode: 42, encoding: 14,
        hardOwner: false, entries: [{ name: 'ACAD_LAYOUTSELFREF', handle: '27C1E', code: 2 }]
      },
      {
        handle: '27C1E', ownerHandle: '1A556', name: 'ACAD_LAYOUTSELFREF', sourceType: 'XRECORD',
        typeCode: 79, encoding: 14, ...r14Xrecord()
      },
      {
        handle: '6D3', ownerHandle: '15', sourceType: 'DICTIONARY', typeCode: 42, encoding: 14,
        hardOwner: false, entries: [{ name: 'ACAD_LAYOUTSELFREF', handle: '27C1D', code: 2 }]
      },
      {
        handle: '27C1D', ownerHandle: '6D3', name: 'ACAD_LAYOUTSELFREF', sourceType: 'XRECORD',
        typeCode: 79, encoding: 14, ...r14Xrecord()
      }
    ];
    d.xrecords = [
      { handle: '27C1E', name: 'ACAD_LAYOUTSELFREF', values: [{ code: 1, value: 'Model' }] },
      { handle: '27C1D', name: 'ACAD_LAYOUTSELFREF', values: [{ code: 1, value: 'Model' }] }
    ];
    return d;
  };

  it('R14: the numbers come from the layouts, then from the reader\'s structure handles; a fixed point', () => {
    const g1 = writeDwgR14(source(), { preserveHandles: true });
    expect(g1.skipped).toEqual([]);
    const d1 = readDwg(g1.data);
    /* an R14 file of ours has no LAYOUT objects: the block headers are
       named by the structure handles instead */
    expect(d1.layouts ?? []).toEqual([]);
    expect(d1.structureHandles?.MODEL_SPACE).toBe('18');
    expect(d1.structureHandles?.PAPER_SPACE).toBe('15');
    expect(sealOf(d1, '1A556')?.ownerHandle).toBe('18');
    expect(sealOf(d1, '6D3')?.ownerHandle).toBe('15');
    expect(sealOf(d1, '27C1D')?.ownerHandle).toBe('6D3');
    expect(d1.xrecords?.find((x) => x.handle === '27C1D')?.values).toEqual([{ code: 1, value: 'Model' }]);
    const g2 = writeDwgR14(d1, { preserveHandles: true });
    expect(g2.skipped).toEqual([]);
    const d2 = readDwg(g2.data);
    expect((d2.unknownObjects ?? []).length).toBe((d1.unknownObjects ?? []).length);
    expect(sealOf(d2, '6D3')?.entries).toEqual([{ name: 'ACAD_LAYOUTSELFREF', handle: '27C1D', code: 2 }]);
    expect(sealOf(d2, '6D3')?.ownerHandle).toBe('15');
    expect(sealOf(d2, '1A556')?.ownerHandle).toBe('18');
  });

  it('R2000: the same numbers, and the layouts name them', () => {
    const g1 = writeDwg2000(source(), { preserveHandles: true });
    expect(g1.skipped).toEqual([]);
    const d1 = readDwg(g1.data);
    expect(d1.layouts?.find((l) => l.name === 'Model')?.blockHandle).toBe('18');
    expect(d1.structureHandles?.MODEL_SPACE).toBe('18');
    expect(sealOf(d1, '1A556')?.ownerHandle).toBe('18');
    expect(sealOf(d1, '6D3')?.ownerHandle).toBe('15');
  });

  it('without preserveHandles the source numbers still map to the headers written', () => {
    /* an XRECORD stays home without the numbering (its data may name
       handles), so here the two dictionaries come empty — a fact of the
       source that travels */
    const d = source();
    d.unknownObjects = d.unknownObjects!.filter((u) => u.sourceType === 'DICTIONARY')
      .map((u) => ({ ...u, entries: [] }));
    d.xrecords = [];
    const g1 = writeDwgR14(d, { preserveHandles: false });
    expect(g1.skipped).toEqual([]);
    const d1 = readDwg(g1.data);
    const ms = d1.structureHandles?.MODEL_SPACE, ps = d1.structureHandles?.PAPER_SPACE;
    expect(ms).toBeTruthy();
    expect(ps).toBeTruthy();
    expect((d1.unknownObjects ?? []).filter((u) => u.ownerHandle === ms).length).toBe(1);
    expect((d1.unknownObjects ?? []).filter((u) => u.ownerHandle === ps).length).toBe(1);
  });
});
