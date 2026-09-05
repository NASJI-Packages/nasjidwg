/* nasjidwg — the associative framework across the R2013 respelling.
 *
 * The facts pinned here were measured on the reference's own re-saves of
 * its samples (an R2018 original against its 2007/2010/2013/2018 saves,
 * three R2010 originals against theirs), record by record under the same
 * handle: AcDbAssocAction's class version 1 → 2 with four zero fields
 * closing the base; the geometry dependency's persistent sub-entity id
 * class as a text before R2013 and as `B 0, BL code` from it (1 the
 * single-edge class, 3 the edge class); the 2D constraint group's node
 * list — one `T class` per node before R2013, a table of distinct names
 * and `B 0, BL index, BL id` per node from it, the status byte moving
 * from before to after the connections, a circle's fourth real
 * appearing; the dependency records and bodies bit-identical. The
 * translator reproduced the reference's own saves bit for bit in both
 * directions (33 groups, 39 networks, 221 variables, 409 geometry
 * dependencies), and the writers use it: an R2018 source's family goes
 * natively into an AC1021 file and an R2010 source's into an AC1032 one.
 */

import { describe, expect, it } from 'vitest';
import { BitReader } from '../src/dwg/bitstream.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { isAssocKind, respellAssoc } from '../src/dwg/assoc.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2007, writeDwg2018 } from '../src/dwg/writer.js';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { readSections2007 } from '../src/dwg/sections2007.js';
import { readClasses } from '../src/dwg/classes.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, UnknownObject } from '../src/core/model.js';

/** The CLASSES version pair of a class in a written file. */
const classPair = (data: Uint8Array, v: 2007 | 2018, dxfName: string): string => {
  const secs = v === 2007 ? readSections2007(data) : readSections2004(data);
  const c = [...readClasses(secs.get('AcDb:Classes')!, v === 2007 ? 'R2007' : 'R2018').values()].find((x) => x.dxfName === dxfName);
  return c ? `${c.dwgVersion}/${c.maintVersion}` : '-';
};

const b64 = (w: BitWriter): string => Buffer.from(w.bytes()).toString('base64');
const bitsOf = (s: string | undefined, n: number | undefined): string => {
  const b = Buffer.from(s ?? '', 'base64');
  let out = '';
  for (let i = 0; i < (n ?? 0); i++) out += (b[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
};
const strings = (s: string | undefined, n: number | undefined): string[] => {
  if (!s || !n) return [];
  const r = new BitReader(new Uint8Array(Buffer.from(s, 'base64')), 0, n);
  const out: string[] = [];
  while (r.pos < n) { const len = r.bs(); let t = ''; for (let i = 0; i < len; i++) t += String.fromCharCode(r.rs()); out.push(t); }
  return out;
};
const stream = (...texts: string[]): { strData?: string; strBits?: number } => {
  if (!texts.length) return {};
  const w = new BitWriter();
  for (const t of texts) w.tu(t);
  return { strData: b64(w), strBits: w.pos };
};

/** AcDbAssocAction base: version, status, action index, max dep index,
 *  the dependency flags; the four R2013 fields when asked. */
const actionBase = (w: BitWriter, r2013: boolean, deps: number[] = []): void => {
  w.bs(r2013 ? 2 : 1); w.bl(0); w.bl(7); w.bl(3); w.bl(deps.length);
  for (const d of deps) w.b(d);
  if (r2013) { w.bs(0); w.bl(0); w.bs(0); w.bl(0); }
};

const network = (r2013: boolean): { data: string; dataBits: number } => {
  const w = new BitWriter();
  actionBase(w, r2013, [1, 0]);
  w.bs(0); w.bl(140); w.bl(3); w.b(0); w.b(0); w.b(1); w.bl(0);
  return { data: b64(w), dataBits: w.pos };
};

const geomDependency = (r2013: boolean, cls: 'single' | 'edge'): UnknownObject => {
  const w = new BitWriter();
  w.bs(2); w.bl(0); w.b(1); w.b(0); w.b(1); w.b(0); w.bl(-1); w.b(0); w.bl(-1);
  w.bs(0); w.b(1);
  if (r2013) { w.b(0); w.bl(cls === 'single' ? 1 : 3); }
  if (cls === 'edge') { w.bs(0); w.bl(3); w.bl(4); }
  w.b(0);
  return {
    sourceType: 'ACDBASSOCGEOMDEPENDENCY', encoding: r2013 ? 2018 : 2007,
    data: b64(w), dataBits: w.pos,
    ...(r2013 ? {} : stream(cls === 'single' ? 'AcDbAssocSingleEdgePersSubentId' : 'AcDbAssocEdgePersSubentId'))
  };
};

/** A three-node constraint group: a bounded line (geometry dependency
 *  D1), an implicit point on it, a fixed constraint; a second bounded
 *  line to repeat a class; a radius/diameter-free circle for the fourth
 *  real. Node order in the source: 3, 1, 2, 4, 5 (the reference's older
 *  files list nodes as their hash table happened to). */
interface Node { name: string; id: number; status: number; conns: number[]; body: (w: BitWriter, r2013: boolean) => void }
const groupNodes: Node[] = [
  { name: 'AcPointCurveConstraint', id: 3, status: 4, conns: [2, 1], body: (w) => { w.bl(0); w.b(1); w.b(1); } },
  { name: 'AcConstrainedBoundedLine', id: 1, status: 4, conns: [3, 5], body: (w) => { w.bl(0); w.bd3(0, 0, 0); w.bd3(1, 0, 0); w.b(0); w.bd3(0, 0, 0); w.bd3(110, 0, 0); } },
  { name: 'AcConstrainedImplicitPoint', id: 2, status: 4, conns: [3], body: (w) => { w.bl(0); w.rc(0); w.bl(-1); w.bl(1); } },
  { name: 'AcConstrainedBoundedLine', id: 4, status: 4, conns: [], body: (w) => { w.bl(0); w.bd3(5, 5, 0); w.bd3(0, 1, 0); w.b(0); w.bd3(5, 5, 0); w.bd3(5, 9, 0); } },
  { name: 'AcConstrainedCircle', id: 5, status: 4, conns: [1], body: (w, r2013) => { w.bl(0); w.bd3(2, 3, 0); w.bd3(0, 0, 1); w.bd3(1, 0, 0); w.bd(6); w.bd(0); w.bd(6.283185307179586); if (r2013) w.bd(0); } }
];
const group = (r2013: boolean, nodes: Node[] = groupNodes): UnknownObject => {
  const w = new BitWriter();
  actionBase(w, r2013);
  w.bl(2); w.b(0); w.bd3(0, 0, 0); w.bd3(1, 0, 0); w.bd3(0, 1, 0); w.bl(2); w.bl(77);
  const texts: string[] = [];
  if (r2013) {
    const distinct: string[] = [];
    for (const n of nodes) if (!distinct.includes(n.name)) distinct.push(n.name);
    w.bl(0); w.bl(0); w.b(0);
    w.bl(distinct.length); w.bl(nodes.length);
    for (const n of nodes) { w.b(0); w.bl(distinct.indexOf(n.name) + 1); w.bl(n.id); }
    for (const n of nodes) { w.bl(n.id); w.bl(n.conns.length); for (const c of n.conns) w.bl(c); w.rc(n.status); n.body(w, true); }
    texts.push(...distinct);
  } else {
    w.bl(nodes.length);
    for (const n of nodes) { w.bl(n.id); w.rc(n.status); w.bl(n.conns.length); for (const c of n.conns) w.bl(c); n.body(w, false); texts.push(n.name); }
  }
  /* the handle stream: owner, body, the group's own, two dependencies,
     then one per geometry node (the constraint nodes carry none) */
  const refs = [{ code: 4, value: 'A1' }, { code: 3, value: '0' }, { code: 3, value: '0' },
    { code: 3, value: 'D1' }, { code: 3, value: 'D2' }];
  for (const n of nodes) {
    if (n.name === 'AcConstrainedBoundedLine') refs.push({ code: 4, value: 'D1' });
    if (n.name === 'AcConstrainedImplicitPoint') refs.push({ code: 4, value: '0' });
    if (n.name === 'AcConstrainedCircle') refs.push({ code: 4, value: 'D2' });
  }
  return {
    sourceType: 'ACDBASSOC2DCONSTRAINTGROUP', encoding: r2013 ? 2018 : 2007,
    data: b64(w), dataBits: w.pos, refs, ...stream(...texts)
  };
};

describe('respellAssoc', () => {
  it('names the family', () => {
    for (const k of ['ACDBASSOCNETWORK', 'ASSOCDIMDEPENDENCYBODY', 'BLOCKPARAMDEPENDENCYBODY', 'ACDBASSOCVARIABLE']) expect(isAssocKind(k)).toBe(true);
    for (const k of ['FIELD', 'BLOCKLINEARPARAMETER', 'DICTIONARY']) expect(isAssocKind(k)).toBe(false);
  });

  it('a network: version 1 ↔ 2 with the four zero fields, the rest verbatim', () => {
    const pre = network(false), r13 = network(true);
    expect(r13.dataBits).toBe(pre.dataBits + 8);
    const up = respellAssoc('ACDBASSOCNETWORK', pre, 'pre2013', 'r2013');
    expect(up?.data).toBe(r13.data);
    expect(up?.dataBits).toBe(r13.dataBits);
    const down = respellAssoc('ACDBASSOCNETWORK', r13, 'r2013', 'pre2013');
    expect(down?.data).toBe(pre.data);
    expect(down?.dataBits).toBe(pre.dataBits);
    /* the same spelling: the record itself */
    expect(respellAssoc('ACDBASSOCNETWORK', pre, 'pre2013', 'pre2013')).toBe(pre);
  });

  it('a network with owned parameters or values cannot cross to the older spelling', () => {
    const w = new BitWriter();
    w.bs(2); w.bl(0); w.bl(7); w.bl(3); w.bl(0); w.bs(0); w.bl(1); w.bs(0); w.bl(0);
    w.bs(0); w.bl(1); w.bl(0); w.bl(0);
    expect(respellAssoc('ACDBASSOCNETWORK', { data: b64(w), dataBits: w.pos }, 'r2013', 'pre2013')).toBeNull();
  });

  it.each([['single', 1], ['edge', 3]] as const)('a geometry dependency: the %s persistent id as a text ↔ code %d', (cls) => {
    const pre = geomDependency(false, cls), r13 = geomDependency(true, cls);
    const up = respellAssoc('ACDBASSOCGEOMDEPENDENCY', pre, 'pre2013', 'r2013');
    expect(bitsOf(up?.data, up?.dataBits)).toBe(bitsOf(r13.data, r13.dataBits));
    expect(up?.strBits).toBeUndefined();
    const down = respellAssoc('ACDBASSOCGEOMDEPENDENCY', r13, 'r2013', 'pre2013');
    expect(bitsOf(down?.data, down?.dataBits)).toBe(bitsOf(pre.data, pre.dataBits));
    expect(strings(down?.strData, down?.strBits)).toEqual(strings(pre.strData, pre.strBits));
  });

  it('a geometry dependency of an unknown persistent id class stays as it is', () => {
    const pre = geomDependency(false, 'single');
    const odd = { ...pre, ...stream('AcDbAssocAsmBasedEntityPersSubentId') };
    expect(respellAssoc('ACDBASSOCGEOMDEPENDENCY', odd, 'pre2013', 'r2013')).toBeNull();
    const w = new BitWriter();
    w.bs(2); w.bl(0); w.b(1); w.b(0); w.b(1); w.b(0); w.bl(-1); w.b(0); w.bl(-1); w.bs(0); w.b(1); w.b(0); w.bl(9); w.b(0);
    expect(respellAssoc('ACDBASSOCGEOMDEPENDENCY', { data: b64(w), dataBits: w.pos }, 'r2013', 'pre2013')).toBeNull();
  });

  it('a constraint group: node names per node ↔ a name table, the status byte moved, nodes in id order', () => {
    const pre = group(false), r13 = group(true);
    const sorted = [...groupNodes].sort((a, b) => a.id - b.id);
    const up = respellAssoc('ACDBASSOC2DCONSTRAINTGROUP', pre, 'pre2013', 'r2013');
    expect(up).not.toBeNull();
    const want = group(true, sorted);
    expect(bitsOf(up?.data, up?.dataBits)).toBe(bitsOf(want.data, want.dataBits));
    expect(strings(up?.strData, up?.strBits)).toEqual(['AcConstrainedBoundedLine', 'AcConstrainedImplicitPoint', 'AcPointCurveConstraint', 'AcConstrainedCircle']);
    const down = respellAssoc('ACDBASSOC2DCONSTRAINTGROUP', r13, 'r2013', 'pre2013');
    const wantDown = group(false, sorted);
    expect(bitsOf(down?.data, down?.dataBits)).toBe(bitsOf(wantDown.data, wantDown.dataBits));
    expect(strings(down?.strData, down?.strBits)).toEqual(sorted.map((n) => n.name));
    /* and back again: a fixed point once sorted */
    const again = respellAssoc('ACDBASSOC2DCONSTRAINTGROUP', down!, 'pre2013', 'r2013');
    expect(again?.data).toBe(up?.data);
    expect(again?.strData).toBe(up?.strData);
  });

  it('a constraint group with an unknown node class, or a walk that misses the last bit, is refused', () => {
    const odd = group(false, [{ ...groupNodes[0], name: 'AcSomethingElseConstraint' }]);
    expect(respellAssoc('ACDBASSOC2DCONSTRAINTGROUP', odd, 'pre2013', 'r2013')).toBeNull();
    const pre = group(false);
    const short = { ...pre, dataBits: pre.dataBits! - 3 };
    expect(respellAssoc('ACDBASSOC2DCONSTRAINTGROUP', short, 'pre2013', 'r2013')).toBeNull();
  });

  it('the kinds spelled alike pass through; an unknown kind of the family is refused', () => {
    const rec = { data: 'AA==', dataBits: 5 };
    expect(respellAssoc('ACDBASSOCDEPENDENCY', rec, 'pre2013', 'r2013')).toBe(rec);
    expect(respellAssoc('BLOCKPARAMDEPENDENCYBODY', rec, 'r2013', 'pre2013')).toBe(rec);
    expect(respellAssoc('ACDBASSOCARRAYACTIONBODY', rec, 'r2013', 'pre2013')).toBeNull();
  });
});

describe('the writers carry the family across the respelling', () => {
  const drawingWith = (version: 'R2018' | 'R2010' | 'R2007', encoding: number, r2013: boolean): Drawing => {
    const d = emptyDrawing();
    d.header.version = version;
    d.structureHandles = { NOD: 'C' };
    d.layers = [{ name: '0', color: { kind: 'aci', index: 7 }, on: true, frozen: false, locked: false }];
    d.entities = [{ type: 'line', handle: 'A0', layer: '0', color: { kind: 'byLayer' }, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }];
    const net: UnknownObject = {
      handle: 'E0', ownerHandle: 'C', name: 'ACAD_ASSOCNETWORK', sourceType: 'ACDBASSOCNETWORK', encoding,
      appClass: { dxfName: 'ACDBASSOCNETWORK', cppName: 'AcDbAssocNetwork', appName: 'ObjectDBX Classes' },
      ...network(r2013), refs: [{ code: 4, value: '0' }, { code: 3, value: '0' }, { code: 4, value: 'E1' }, { code: 4, value: 'E2' }, { code: 4, value: 'E3' }]
    };
    d.unknownObjects = [net, {
      ...geomDependency(r2013, 'single'), handle: 'E4', ownerHandle: 'E0', encoding,
      appClass: {
        dxfName: 'ACDBASSOCGEOMDEPENDENCY', cppName: 'AcDbAssocGeomDependency', appName: 'ObjectDBX Classes',
        dwgVersion: 27, maintVersion: r2013 ? 175 : 50
      },
      refs: [{ code: 3, value: 'A0' }, { code: 4, value: '0' }, { code: 3, value: '0' }, { code: 4, value: '0' }]
    }];
    return d;
  };
  const sealOf = (d: Drawing, h: string): UnknownObject | undefined => d.unknownObjects?.find((u) => u.handle === h);

  it('an R2018 source into AC1021: the R2010 spelling, native, under the 27/50 class pair, and back again', () => {
    const d = drawingWith('R2018', 2018, true);
    const res = writeDwg2007(d, { preserveHandles: true, respellAssoc: true });
    expect(res.skipped).toEqual([]);
    expect(classPair(res.data, 2007, 'ACDBASSOCGEOMDEPENDENCY')).toBe('27/50');
    const back = readDwg(res.data);
    const net = sealOf(back, 'E0');
    expect(net?.encoding).toBe(2007);
    expect(bitsOf(net?.data, net?.dataBits)).toBe(bitsOf(network(false).data, network(false).dataBits));
    const dep = sealOf(back, 'E4');
    expect(strings(dep?.strData, dep?.strBits)).toEqual(['AcDbAssocSingleEdgePersSubentId']);
    expect(dep?.appClass).toMatchObject({ dwgVersion: 27, maintVersion: 50 });
    /* the 2007 file into 2018: the R2013 spelling again, under 27/175 */
    const again = writeDwg2018(back, { preserveHandles: true, respellAssoc: true });
    expect(classPair(again.data, 2018, 'ACDBASSOCGEOMDEPENDENCY')).toBe('27/175');
    const up = readDwg(again.data);
    expect(bitsOf(sealOf(up, 'E0')?.data, sealOf(up, 'E0')?.dataBits)).toBe(bitsOf(network(true).data, network(true).dataBits));
    expect(sealOf(up, 'E4')?.strBits).toBeUndefined();
  });

  it('an R2010 source into AC1032: the family no longer stays home, the dependency class re-paired', () => {
    const d = drawingWith('R2010', 2018, false);
    const res = writeDwg2018(d, { preserveHandles: true, respellAssoc: true });
    expect(res.skipped).toEqual([]);
    expect(classPair(res.data, 2018, 'ACDBASSOCGEOMDEPENDENCY')).toBe('27/175');
    const back = readDwg(res.data);
    expect(bitsOf(sealOf(back, 'E0')?.data, sealOf(back, 'E0')?.dataBits)).toBe(bitsOf(network(true).data, network(true).dataBits));
  });

  it('a record the translator refuses leaves the family as it was (home, reported)', () => {
    const d = drawingWith('R2010', 2018, false);
    d.unknownObjects![1] = { ...d.unknownObjects![1], ...stream('AcDbAssocIndexPersSubentId') };
    const res = writeDwg2018(d, { preserveHandles: true, respellAssoc: true });
    expect(res.skipped.some((s) => /R2010 record; its R2013 spelling differs/.test(s))).toBe(true);
  });
});
