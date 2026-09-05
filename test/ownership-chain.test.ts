/* nasjidwg — the ownership-preserving passthrough.
 *
 * A sealed object goes out under its ORIGINAL owner when that owner is
 * written, and only a record whose owner is not in the file is re-homed
 * under the named objects dictionary. Pinned here on the smallest chain
 * the reference checks: an entity's extension dictionary (sealed, its
 * entries decoded) listing an XRECORD (sealed, bit-exact).
 *
 *   entity --xdict--> DICTIONARY --ACAD_XREC_ROUNDTRIP--> XRECORD
 *
 * Under preserveHandles every link keeps its source number through any
 * number of rewrites. Without it the numbering moves: the dictionary
 * follows its entity (re-encoded from its entries), while the XRECORD —
 * whose data may name handles the renumbering cannot follow — stays home
 * and says so; a dictionary left with nothing written to list is dropped
 * quietly, and the entity carries no pointer into nothing.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2007, writeDwg2018 } from '../src/dwg/writer.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, UnknownObject } from '../src/core/model.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** An XRECORD body as R2007+ spell it: a byte-counted run of (RS group,
 *  value) — one string group, code 1, "AB" in UTF-16 — then the cloning
 *  flag. */
const xrecordBits = (): { data: string; dataBits: number } => {
  const w = new BitWriter();
  w.bl(8);
  w.rs(1); w.rs(2); w.rs(0x41); w.rs(0x42);
  w.bs(1);
  return { data: b64(w.bytes()), dataBits: w.pos };
};

const chainDrawing = (encoding: number): Drawing => {
  const d = emptyDrawing();
  d.layers = [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
  d.entities = [{
    type: 'line', handle: 'A0', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 },
    xdict: 'B0'
  } as Entity];
  d.unknownObjects = [
    {
      handle: 'B0', ownerHandle: 'A0', sourceType: 'DICTIONARY', typeCode: 42,
      encoding, hardOwner: true, cloning: 1,
      entries: [{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'C0', code: 3 }]
    },
    {
      handle: 'C0', ownerHandle: 'B0', sourceType: 'XRECORD', typeCode: 79,
      encoding, ...xrecordBits()
    }
  ];
  return d;
};

const kindOf = (u: UnknownObject): string =>
  (u.appClass?.dxfName ?? u.sourceType).toUpperCase();

describe.each([
  ['R2018', writeDwg2018, 2018],
  ['R2007', writeDwg2007, 2007]
] as const)('an extension-dictionary chain through %s', (_v, writer, encoding) => {
  it('keeps the entity, its dictionary and the record wired under preserveHandles', () => {
    const res = writer(chainDrawing(encoding), { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    const line = back.entities[0];
    expect(line.handle).toBe('A0');
    expect(line.xdict).toBe('B0');
    const sealed = back.unknownObjects ?? [];
    const dict = sealed.find((u) => u.handle === 'B0');
    const rec = sealed.find((u) => u.handle === 'C0');
    expect(dict && kindOf(dict)).toBe('DICTIONARY');
    expect(dict?.ownerHandle).toBe('A0');
    expect(dict?.hardOwner).toBe(true);
    expect(dict?.entries).toEqual([{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'C0', code: 3 }]);
    expect(rec && kindOf(rec)).toBe('XRECORD');
    expect(rec?.ownerHandle).toBe('B0');
    /* the record's bits are intact: the reader decodes them as well */
    expect(back.xrecords?.find((x) => x.handle === 'C0')?.values)
      .toEqual([{ code: 1, value: 'AB' }]);
    /* nothing of the chain was re-homed under the named objects tree */
    expect(dict?.dictPath).toBeUndefined();
    expect(rec?.dictPath).toBeUndefined();
  });

  it('survives a second preserved generation unchanged', () => {
    const once = readDwg(writer(chainDrawing(encoding), { preserveHandles: true }).data);
    const again = writer(once, { preserveHandles: true });
    expect(again.skipped).toEqual([]);
    const twice = readDwg(again.data);
    expect(twice.entities[0].xdict).toBe('B0');
    /* (the writer's own named-object sub-dictionaries come back sealed
       with a dictPath of their own; the chain is what hangs off the
       entity, without one) */
    const sealed = (twice.unknownObjects ?? []).filter((u) => u.dictPath === undefined);
    expect(sealed.map((u) => [kindOf(u), u.handle, u.ownerHandle]).sort())
      .toEqual([['DICTIONARY', 'B0', 'A0'], ['XRECORD', 'C0', 'B0']]);
  });

  it('without preserveHandles the record stays home, honestly, and nothing dangles', () => {
    const res = writer(chainDrawing(encoding));
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatch(/^XRECORD \(its data may name handles/);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    /* the dictionary had nothing written left to list: dropped quietly,
       and the entity carries no pointer into nothing */
    expect(back.entities[0].xdict).toBeUndefined();
    expect((back.unknownObjects ?? []).filter((u) => u.dictPath === undefined)).toEqual([]);
  });
});

describe('the chained kinds without their owner', () => {
  it('a constraint network whose owner is not in the file stays home by kind', () => {
    const d = chainDrawing(2018);
    (d.unknownObjects ??= []).push({
      handle: 'D0', ownerHandle: 'FFF0', sourceType: 'ACDBASSOCNETWORK',
      appClass: {
        dxfName: 'ACDBASSOCNETWORK', cppName: 'AcDbAssocNetwork',
        appName: 'ObjectDBX Classes'
      },
      encoding: 2018, data: 'gA==', dataBits: 2
    });
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual(['ACDBASSOCNETWORK']);
    const back = readDwg(res.data);
    expect((back.unknownObjects ?? []).some((u) => kindOf(u) === 'ACDBASSOCNETWORK')).toBe(false);
  });

  it('a field under its entity travels; the same field re-homed when the entity is gone', () => {
    const field = (): UnknownObject => ({
      handle: 'E0', ownerHandle: 'B0', sourceType: 'FIELD',
      appClass: { dxfName: 'FIELD', cppName: 'AcDbField', appName: 'ObjectDBX Classes' },
      encoding: 2018, data: 'gA==', dataBits: 2
    });
    const d = chainDrawing(2018);
    d.unknownObjects![0].entries!.push({ name: 'ACAD_FIELD', handle: 'E0', code: 3 });
    d.unknownObjects!.push(field());
    const back = readDwg(writeDwg2018(d, { preserveHandles: true }).data);
    const f = (back.unknownObjects ?? []).find((u) => u.handle === 'E0');
    expect(f?.ownerHandle).toBe('B0');
    expect(f?.dictPath).toBeUndefined();
    /* the entity gone: its extension dictionary cannot be attached, and
       a field without its entity is nothing — the whole chain stays
       home rather than being re-homed into a dictionary that never
       listed it, and the loss is reported once, at its root */
    const orphan = chainDrawing(2018);
    orphan.entities = [];
    orphan.unknownObjects![0].entries!.push({ name: 'ACAD_FIELD', handle: 'E0', code: 3 });
    orphan.unknownObjects!.push(field());
    const res = writeDwg2018(orphan, { preserveHandles: true });
    expect(res.skipped).toEqual(['DICTIONARY (extension dictionary of an object not written)']);
    const back2 = readDwg(res.data);
    expect((back2.unknownObjects ?? []).some((u) => u.handle === 'E0')).toBe(false);
    expect((back2.unknownObjects ?? []).some((u) => u.handle === 'C0')).toBe(false);
  });
});
