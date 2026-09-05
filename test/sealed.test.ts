/* nasjidwg — universal sealed passthrough.
 *
 * The container doctrine under test: every record the semantic layer
 * cannot model is retained SEALED — payload bit-exact, string stream
 * verbatim, handle references code-for-code — and re-emitted. Three
 * theorems are pinned here:
 *
 *   1. Same generation: a sealed record goes out as the native record
 *      and comes back identical, in every container we write.
 *   2. A→B→A: bits from generation A survive a trip through a foreign
 *      generation B wrapped in a proxy record (the format's own idiom
 *      for data the host release cannot hold), and go native again on
 *      returning to A.
 *   3. A failed decode of a known type loses nothing: the record rewinds
 *      and is kept sealed instead of being reduced to its common data.
 *
 * Plus the discipline that makes sealed references durable: the
 * preserveHandles writer keeps the source numbering, so a sealed
 * record's references stay valid across any number of rewrites.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018,
  writeDwgR13, writeDwgR14
} from '../src/dwg/writer.js';
import { decodeObjectBody, makeContext } from '../src/dwg/objects.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, UnknownEntity } from '../src/core/model.js';

const WRITERS = {
  R13: writeDwgR13, R14: writeDwgR14, R2000: writeDwg2000,
  R2004: writeDwg2004, R2007: writeDwg2007, R2018: writeDwg2018
} as const;
type V = keyof typeof WRITERS;
const VERSIONS = Object.keys(WRITERS) as V[];

/** Encoding generation of each writable container. */
const GROUP: Record<V, number> = {
  R13: 14, R14: 14, R2000: 2000, R2004: 2004, R2007: 2007, R2018: 2018
};

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/* 53 bits — not a whole number of bytes, bits past 53 zero */
const PAYLOAD = Uint8Array.from([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0xE0]);
const PAYLOAD_BITS = 53;
/* 21 bits of string-stream content for the 2007+ generations */
const STR = Uint8Array.from([0xCA, 0xFE, 0xC0]);
const STR_BITS = 21;
const REFS = [{ code: 4, value: '2A' }, { code: 3, value: '1F' }];

const baseDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.layers = [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
  d.entities = [{
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
  } as Entity];
  return d;
};

const sealedEntity = (encoding: number): UnknownEntity => ({
  type: 'unknown', layer: '0', color: { kind: 'byLayer' },
  sourceType: 'ACME_WIDGET',
  appClass: {
    dxfName: 'ACME_WIDGET', cppName: 'AcmeWidget', appName: 'ACMEAPP'
  },
  encoding,
  data: b64(PAYLOAD),
  dataBits: PAYLOAD_BITS,
  ...(encoding >= 2007
    ? { strData: b64(STR), strBits: STR_BITS }
    : {}),
  refs: REFS.map((r) => ({ ...r }))
});

const findUnknown = (d: Drawing): UnknownEntity | undefined =>
  d.entities.find((e): e is UnknownEntity => e.type === 'unknown');

/* ------------------------------------------------------------------ */

describe.each(VERSIONS)('sealed record, native generation %s', (version) => {
  const d = baseDrawing();
  d.entities.push(sealedEntity(GROUP[version]) as Entity);
  const { data, skipped } = WRITERS[version](d);
  const back = readDwg(data);
  const u = findUnknown(back);

  it('writes without loss reports and reads without warnings', () => {
    expect(skipped).toEqual([]);
    expect(back.warnings).toEqual([]);
  });

  it('comes back sealed and identical', () => {
    expect(u?.sourceType).toBe('ACME_WIDGET');
    expect(u?.encoding).toBe(GROUP[version]);
    expect(u?.data).toBe(b64(PAYLOAD));
    expect(u?.dataBits).toBe(PAYLOAD_BITS);
    expect(u?.refs).toEqual(REFS);
    if (GROUP[version] >= 2007) {
      expect(u?.strData).toBe(b64(STR));
      expect(u?.strBits).toBe(STR_BITS);
    }
  });

  it('is stable across a second generation', () => {
    const again = readDwg(WRITERS[version](back).data);
    const u2 = findUnknown(again);
    expect(u2?.data).toBe(u?.data);
    expect(u2?.dataBits).toBe(u?.dataBits);
    expect(u2?.strData).toBe(u?.strData);
    expect(u2?.refs).toEqual(u?.refs);
  });
});

/* ------------------------------------------------------------------ */

describe('the A→B→A theorem', () => {
  /* generation A = 2018 (has a string stream), foreign B = R2000 */
  const d = baseDrawing();
  d.entities.push(sealedEntity(2018) as Entity);

  const inB = readDwg(writeDwg2000(d).data);
  const uB = findUnknown(inB);

  it('B carries the foreign bits wrapped, tagged with their generation', () => {
    expect(uB?.sourceType).toBe('ACME_WIDGET');
    expect(uB?.encoding).toBe(2018);           /* not R2000's group */
    expect(uB?.data).toBe(b64(PAYLOAD));
    expect(uB?.dataBits).toBe(PAYLOAD_BITS);
    expect(uB?.strData).toBe(b64(STR));        /* string stream survives B,
                                                  which has no string streams */
    expect(uB?.refs).toEqual(REFS);
  });

  it('returning to A goes native again, bits identical', () => {
    const inA = readDwg(writeDwg2018(inB).data);
    const uA = findUnknown(inA);
    expect(uA?.sourceType).toBe('ACME_WIDGET');
    expect(uA?.encoding).toBe(2018);
    expect(uA?.data).toBe(b64(PAYLOAD));
    expect(uA?.dataBits).toBe(PAYLOAD_BITS);
    expect(uA?.strData).toBe(b64(STR));
    expect(uA?.strBits).toBe(STR_BITS);
    expect(uA?.refs).toEqual(REFS);
  });

  it('survives a longer odyssey: 2018 → 2000 → 2004 → 2018', () => {
    let doc = readDwg(writeDwg2000(d).data);
    doc = readDwg(writeDwg2004(doc).data);
    doc = readDwg(writeDwg2018(doc).data);
    const u = findUnknown(doc);
    expect(u?.data).toBe(b64(PAYLOAD));
    expect(u?.dataBits).toBe(PAYLOAD_BITS);
    expect(u?.encoding).toBe(2018);
    expect(u?.refs).toEqual(REFS);
  });

  it('stays home at R13/R14, reported: the reference refuses a foreign seal there', () => {
    /* proven on the reference's own A-03: its one sealed table entity
       wrapped for R14 was refused, the drawing without it opened clean */
    const res = writeDwgR13(d);
    expect(res.skipped).toContain('ACME_WIDGET');
    expect(findUnknown(readDwg(res.data))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe('sealed unknown objects (dictionary side)', () => {
  const make = (encoding: number): Drawing => {
    const d = baseDrawing();
    d.unknownObjects = [{
      name: 'ACME_TABLE',
      sourceType: 'ACME_HELPERS',
      appClass: {
        dxfName: 'ACME_HELPERS', cppName: 'AcmeHelpers', appName: 'ACMEAPP'
      },
      encoding,
      data: b64(PAYLOAD),
      dataBits: PAYLOAD_BITS,
      refs: [{ code: 4, value: '12' }]
    }];
    return d;
  };

  it.each(VERSIONS)('%s: native round trip under its dictionary name', (version) => {
    const back = readDwg(WRITERS[version](make(GROUP[version])).data);
    const p = back.unknownObjects?.[0];
    expect(back.warnings).toEqual([]);
    expect(p?.name).toBe('ACME_TABLE');
    expect(p?.data).toBe(b64(PAYLOAD));
    expect(p?.dataBits).toBe(PAYLOAD_BITS);
    expect(p?.refs).toEqual([{ code: 4, value: '12' }]);
  });

  it('A→B→A holds for objects too', () => {
    const inB = readDwg(writeDwg2000(make(2018)).data);
    expect(inB.unknownObjects?.[0]?.encoding).toBe(2018);
    expect(inB.unknownObjects?.[0]?.data).toBe(b64(PAYLOAD));
    const inA = readDwg(writeDwg2018(inB).data);
    expect(inA.unknownObjects?.[0]?.data).toBe(b64(PAYLOAD));
    expect(inA.unknownObjects?.[0]?.dataBits).toBe(PAYLOAD_BITS);
    expect(inA.unknownObjects?.[0]?.name).toBe('ACME_TABLE');
  });
});

/* ------------------------------------------------------------------ */

describe('a failed decode of a known type loses nothing', () => {
  it('rewinds and seals the record instead of dropping its payload', () => {
    /* A hand-built R2000 LINE record whose payload is truncated garbage:
       the LINE decoder runs off the record and throws; the sealed path
       must rewind to the start of the specific data and keep every bit. */
    const w = new BitWriter();
    w.bs(19);                             /* type: LINE */
    const sizeAt = w.pos;
    w.rl(0);                              /* bitsize, patched below */
    w.h(0, 5);                            /* handle */
    w.bs(0);                              /* no EED */
    w.b(0);                               /* no graphics */
    w.bb(2);                              /* entmode: model space */
    w.bl(0);                              /* reactors */
    w.b(0);                               /* nolinks = 0: chain present */
    w.bs(256);                            /* color: bylayer */
    w.bd(1);                              /* ltype scale */
    w.bb(0); w.bb(0);                     /* ltype, plotstyle flags */
    w.bs(0);                              /* invisible */
    w.rc(29);                             /* lineweight: bylayer */
    /* nine bits of truncated payload — far too short for a LINE */
    w.b(0); w.rc(0xA5);
    const bitsize = w.pos;
    w.patchRl(sizeAt, bitsize);
    /* handle stream: xdict, prev, next, layer — the common set */
    w.h(3, 0); w.h(4, 0); w.h(4, 0); w.h(5, 1);
    w.align();

    const raw = decodeObjectBody(w.bytes(), makeContext('R2000', new Map()));
    const e = raw?.entity as UnknownEntity | undefined;
    expect(e?.type).toBe('unknown');
    expect(e?.sourceType).toBe('LINE');
    expect(e?.typeCode).toBe(19);
    expect(e?.encoding).toBe(2000);
    expect(e?.dataBits).toBe(9);
    expect(e?.data).toBe(b64(Uint8Array.from([0x52, 0x80])));
  });
});

/* ------------------------------------------------------------------ */

describe('preserveHandles keeps sealed references valid forever', () => {
  it('entity handles and sealed refs are stable across rewrites', () => {
    const g1 = readDwg(writeDwg2018(baseDrawing()).data);
    const line1 = g1.entities.find((e) => e.type === 'line')!;
    const h1 = line1.handle!;

    /* a sealed record pointing at the line by its (gen-1) handle */
    g1.entities.push({
      ...sealedEntity(2018),
      refs: [{ code: 4, value: h1 }]
    } as Entity);

    const g2 = readDwg(writeDwg2018(g1, { preserveHandles: true }).data);
    const line2 = g2.entities.find((e) => e.type === 'line')!;
    const u2 = findUnknown(g2);
    expect(line2.handle).toBe(h1);               /* the line kept its number */
    expect(u2?.refs?.[0]?.value).toBe(h1);       /* the sealed ref still lands */

    const g3 = readDwg(writeDwg2018(g2, { preserveHandles: true }).data);
    expect(g3.entities.find((e) => e.type === 'line')?.handle).toBe(h1);
    expect(findUnknown(g3)?.refs?.[0]?.value).toBe(h1);
    expect(findUnknown(g3)?.handle).toBe(u2?.handle);
  });

  it('without the option the writer renumbers, as before', () => {
    const g1 = readDwg(writeDwg2018(baseDrawing()).data);
    const again = readDwg(writeDwg2018(g1).data);
    /* same drawing, no assertion on equality of handles — only that both
       decoded cleanly; renumbering is the default and stays valid */
    expect(again.warnings).toEqual([]);
    expect(again.entities.length).toBe(g1.entities.length);
  });
});
