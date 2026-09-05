/* nasjidwg — sealed proxy passthrough through DXF.
 *
 * The DWG suite (test/proxy.test.ts) already proves a proxy survives every
 * DWG container. This suite makes the same claim for DXF — and then the
 * stronger one: sealed data survives ANY path through the library. A
 * drawing written to DXF, read back, written to DWG and read again still
 * carries the application payload bit-for-bit, the display list
 * byte-for-byte, the references code-for-code and the application class
 * by name; and the reverse route holds too.
 *
 * The fixtures are built by hand, token by token — nothing is lifted from
 * another program's output, so the tests pin the format knowledge itself.
 */

import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf, writeDxfBinary } from '../src/dxf/writer.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, ProxyEntity } from '../src/core/model.js';

const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

/** A display list in the proxy-graphics grammar src/dwg/proxy.ts decodes:
 *  overall size, count, then per primitive [size, type, payload]. One
 *  circle and one open polyline. */
const displayList = (): Uint8Array => {
  const out: number[] = [];
  const i32 = (v: number): void => {
    out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const f64 = (v: number): void => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    out.push(...b);
  };
  i32(132);                               /* overall size */
  i32(2);                                 /* primitive count */
  i32(40); i32(2);                        /* circle: size, kind */
  f64(1); f64(2); f64(0);                 /* center */
  f64(2.5);                               /* radius */
  i32(84); i32(6);                        /* polyline: size, kind */
  i32(3);                                 /* vertex count */
  f64(0); f64(0); f64(0);
  f64(4); f64(0); f64(0);
  f64(4); f64(3); f64(0);
  return Uint8Array.from(out);
};

/** The opaque application payload: 53 bits, deliberately not a whole
 *  number of bytes, so byte-aligned handling would corrupt it. The bits
 *  past 53 in the last byte are zero, exactly as a bit-capture leaves
 *  them. */
const PAYLOAD = Uint8Array.from([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0xE0]);
const PAYLOAD_BITS = 53;

/* Only codes 3 (hard) and 4 (soft) exist in DXF's reference vocabulary —
   330 carries the soft ones and 340 the hard ones — so these are the
   codes that survive the trip unchanged. */
const REFS = [
  { code: 4, value: '2A' },
  { code: 3, value: '1F' }
];

const sampleProxy = (): ProxyEntity => ({
  type: 'proxy', layer: '0', color: { kind: 'byLayer' },
  sourceType: 'MPOLYGON',
  graphics: [],
  appClass: {
    dxfName: 'MPOLYGON', cppName: 'AcDbMPolygon', appName: 'AcMPolygonObj15'
  },
  proxyVersion: 0x1c,
  fromDxf: false,
  data: b64(PAYLOAD),
  dataBits: PAYLOAD_BITS,
  graphicsData: b64(displayList()),
  refs: REFS.map((r) => ({ ...r }))
});

const withProxy = (): Drawing => {
  const d = emptyDrawing();
  d.entities = [
    { type: 'line', layer: '0', color: { kind: 'byLayer' }, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } },
    sampleProxy()
  ] as Entity[];
  return d;
};

const findProxy = (d: Drawing): ProxyEntity | undefined =>
  d.entities.find((e): e is ProxyEntity => e.type === 'proxy');

/** The whole claim in one assertion set, reused by every route. */
const expectSealed = (proxy: ProxyEntity | undefined): void => {
  expect(proxy).toBeTruthy();
  expect(proxy?.sourceType).toBe('MPOLYGON');
  /* a DWG leg adds the class's version pair beside the names */
  expect(proxy?.appClass).toMatchObject({
    dxfName: 'MPOLYGON', cppName: 'AcDbMPolygon', appName: 'AcMPolygonObj15'
  });
  expect(proxy?.data).toBe(b64(PAYLOAD));
  expect(proxy?.dataBits).toBe(PAYLOAD_BITS);
  expect(proxy?.refs).toEqual(REFS);
  expect(proxy?.graphicsData).toBe(b64(displayList()));
  expect(proxy?.proxyVersion).toBe(0x1c);
  expect(proxy?.fromDxf).toBe(false);
};

/** The display list must keep decoding, not just travelling. */
const expectDrawable = (proxy: ProxyEntity | undefined): void => {
  const circle = proxy?.graphics.find((g) => g.type === 'circle');
  const pline = proxy?.graphics.find((g) => g.type === 'polyline');
  expect(circle).toMatchObject({ center: { x: 1, y: 2, z: 0 }, radius: 2.5 });
  expect(pline?.vertices.length).toBe(3);
  expect(pline?.closed).toBe(false);
};

describe('sealed proxy through ASCII DXF', () => {
  const round = readDxf(writeDxf(withProxy()));
  const proxy = findProxy(round);

  it('round-trips every sealed field', () => {
    expectSealed(proxy);
  });

  it('still draws: the display list decodes to the circle and polyline', () => {
    expectDrawable(proxy);
  });

  it('keeps the line beside it', () => {
    expect(round.entities.some((e) => e.type === 'line')).toBe(true);
  });
});

describe('sealed proxy through binary DXF', () => {
  /* the binary writer shares the group emitter with the ASCII one; the
     310 chunks stay under a binary chunk's one-byte length prefix */
  const round = readDxf(writeDxfBinary(withProxy()));
  const proxy = findProxy(round);

  it('round-trips every sealed field', () => {
    expectSealed(proxy);
  });

  it('still draws after the binary trip', () => {
    expectDrawable(proxy);
  });
});

describe('cross-codec: DXF first, then DWG', () => {
  /* writeDxf -> readDxf -> writeDwg2018 -> readDwg: what came in through
     one codec leaves intact through the other */
  const viaDxf = readDxf(writeDxf(withProxy()));
  const { data, skipped } = writeDwg2018(viaDxf);
  const finalDrawing = readDwg(data);
  const proxy = findProxy(finalDrawing);

  it('writes the DWG without loss reports', () => {
    expect(skipped).toEqual([]);
  });

  it('round-trips every sealed field across both codecs', () => {
    expectSealed(proxy);
  });

  it('still draws at the far end', () => {
    expectDrawable(proxy);
  });
});

describe('cross-codec: DWG first, then DXF', () => {
  /* writeDwg2018 -> readDwg -> writeDxf -> readDxf: the reverse route */
  const viaDwg = readDwg(writeDwg2018(withProxy()).data);
  const finalDrawing = readDxf(writeDxf(viaDwg));
  const proxy = findProxy(finalDrawing);

  it('round-trips every sealed field across both codecs', () => {
    expectSealed(proxy);
  });

  it('still draws at the far end', () => {
    expectDrawable(proxy);
  });
});

describe('proxy objects through DXF', () => {
  const d = emptyDrawing();
  d.entities = [{
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
  } as Entity];
  d.proxyObjects = [{
    name: 'ACME_DATA',
    sourceType: 'ACME_HELPER',
    appClass: {
      dxfName: 'ACME_HELPER', cppName: 'AcmeHelper',
      appName: 'ACMEAPP|Product Desc'
    },
    proxyVersion: 2,
    fromDxf: false,
    data: b64(PAYLOAD),
    dataBits: PAYLOAD_BITS,
    refs: [{ code: 4, value: '12' }]
  }];
  const round = readDxf(writeDxf(d));
  const p = round.proxyObjects?.[0];

  it('keeps the object under its dictionary name', () => {
    expect(round.proxyObjects?.length).toBe(1);
    expect(p?.name).toBe('ACME_DATA');
    expect(p?.sourceType).toBe('ACME_HELPER');
    expect(p?.appClass).toEqual({
      dxfName: 'ACME_HELPER', cppName: 'AcmeHelper',
      appName: 'ACMEAPP|Product Desc'
    });
  });

  it('keeps the payload bit-for-bit and the references code-for-code', () => {
    expect(p?.data).toBe(b64(PAYLOAD));
    expect(p?.dataBits).toBe(PAYLOAD_BITS);
    expect(p?.refs).toEqual([{ code: 4, value: '12' }]);
    expect(p?.proxyVersion).toBe(2);
    expect(p?.fromDxf).toBe(false);
  });

  it('survives a second DXF generation unchanged', () => {
    const again = readDxf(writeDxf(round)).proxyObjects?.[0];
    expect(again?.name).toBe(p?.name);
    expect(again?.data).toBe(p?.data);
    expect(again?.dataBits).toBe(p?.dataBits);
    expect(again?.refs).toEqual(p?.refs);
  });
});

describe('an R2007-filer proxy object with a string stream through DXF', () => {
  /* Measured on the reference with a proxy of a class it lacks, written
     by us into 2007 and 2018 DWGs (data 87 bits, string stream "cn:AcmeNote",
     "hello world", "" = 374 bits): its own 2018 DXF spells the strings past
     "cn:" apart (162 = 188, 311 hex) and the data under 161/310; our DXF
     closes the 93/310 payload with those strings, their size word and the
     flag (93 = 87 + 188 + 17 = 292), which it opens at AUDIT 0 and DXFOUTs
     with the same 161/162; readDxf gives the same data and string stream
     back from either spelling. */
  const bits = (w: BitWriter): { data: string; dataBits: number } => ({ data: b64(w.bytes()), dataBits: w.pos });
  const payload = new BitWriter();
  payload.bl(7); payload.bd(2.5); payload.bs(3); payload.b(1);
  const stream = new BitWriter();
  stream.tu('cn:AcmeNote'); stream.tu('hello world'); stream.tu('');
  const d = emptyDrawing();
  d.header.version = 'R2007';
  d.structureHandles = { NOD: 'C' };
  d.entities = [{
    type: 'line', handle: 'A0', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
  } as Entity];
  d.proxyObjects = [{
    handle: 'E1', ownerHandle: 'C', name: 'ACME_NOTE_1', sourceType: 'ACME_NOTE',
    appClass: { dxfName: 'ACME_NOTE', cppName: 'AcmeNote', appName: 'ACME', dwgVersion: 27, maintVersion: 50 },
    proxyVersion: 27, proxyMaint: 50, fromDxf: false,
    ...bits(payload), strData: b64(stream.bytes()), strBits: stream.pos,
    refs: [{ code: 5, value: 'A0' }]
  }];
  const text = writeDxf(d, { preserveHandles: true });

  it('closes the payload with the strings past "cn:", their size and the flag', () => {
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => l.trim() === 'ACAD_PROXY_OBJECT');
    const i93 = lines.findIndex((l, i) => i > at && l.trim() === '93');
    expect(lines[i93 + 1].trim()).toBe(String(payload.pos + (stream.pos - (10 + 16 * 'cn:AcmeNote'.length)) + 16 + 1));
    expect(lines[i93 + 1].trim()).toBe('292');
  });

  it('reads back as the same proxy object, string stream included', () => {
    const p = readDxf(text).proxyObjects?.[0];
    expect(p?.sourceType).toBe('ACME_NOTE');
    expect(p?.proxyVersion).toBe(27);
    expect(p?.proxyMaint).toBe(50);
    expect(p?.data).toBe(b64(payload.bytes()));
    expect(p?.dataBits).toBe(payload.pos);
    expect(p?.strData).toBe(b64(stream.bytes()));
    expect(p?.strBits).toBe(stream.pos);
    expect(p?.refs).toEqual([{ code: 5, value: 'A0' }]);
    /* and again: the same proxy record (past its owner group — the root
       dictionary is numbered by each writer for itself) */
    const record = (t: string): string => {
      const lines = t.split(/\r?\n/);
      const at = lines.findIndex((l) => l.trim() === 'ACAD_PROXY_OBJECT');
      const end = lines.findIndex((l, i) => i > at && l.trim() === '0');
      const body = lines.slice(at, end);
      const owner = body.findIndex((l) => l.trim() === '330');
      return [...body.slice(0, owner), ...body.slice(owner + 2)].join('\n');
    };
    expect(record(writeDxf(readDxf(text), { preserveHandles: true }))).toBe(record(text));
  });

  it('reads the reference\'s own 2018 spelling of the same record back the same', () => {
    const hex = (w: BitWriter, from = 0): string => {
      const out = new BitWriter();
      const bytes = w.bytes();
      for (let i = from; i < w.pos; i++) out.b((bytes[i >> 3] >> (7 - (i & 7))) & 1);
      return Buffer.from(out.bytes()).toString('hex').toUpperCase();
    };
    const cnBits = 10 + 16 * 'cn:AcmeNote'.length;
    const ref = [
      '0', 'SECTION', '2', 'CLASSES',
      '0', 'CLASS', '1', 'ACME_NOTE', '2', 'AcmeNote', '3', 'ACME', '90', '0', '91', '1', '280', '0', '281', '0',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'OBJECTS',
      '0', 'ACAD_PROXY_OBJECT', '5', 'E1', '330', 'C', '100', 'AcDbProxyObject',
      '90', '499', '91', '500', '71', '27', '97', '50', '70', '0',
      '162', String(stream.pos - cnBits), '311', hex(stream, cnBits),
      '161', String(payload.pos), '310', hex(payload),
      '340', 'A0', '94', '0',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\n');
    const p = readDxf(ref).proxyObjects?.[0];
    expect(p?.data).toBe(b64(payload.bytes()));
    expect(p?.dataBits).toBe(payload.pos);
    expect(p?.strData).toBe(b64(stream.bytes()));
    expect(p?.strBits).toBe(stream.pos);
  });
});

describe('a bare proxy keeps the old explode behavior', () => {
  /* no sealed payload means nothing to pass through: the decoded picture
     is written as plain entities, exactly as before */
  const d = emptyDrawing();
  d.entities = [{
    type: 'proxy', layer: '0', color: { kind: 'byLayer' },
    sourceType: 'SOMETHING',
    graphics: [{
      type: 'circle', layer: '0', color: { kind: 'byLayer' },
      center: { x: 3, y: 4, z: 0 }, radius: 1.5
    }]
  } as Entity];
  const round = readDxf(writeDxf(d));

  it('explodes to its graphics instead of a proxy record', () => {
    expect(findProxy(round)).toBeUndefined();
    const c = round.entities.find((e) => e.type === 'circle');
    expect(c).toMatchObject({ center: { x: 3, y: 4, z: 0 }, radius: 1.5 });
  });
});
