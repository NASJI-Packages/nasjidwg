/* nasjidwg — the second generation: a file the reference itself wrote
 * from a 2013+ drawing into an earlier release, read and written again
 * under preserveHandles, and that result once more.
 *
 * The reference's pre-2013 saves decompose the data store into a
 * named-objects tree `AcDsDecomposeData` = { AcDsRecords, AcDsSchemas }
 * — AcDsRecords usually EMPTY — and recompose it on open from both,
 * refusing the file (ErrorStatus 53) when AcDsRecords is gone. Measured
 * on its 2000, 2004 and R14 saves of a three-MTEXT probe: the preserving
 * write, which dropped every dictionary with nothing written to list,
 * was refused at every target (2000, 2004, 2007, 2018, R14); with the
 * empty dictionary kept, gen1 and gen2 open at AUDIT 0/0, and so do its
 * 2000/2004/2007 saves of A-01, Text and Tables, Tower and an xref set.
 *
 * Two more facts of the same round, both about the root dictionary: a
 * dictionary the tree lists is that dictionary's entry, never the root's
 * extension dictionary (the root used to get the LAST one it listed as
 * its xdict — "Extension dictionary 19C Cannot access, Removed" once the
 * reference had consumed that target on open); and the root's genuine
 * extension dictionary hangs off the root's xdict pointer alone, not
 * listed as an entry as well ("SEALED_OBJECT_138 eWasErased, Delete
 * Entry" on the R14 save, whose root carries an ACAD_XREC_ROUNDTRIP).
 *
 * The suite can check what the reader gets back and what the root's
 * record bits say; the reference's verdicts are the external proof.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2004, writeDwg2018 } from '../src/dwg/writer.js';
import { BitReader } from '../src/dwg/bitstream.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { detectVersion, readFileHeaderR2000, versionRank } from '../src/dwg/fileheader.js';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { readObjectMap } from '../src/dwg/objectmap.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, UnknownObject, XdataValue } from '../src/core/model.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** An XRECORD body in the given generation's spelling: the byte-counted
 *  run of (RS group, value), then the R2000+ cloning flag. */
const xrecordBits = (values: XdataValue[], gen: number): { data: string; dataBits: number } => {
  const run = new BitWriter();
  for (const v of values) {
    if ('point' in v) continue;
    run.rs(v.code);
    if (typeof v.value === 'string' && v.code < 10) {
      if (gen >= 2007) {
        run.rs(v.value.length);
        for (let i = 0; i < v.value.length; i++) run.rs(v.value.charCodeAt(i));
      } else {
        run.rs(v.value.length); run.rc(30);
        for (let i = 0; i < v.value.length; i++) run.rc(v.value.charCodeAt(i) & 0xff);
      }
    } else if (v.code === 40) run.rd(Number(v.value));
    else if (v.code === 70) run.rs(Number(v.value));
    else if (v.code === 90) run.rl(Number(v.value));
  }
  const bytes = run.bytes();
  const w = new BitWriter();
  w.bl(bytes.length);
  w.raw(bytes);
  if (gen >= 2000) w.bs(1);
  return { data: b64(w.bytes()), dataBits: w.pos };
};

const NOD = 'B';
const SCHEMA_A: XdataValue[] = [{ code: 1, value: 'AcDbDs::ID' }, { code: 70, value: 1 }];
const SCHEMA_B: XdataValue[] = [{ code: 1, value: 'AcDbDs::TreatedAsObjectData' }, { code: 70, value: 2 }];
const RT_2008: XdataValue[] = [{ code: 40, value: 353064 }, { code: 1, value: '\\pxqc;Centred heading\\P\\pxql;plain again' }];
const RT_2004: XdataValue[] = [{ code: 40, value: 203954 }, { code: 1, value: '\\pi22.5;Centred heading\\P\\pi-7.5;plain again' }];
const ROUNDTRIP: XdataValue[] = [{ code: 1, value: 'DBVERSION' }, { code: 70, value: 1 }];

/** The shape of the reference's 2000/2004 save of a small 2018 drawing:
 *  an MTEXT with its round-trip chain, the decomposed data store under
 *  the root (AcDsRecords empty), and — as its R14 save has it — the
 *  root's own extension dictionary. Handles are the probe's. */
const probe = (encoding: number, rootXdict: boolean): Drawing => {
  const d = emptyDrawing();
  d.layers = [{ name: '0', color: { kind: 'aci', index: 7 }, on: true, frozen: false, locked: false }];
  d.structureHandles = { NOD };
  d.entities = [{
    type: 'mtext', layer: '0', color: { kind: 'byLayer' }, handle: '1C', xdict: '18D',
    position: { x: 0, y: 0, z: 0 }, height: 2.5, rotation: 0, width: 80,
    text: 'Centred heading\nplain again'
  }] as Entity[];
  const dict = (handle: string, owner: string, name: string | undefined, dictPath: string[] | undefined,
    entries: [string, string][]): UnknownObject => ({
    handle, ownerHandle: owner, ...(name ? { name } : {}), sourceType: 'DICTIONARY', typeCode: 42,
    encoding, ...(dictPath ? { dictPath } : {}), hardOwner: false, cloning: 1,
    entries: entries.map(([n, h]) => ({ name: n, handle: h, code: 2 }))
  });
  const xrec = (handle: string, owner: string, name: string, dictPath: string[] | undefined,
    values: XdataValue[]): UnknownObject => {
    d.xrecords = [...(d.xrecords ?? []), { handle, name, values }];
    return {
      handle, ownerHandle: owner, name, sourceType: 'XRECORD', typeCode: 79, encoding,
      ...(dictPath ? { dictPath } : {}), ...xrecordBits(values, encoding)
    };
  };
  d.unknownObjects = [
    /* the MTEXT's chain: the reference keeps the original spelling here */
    dict('18D', '1C', undefined, undefined, [['ACAD_MTEXT_2008_RT', '18E'], ['ACAD_MTEXT_RT', '1A5']]),
    xrec('18E', '18D', 'ACAD_MTEXT_2008_RT', undefined, RT_2008),
    xrec('1A5', '18D', 'ACAD_MTEXT_RT', undefined, RT_2004),
    /* the decomposed data store */
    xrec('197', '19D', '2173783866096', ['AcDsDecomposeData', 'AcDsSchemas'], SCHEMA_A),
    xrec('198', '19D', '2173783866112', ['AcDsDecomposeData', 'AcDsSchemas'], SCHEMA_B),
    dict('19C', NOD, 'AcDsDecomposeData', [], [['AcDsRecords', '19E'], ['AcDsSchemas', '19D']]),
    dict('19D', '19C', 'AcDsSchemas', ['AcDsDecomposeData'],
      [['2173783866096', '197'], ['2173783866112', '198']]),
    dict('19E', '19C', 'AcDsRecords', ['AcDsDecomposeData'], []),
    /* the root's own extension dictionary (no dictPath: hangs off the
       root, listed by nothing) */
    ...(rootXdict ? [
      dict('120', NOD, undefined, undefined, [['ACAD_XREC_ROUNDTRIP', '121']]),
      xrec('121', '120', 'ACAD_XREC_ROUNDTRIP', undefined, ROUNDTRIP)
    ] : [])
  ];
  return d;
};

/** The handle the root dictionary's record points at as its extension
 *  dictionary (0 = none), read off the object's own bits in any R2000+
 *  container: the handle stream is owner, reactors, then the xdict —
 *  present before R2004 always, from R2004 only when the "xdict
 *  missing" bit is clear. */
const rootXdictOf = (data: Uint8Array): number => {
  const v = versionRank(detectVersion(data));
  let objs: Uint8Array, handles: Uint8Array;
  if (v <= 2000) {
    const hdr = readFileHeaderR2000(data);
    const s = hdr.sections.find((q) => q.id === 2)!;
    handles = data.subarray(s.address, s.address + s.size);
    objs = data;
  } else {
    const secs = readSections2004(data);
    objs = secs.get('AcDb:AcDbObjects')!;
    handles = secs.get('AcDb:Handles')!;
  }
  const omap = readObjectMap(handles);
  let mi = -1;
  for (let i = 0; i < omap.count; i++) if (omap.handles[i] === parseInt(NOD, 16)) mi = i;
  expect(mi).toBeGreaterThanOrEqual(0);
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
    for (;;) {
      const b = objs[p++];
      hs += (b & 0x7f) * 2 ** hshift;
      if (!(b & 0x80)) break;
      hshift += 7;
    }
  }
  const body = objs.subarray(p, p + size);
  const r = new BitReader(body, 0, size * 8);
  let bitsize: number;
  if (v >= 2010) {
    const bb = r.bb();
    if (bb === 2) r.rs(); else r.rc();
    bitsize = size * 8 - hs;
  } else {
    r.bs();
    bitsize = r.rl();
  }
  r.h();
  let eed = r.bs();
  while (eed > 0) {
    r.h();
    for (let i = 0; i < eed; i++) r.rc();
    eed = r.bs();
  }
  const numReactors = r.bl();
  const xdictMissing = v >= 2004 ? r.b() === 1 : false;
  const hr = new BitReader(body, bitsize, size * 8);
  hr.h();                                   /* owner */
  for (let i = 0; i < numReactors; i++) hr.h();
  return xdictMissing ? 0 : hr.h().value;
};

const byH = (d: Drawing, h: string): UnknownObject | undefined =>
  (d.unknownObjects ?? []).find((u) => u.handle?.toUpperCase() === h);
const handlesOf = (d: Drawing): string[] =>
  (d.unknownObjects ?? []).map((u) => u.handle!.toUpperCase()).sort();

/** What every generation must read back. */
const check = (back: Drawing, rootXdict: boolean): void => {
  expect(back.warnings).toEqual([]);
  expect(back.structureHandles?.NOD).toBe(NOD);
  const root = byH(back, '19C');
  expect(root?.name).toBe('AcDsDecomposeData');
  expect(root?.ownerHandle).toBe(NOD);
  expect(root?.dictPath).toEqual([]);
  expect(root?.entries?.map((e) => [e.name, e.handle]))
    .toEqual([['AcDsRecords', '19E'], ['AcDsSchemas', '19D']]);
  /* the empty dictionary is a fact of the source, not a loss */
  const records = byH(back, '19E');
  expect(records?.ownerHandle).toBe('19C');
  expect(records?.dictPath).toEqual(['AcDsDecomposeData']);
  expect(records?.entries).toEqual([]);
  const schemas = byH(back, '19D');
  expect(schemas?.entries?.map((e) => [e.name, e.handle]))
    .toEqual([['2173783866096', '197'], ['2173783866112', '198']]);
  expect(byH(back, '197')?.ownerHandle).toBe('19D');
  expect(back.xrecords?.find((x) => x.handle === '197')?.values).toEqual(SCHEMA_A);
  expect(back.xrecords?.find((x) => x.handle === '198')?.values).toEqual(SCHEMA_B);
  /* the MTEXT's chain travels as it came: one record per key, none of
     the writer's own beside it */
  const mt = back.entities.find((e) => e.type === 'mtext');
  expect(mt?.handle).toBe('1C');
  expect(mt?.xdict).toBe('18D');
  const chain = byH(back, '18D');
  expect(chain?.ownerHandle).toBe('1C');
  expect(chain?.entries?.map((e) => [e.name, e.handle]))
    .toEqual([['ACAD_MTEXT_2008_RT', '18E'], ['ACAD_MTEXT_RT', '1A5']]);
  expect(back.xrecords?.find((x) => x.handle === '18E')?.values).toEqual(RT_2008);
  expect(back.xrecords?.find((x) => x.handle === '1A5')?.values).toEqual(RT_2004);
  /* the root's own extension dictionary: owned by the root, listed by
     nothing (a listed record would come back with a dictPath) */
  const rx = byH(back, '120');
  if (rootXdict) {
    expect(rx?.ownerHandle).toBe(NOD);
    expect(rx?.dictPath).toBeUndefined();
    expect(rx?.entries?.map((e) => [e.name, e.handle])).toEqual([['ACAD_XREC_ROUNDTRIP', '121']]);
    expect(back.xrecords?.find((x) => x.handle === '121')?.values).toEqual(ROUNDTRIP);
  } else {
    expect(rx).toBeUndefined();
  }
};

const WRITERS = [
  ['R2000', writeDwg2000, 2000],
  ['R2004', writeDwg2004, 2004],
  ['R2018', writeDwg2018, 2018]
] as const;

describe.each(WRITERS)('the second generation (%s)', (_v, writer, encoding) => {
  it('the decomposed data store survives two preserving writes, empty AcDsRecords included', () => {
    const gen1 = writer(probe(encoding, false), { preserveHandles: true });
    expect(gen1.skipped).toEqual([]);
    const back1 = readDwg(gen1.data);
    check(back1, false);
    /* a dictionary the root lists is its entry, not its extension
       dictionary: the root's record points at none */
    expect(rootXdictOf(gen1.data)).toBe(0);
    const gen2 = writer(back1, { preserveHandles: true });
    expect(gen2.skipped).toEqual([]);
    const back2 = readDwg(gen2.data);
    check(back2, false);
    expect(rootXdictOf(gen2.data)).toBe(0);
    /* the second generation is a fixed point of the first */
    expect(handlesOf(back2)).toEqual(handlesOf(back1));
    expect(back2.xrecords?.map((x) => x.handle).sort()).toEqual(back1.xrecords?.map((x) => x.handle).sort());
  });

  it('the root\'s own extension dictionary hangs off the root alone, both generations', () => {
    const gen1 = writer(probe(encoding, true), { preserveHandles: true });
    expect(gen1.skipped).toEqual([]);
    const back1 = readDwg(gen1.data);
    check(back1, true);
    expect(rootXdictOf(gen1.data)).toBe(0x120);
    const gen2 = writer(back1, { preserveHandles: true });
    expect(gen2.skipped).toEqual([]);
    const back2 = readDwg(gen2.data);
    check(back2, true);
    expect(rootXdictOf(gen2.data)).toBe(0x120);
    expect(handlesOf(back2)).toEqual(handlesOf(back1));
  });

  it('without the numbering the empty dictionary still travels and the store is not half a tree', () => {
    /* the XRECORDs stay home (their data may name handles), so
       AcDsSchemas has nothing left to list and stays with them; the
       empty AcDsRecords goes, and the root lists it — the reference
       opens that at AUDIT 0/0 (measured on the same probes) */
    const res = writer(probe(encoding, false), { preserveHandles: false });
    const back = readDwg(res.data);
    const root = (back.unknownObjects ?? []).find((u) => u.name === 'AcDsDecomposeData');
    expect(root?.dictPath).toEqual([]);
    expect(root?.entries?.map((e) => e.name)).toEqual(['AcDsRecords']);
    const records = (back.unknownObjects ?? []).find((u) => u.name === 'AcDsRecords');
    expect(records?.entries).toEqual([]);
    expect(records?.ownerHandle).toBe(root?.handle);
    expect((back.unknownObjects ?? []).some((u) => u.name === 'AcDsSchemas')).toBe(false);
  });
});
