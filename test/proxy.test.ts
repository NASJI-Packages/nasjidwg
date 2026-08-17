/* nasjidwg — proxy passthrough and OLE2FRAME write.
 *
 * A proxy is an object only its owning application understands. The claim
 * under test: a drawing that arrives with one leaves with the same one —
 * application payload bit-for-bit, cached display list byte-for-byte,
 * handle references code-for-code, and the original application class
 * still named in CLASSES — across every container this library writes.
 * The display list must also keep decoding to drawable geometry, so a
 * viewer shows the entity both before and after the round trip.
 *
 * Everything here is built by hand, token by token, the same way the
 * corpus builds its fixtures: nothing is lifted from another program's
 * output, so the test pins the format knowledge itself.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018,
  writeDwgR13, writeDwgR14
} from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, ProxyEntity, OleEntity } from '../src/core/model.js';

const WRITERS = {
  R13: writeDwgR13, R14: writeDwgR14, R2000: writeDwg2000,
  R2004: writeDwg2004, R2007: writeDwg2007, R2018: writeDwg2018
} as const;
type V = keyof typeof WRITERS;
const VERSIONS = Object.keys(WRITERS) as V[];

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

const REFS = [
  { code: 4, value: '2A' },
  { code: 3, value: '1F' },
  { code: 5, value: 'ABC' }
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
  d.layers = [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
  d.entities = [
    { type: 'line', layer: '0', color: { kind: 'byLayer' }, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } },
    sampleProxy()
  ] as Entity[];
  return d;
};

describe.each(VERSIONS)('proxy passthrough %s', (version) => {
  const { data, skipped, downgraded } = WRITERS[version](withProxy());
  const back = readDwg(data);
  const proxy = back.entities.find((e): e is ProxyEntity => e.type === 'proxy');

  it('writes without loss reports and reads without warnings', () => {
    expect(skipped).toEqual([]);
    expect(downgraded).toEqual([]);
    expect(back.warnings).toEqual([]);
  });

  it('keeps the proxy as a proxy, named after its application class', () => {
    expect(proxy).toBeTruthy();
    expect(proxy?.sourceType).toBe('MPOLYGON');
    if (version !== 'R13' && version !== 'R14') {
      /* R13/R14 have no CLASSES section to carry the names back out */
      expect(proxy?.appClass).toEqual({
        dxfName: 'MPOLYGON', cppName: 'AcDbMPolygon', appName: 'AcMPolygonObj15'
      });
    }
  });

  it('carries the application payload bit-for-bit', () => {
    expect(proxy?.dataBits).toBe(PAYLOAD_BITS);
    expect(proxy?.data).toBe(b64(PAYLOAD));
  });

  it('carries the version word and the origin flag', () => {
    expect(proxy?.proxyVersion).toBe(0x1c);
    if (version !== 'R13' && version !== 'R14') {
      expect(proxy?.fromDxf).toBe(false);
    }
  });

  it('keeps the handle references code-for-code', () => {
    expect(proxy?.refs).toEqual(REFS);
  });

  it('keeps the cached display list byte-for-byte and still draws it', () => {
    expect(proxy?.graphicsData).toBe(b64(displayList()));
    const circle = proxy?.graphics.find((g) => g.type === 'circle');
    const pline = proxy?.graphics.find((g) => g.type === 'polyline');
    expect(circle).toMatchObject({ center: { x: 1, y: 2, z: 0 }, radius: 2.5 });
    expect(pline?.vertices.length).toBe(3);
    expect(pline?.closed).toBe(false);
  });

  it('survives a second generation unchanged', () => {
    const again = readDwg(WRITERS[version](back).data);
    const p2 = again.entities.find((e): e is ProxyEntity => e.type === 'proxy');
    expect(p2?.data).toBe(proxy?.data);
    expect(p2?.dataBits).toBe(proxy?.dataBits);
    expect(p2?.refs).toEqual(proxy?.refs);
    expect(p2?.graphicsData).toBe(proxy?.graphicsData);
    expect(p2?.sourceType).toBe(proxy?.sourceType);
  });
});

/* ------------------------------------------------------------------ */

describe.each(VERSIONS)('proxy object passthrough %s', (version) => {
  const d = emptyDrawing();
  d.layers = [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
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
  const back = readDwg(WRITERS[version](d).data);
  const p = back.proxyObjects?.[0];

  it('keeps the object under its dictionary name', () => {
    expect(back.warnings).toEqual([]);
    expect(back.proxyObjects?.length).toBe(1);
    expect(p?.name).toBe('ACME_DATA');
    if (version !== 'R13' && version !== 'R14') {
      expect(p?.sourceType).toBe('ACME_HELPER');
      expect(p?.appClass?.appName).toBe('ACMEAPP|Product Desc');
    }
  });

  it('keeps the payload bit-for-bit and the references code-for-code', () => {
    expect(p?.data).toBe(b64(PAYLOAD));
    expect(p?.dataBits).toBe(PAYLOAD_BITS);
    expect(p?.refs).toEqual([{ code: 4, value: '12' }]);
  });

  it('survives a second generation unchanged', () => {
    const again = readDwg(WRITERS[version](back).data);
    expect(again.proxyObjects?.[0]?.data).toBe(p?.data);
    expect(again.proxyObjects?.[0]?.name).toBe(p?.name);
    expect(again.proxyObjects?.[0]?.refs).toEqual(p?.refs);
  });
});

/* ------------------------------------------------------------------ */

/** An OLE2FRAME payload: the 0x62-byte frame header (version word + four
 *  corner points) followed by a stand-in compound document. */
const olePayload = (): Uint8Array => {
  const doc = new TextEncoder().encode('D0CF11E0-compound-document-stand-in');
  const data = new Uint8Array(0x62 + doc.length);
  const dv = new DataView(data.buffer);
  dv.setUint16(0, 2, true);
  const corners = [[0, 5, 0], [10, 5, 0], [10, 0, 0], [0, 0, 0]];
  corners.forEach((c, i) => {
    dv.setFloat64(2 + i * 24, c[0], true);
    dv.setFloat64(10 + i * 24, c[1], true);
    dv.setFloat64(18 + i * 24, c[2], true);
  });
  data.set(doc, 0x62);
  return data;
};

const OLE_VERSIONS = VERSIONS.filter((v) => v !== 'R13');

describe.each(OLE_VERSIONS)('OLE2FRAME write %s', (version) => {
  const d = emptyDrawing();
  d.layers = [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
  const ole: OleEntity = {
    type: 'ole', layer: '0', color: { kind: 'byLayer' },
    oleType: 2, tileMode: 1, lockAspect: true,
    corners: [
      { x: 0, y: 5, z: 0 }, { x: 10, y: 5, z: 0 },
      { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }
    ],
    data: olePayload()
  };
  d.entities = [ole as Entity];
  const { data, skipped } = WRITERS[version](d);
  const back = readDwg(data);
  const got = back.entities.find((e): e is OleEntity => e.type === 'ole');

  it('round-trips the embedded document byte-for-byte', () => {
    expect(skipped).toEqual([]);
    expect(back.warnings).toEqual([]);
    expect(got).toBeTruthy();
    expect(Array.from(got!.data!)).toEqual(Array.from(olePayload()));
  });

  it('round-trips the frame', () => {
    expect(got?.oleType).toBe(2);
    expect(got?.corners[1]).toEqual({ x: 10, y: 5, z: 0 });
    if (version !== 'R14') {
      expect(got?.tileMode).toBe(1);
      expect(got?.lockAspect).toBe(true);
    }
  });

  it('synthesizes the frame header when an entity is built by hand', () => {
    const d2 = emptyDrawing();
    d2.layers = d.layers;
    d2.entities = [{
      type: 'ole', layer: '0', color: { kind: 'byLayer' },
      oleType: 3,
      corners: [
        { x: 1, y: 3, z: 0 }, { x: 7, y: 3, z: 0 },
        { x: 7, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }
      ]
    } as Entity];
    const round = readDwg(WRITERS[version](d2).data);
    const o2 = round.entities.find((e): e is OleEntity => e.type === 'ole');
    expect(o2?.oleType).toBe(3);
    expect(o2?.corners[0]).toEqual({ x: 1, y: 3, z: 0 });
    expect(o2?.corners[2]).toEqual({ x: 7, y: 1, z: 0 });
  });
});

/* ------------------------------------------------------------------ */

describe('the R13 writer is honest about OLE', () => {
  it('reports the OLE entity as skipped instead of writing a bad record', () => {
    const d = emptyDrawing();
    d.layers = [{
      name: '0', color: { kind: 'aci', index: 7 },
      on: true, frozen: false, locked: false
    }];
    d.entities = [{
      type: 'ole', layer: '0', color: { kind: 'byLayer' }, oleType: 2,
      corners: [
        { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 },
        { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }
      ]
    } as Entity];
    const { skipped } = writeDwgR13(d);
    expect(skipped).toEqual(['ole (needs R14 or later)']);
  });
});
