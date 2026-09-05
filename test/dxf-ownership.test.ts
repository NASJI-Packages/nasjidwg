/* nasjidwg — the DXF codec's ownership-preserving passthrough.
 *
 * The DWG side keeps every sealed object under its original owner; the
 * DXF side now does the same. Pinned here on the smallest chain the
 * reference checks — an entity's extension dictionary listing an
 * XRECORD:
 *
 *   entity --xdict--> DICTIONARY --ACAD_XREC_ROUNDTRIP--> XRECORD
 *
 * Under `preserveHandles` every link keeps its source number, so a
 * sealed body's verbatim handle groups stay true. Without it the file is
 * renumbered from 0x100 and every handle-typed group of a sealed body
 * (320–369, a 1005) is remapped through the output's numbering, nulled
 * when its target is not written; a hard reference into nothing keeps
 * the record home. The reader captures the same facts a DWG read
 * carries (xdict, reactors, dictionary entries, the XRECORD's owner —
 * with its DWG bits from an R2007+ source), so a DXF-read chain rides
 * into a DWG under preserveHandles the way a DWG-read one does. */

import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, UnknownObject } from '../src/core/model.js';

/** The records of a written DXF: type and groups, in file order. */
const recordsOf = (text: string): { type: string; groups: [number, string][] }[] => {
  const lines = text.split('\n');
  const recs: { type: string; groups: [number, string][] }[] = [];
  let cur: { type: string; groups: [number, string][] } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i], 10);
    if (c === 0) { cur = { type: lines[i + 1], groups: [] }; recs.push(cur); }
    else if (cur) cur.groups.push([c, lines[i + 1]]);
  }
  return recs;
};
const groupOf = (r: { groups: [number, string][] }, code: number): string | undefined =>
  r.groups.find(([c]) => c === code)?.[1];
const ownHandle = (r: { groups: [number, string][] }): string | undefined => {
  const at = r.groups.findIndex(([c]) => c === 100);
  return r.groups.slice(0, at < 0 ? undefined : at).find(([c]) => c === 5)?.[1];
};
const byHandle = (recs: ReturnType<typeof recordsOf>, h: string | undefined) =>
  recs.find((r) => r.type !== 'SECTION' && ownHandle(r) === h);
/** The 360 inside the record's `{ACAD_XDICTIONARY` fence, and where the
 *  fence sits: between the handle and the owner. */
const xdictFence = (r: { groups: [number, string][] }): string | undefined => {
  const at = r.groups.findIndex(([c, v]) => c === 102 && v === '{ACAD_XDICTIONARY');
  if (at < 0) return undefined;
  expect(r.groups[at + 1][0]).toBe(360);
  expect(r.groups[at + 2]).toEqual([102, '}']);
  expect(r.groups.findIndex(([c]) => c === 5)).toBeLessThan(at);
  const owner = r.groups.findIndex(([c]) => c === 330);
  if (owner >= 0) expect(owner).toBeGreaterThan(at);
  return r.groups[at + 1][1];
};
const entriesOf = (r: { groups: [number, string][] }): [string, number, string][] => {
  const out: [string, number, string][] = [];
  for (let i = 0; i + 1 < r.groups.length; i++) {
    if (r.groups[i][0] === 3) out.push([r.groups[i][1], r.groups[i + 1][0], r.groups[i + 1][1]]);
  }
  return out;
};

const chainDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.entities = [{
    type: 'line', handle: 'A0', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }, xdict: 'B0'
  } as Entity];
  d.unknownObjects = [
    {
      handle: 'B0', ownerHandle: 'A0', sourceType: 'DICTIONARY', typeCode: 42,
      hardOwner: true, cloning: 1,
      entries: [{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'C0', code: 3 }]
    },
    { handle: 'C0', ownerHandle: 'B0', sourceType: 'XRECORD', typeCode: 79 }
  ];
  /* the record's values beside the seal, as the DWG reader keeps them;
     the 340 names the entity itself */
  d.xrecords = [{
    handle: 'C0', name: 'ACAD_XREC_ROUNDTRIP',
    values: [{ code: 1, value: 'AB' }, { code: 90, value: 7 }, { code: 340, value: 'A0' }]
  }];
  return d;
};

describe('an extension-dictionary chain through DXF, handles preserved', () => {
  const text = writeDxf(chainDrawing(), { preserveHandles: true });
  const recs = recordsOf(text);

  it('keeps every source number and wires the chain owner by owner', () => {
    const line = recs.find((r) => r.type === 'LINE')!;
    expect(ownHandle(line)).toBe('A0');
    expect(xdictFence(line)).toBe('B0');
    const dict = byHandle(recs, 'B0')!;
    expect(dict.type).toBe('DICTIONARY');
    expect(groupOf(dict, 330)).toBe('A0');
    expect(groupOf(dict, 280)).toBe('1');
    expect(groupOf(dict, 281)).toBe('1');
    expect(entriesOf(dict)).toEqual([['ACAD_XREC_ROUNDTRIP', 360, 'C0']]);
    const xr = byHandle(recs, 'C0')!;
    expect(xr.type).toBe('XRECORD');
    expect(groupOf(xr, 330)).toBe('B0');
    const body = xr.groups.slice(xr.groups.findIndex(([c]) => c === 100) + 1);
    expect(body).toEqual([[280, '1'], [1, 'AB'], [90, '7'], [340, 'A0']]);
  });

  it('mints fresh numbers above the highest kept one', () => {
    const seed = parseInt(text.split('\n$HANDSEED\n5\n')[1], 16);
    const hs = recs.filter((r) => r.type !== 'SECTION').map(ownHandle).filter((h): h is string => !!h);
    expect(new Set(hs).size).toBe(hs.length);
    expect(seed).toBeGreaterThan(0xC0);
    for (const h of hs) expect(parseInt(h, 16)).toBeLessThan(seed);
    /* the canonical space records keep their numbers when nothing of
       the source holds them */
    expect(recs.some((r) => r.type === 'BLOCK_RECORD' && ownHandle(r) === '1F')).toBe(true);
  });

  it('reads back with the same facts', () => {
    const back = readDxf(text);
    const line = back.entities[0];
    expect(line.handle).toBe('A0');
    expect(line.xdict).toBe('B0');
    const dict = back.unknownObjects?.find((o) => o.handle === 'B0');
    expect(dict?.sourceType).toBe('DICTIONARY');
    expect(dict?.ownerHandle).toBe('A0');
    expect(dict?.hardOwner).toBe(true);
    expect(dict?.entries).toEqual([{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'C0', code: 3 }]);
    expect(dict?.dictPath).toBeUndefined();
    const xr = back.unknownObjects?.find((o) => o.handle === 'C0');
    expect(xr?.sourceType).toBe('XRECORD');
    expect(xr?.ownerHandle).toBe('B0');
    expect(xr?.name).toBe('ACAD_XREC_ROUNDTRIP');
    expect(back.xrecords?.find((x) => x.handle === 'C0')?.values)
      .toEqual([{ code: 1, value: 'AB' }, { code: 90, value: 7 }, { code: 340, value: 'A0' }]);
  });

  it('survives a second preserved generation unchanged', () => {
    const again = recordsOf(writeDxf(readDxf(text), { preserveHandles: true }));
    expect(xdictFence(again.find((r) => r.type === 'LINE')!)).toBe('B0');
    expect(entriesOf(byHandle(again, 'B0')!)).toEqual([['ACAD_XREC_ROUNDTRIP', 360, 'C0']]);
    expect(groupOf(byHandle(again, 'C0')!, 330)).toBe('B0');
  });
});

describe('the same chain renumbered', () => {
  const text = writeDxf(chainDrawing());
  const recs = recordsOf(text);
  const line = recs.find((r) => r.type === 'LINE')!;

  it('gives every object a fresh number and follows each link to it', () => {
    const lh = ownHandle(line)!;
    expect(lh).not.toBe('A0');
    const xd = xdictFence(line)!;
    expect(xd).not.toBe('B0');
    const dict = byHandle(recs, xd)!;
    expect(dict.type).toBe('DICTIONARY');
    expect(groupOf(dict, 330)).toBe(lh);
    const [[key, code, target]] = entriesOf(dict);
    expect([key, code]).toEqual(['ACAD_XREC_ROUNDTRIP', 360]);
    expect(target).not.toBe('C0');
    const xr = byHandle(recs, target)!;
    expect(xr.type).toBe('XRECORD');
    expect(groupOf(xr, 330)).toBe(xd);
    /* the pointer in the data follows the entity to its new number */
    expect(xr.groups.find(([c]) => c === 340)?.[1]).toBe(lh);
  });

  it('reads back as one chain, without the source numbering', () => {
    const back = readDxf(text);
    const l = back.entities[0];
    expect(l.xdict).toBeDefined();
    const dict = back.unknownObjects?.find((o) => o.handle === l.xdict);
    expect(dict?.ownerHandle).toBe(l.handle);
    const xr = back.unknownObjects?.find((o) => o.handle === dict?.entries?.[0].handle);
    expect(xr?.sourceType).toBe('XRECORD');
    expect(xr?.ownerHandle).toBe(dict?.handle);
    expect(back.xrecords?.[0].values[2]).toEqual({ code: 340, value: l.handle });
  });
});

describe('a dictionary with nothing written to list is dropped, quietly, and so is its pointer', () => {
  it('when the record it lists cannot be spelled', () => {
    const d = chainDrawing();
    /* the XRECORD sealed as DWG bits alone, its values gone */
    delete d.xrecords;
    d.unknownObjects![1].data = 'gA==';
    d.unknownObjects![1].dataBits = 2;
    d.unknownObjects![1].encoding = 2018;
    const text = writeDxf(d, { preserveHandles: true });
    const recs = recordsOf(text);
    expect(recs.some((r) => r.type === 'XRECORD')).toBe(false);
    expect(byHandle(recs, 'B0')).toBeUndefined();
    expect(text).not.toContain('{ACAD_XDICTIONARY');
    expect(d.warnings).toEqual(['1 XRECORD (sealed as DWG bits, no DXF spelling) left out of the DXF']);
  });
});

/* ------------------------------------------------------------------ */

/* A tagged application object under a LINE's extension dictionary,
 * whose body names the LINE (340), a sibling record (360, hard owner),
 * an object that is not in the file (330), and the LINE again in its
 * xdata (1005). */
const sealedBodyFixture = (siblingPresent = true): string => {
  const rows: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC'];
  rows.push('0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'APPID', '5', '9', '100', 'AcDbSymbolTable', '70', '1',
    '0', 'APPID', '5', '12', '100', 'AcDbSymbolTableRecord', '100', 'AcDbRegAppTableRecord', '2', 'ACME', '70', '0',
    '0', 'ENDTAB', '0', 'ENDSEC');
  rows.push('0', 'SECTION', '2', 'ENTITIES');
  rows.push('0', 'LINE', '5', 'E1', '102', '{ACAD_XDICTIONARY', '360', 'D1', '102', '}',
    '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine',
    '10', '0', '20', '0', '30', '0', '11', '1', '21', '1', '31', '0');
  rows.push('0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS');
  rows.push('0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1');
  rows.push('0', 'DICTIONARY', '5', 'D1', '330', 'E1', '100', 'AcDbDictionary', '280', '1', '281', '1',
    '3', 'ACME_NOTE', '360', 'A1', ...(siblingPresent ? ['3', 'ACME_SIDE', '360', 'B1'] : []));
  rows.push('0', 'ACME_NOTE', '5', 'A1', '102', '{ACAD_REACTORS', '330', 'D1', '102', '}',
    '330', 'D1', '100', 'AcDbAcmeNote', '90', '3', '340', 'E1', '360', 'B1', '330', 'DEAD',
    '1001', 'ACME', '1005', 'E1', '1070', '5');
  if (siblingPresent) rows.push('0', 'ACME_SIDE', '5', 'B1', '330', 'D1', '100', 'AcDbAcmeSide', '70', '1');
  rows.push('0', 'ENDSEC', '0', 'EOF', '');
  return rows.join('\n');
};

describe('a sealed body\'s handle groups', () => {
  const first = readDxf(sealedBodyFixture());

  it('are read with the record\'s owner, extension dictionary and reactors', () => {
    const note = first.unknownObjects?.find((o) => o.sourceType === 'ACME_NOTE');
    expect(note?.ownerHandle).toBe('D1');
    expect(note?.reactors).toEqual(['D1']);
    expect(note?.name).toBe('ACME_NOTE');
    const dict = first.unknownObjects?.find((o) => o.handle === 'D1');
    expect(dict?.entries?.map((e) => [e.name, e.handle, e.code]))
      .toEqual([['ACME_NOTE', 'A1', 3], ['ACME_SIDE', 'B1', 3]]);
    expect(first.entities[0].xdict).toBe('D1');
  });

  it('travel verbatim under preserveHandles', () => {
    const recs = recordsOf(writeDxf(first, { preserveHandles: true }));
    const note = recs.find((r) => r.type === 'ACME_NOTE')!;
    const body = note.groups.slice(note.groups.findIndex(([c]) => c === 100) + 1);
    expect(body).toEqual([[90, '3'], [340, 'E1'], [360, 'B1'], [330, 'DEAD'],
      [1001, 'ACME'], [1005, 'E1'], [1070, '5']]);
    /* its identity: the reactor at the dictionary, re-derived, ahead of the owner */
    expect(note.groups.slice(0, 5)).toEqual([[5, 'A1'], [102, '{ACAD_REACTORS'], [330, 'D1'], [102, '}'], [330, 'D1']]);
  });

  it('are remapped through the output\'s numbering otherwise, an unwritten target nulled', () => {
    const recs = recordsOf(writeDxf(first));
    const line = recs.find((r) => r.type === 'LINE')!;
    const lh = ownHandle(line)!;
    const side = recs.find((r) => r.type === 'ACME_SIDE')!;
    const note = recs.find((r) => r.type === 'ACME_NOTE')!;
    const dh = xdictFence(line)!;
    expect(groupOf(note, 330)).toBe(dh);
    const body = note.groups.slice(note.groups.findIndex(([c]) => c === 100) + 1);
    expect(body).toEqual([[90, '3'], [340, lh], [360, ownHandle(side)!], [330, '0'],
      [1001, 'ACME'], [1005, lh], [1070, '5']]);
    expect(lh).not.toBe('E1');
  });

  it('a hard reference into nothing keeps the record home, and says so', () => {
    const d = readDxf(sealedBodyFixture(false));
    const recs = recordsOf(writeDxf(d));
    expect(recs.some((r) => r.type === 'ACME_NOTE')).toBe(false);
    expect(d.warnings.some((w) => /ACME_NOTE \(a hard reference into an object not written\)/.test(w))).toBe(true);
    /* the dictionary had nothing written left to list: dropped quietly,
       and the LINE carries no pointer into nothing */
    expect(recs.some((r) => r.type === 'DICTIONARY' && groupOf(r, 330) === ownHandle(recs.find((r) => r.type === 'LINE')!))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('a DXF-read chain into a DWG, handles preserved', () => {
  const rows = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1032', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'E1', '102', '{ACAD_XDICTIONARY', '360', 'D1', '102', '}',
    '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine',
    '10', '0', '20', '0', '30', '0', '11', '1', '21', '1', '31', '0',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS',
    '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1',
    '0', 'DICTIONARY', '5', 'D1', '330', 'E1', '100', 'AcDbDictionary', '280', '1', '281', '1',
    '3', 'ACAD_XREC_ROUNDTRIP', '360', 'A1',
    '0', 'XRECORD', '5', 'A1', '102', '{ACAD_REACTORS', '330', 'D1', '102', '}', '330', 'D1',
    '100', 'AcDbXrecord', '280', '1', '1', 'AB', '90', '7', '40', '1.5', '340', 'E1',
    '0', 'ENDSEC', '0', 'EOF', ''];
  const d = readDxf(rows.join('\n'));

  it('reads the facts a DWG read carries: the dictionary from its entries, the XRECORD with its bits', () => {
    expect(d.entities[0].xdict).toBe('D1');
    const dict = d.unknownObjects?.find((o) => o.handle === 'D1') as UnknownObject;
    expect(dict.typeCode).toBe(42);
    expect(dict.hardOwner).toBe(true);
    expect(dict.entries).toEqual([{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'A1', code: 3 }]);
    const xr = d.unknownObjects?.find((o) => o.handle === 'A1') as UnknownObject;
    expect(xr.typeCode).toBe(79);
    expect(xr.ownerHandle).toBe('D1');
    expect(xr.reactors).toEqual(['D1']);
    expect(xr.encoding).toBe(2018);
    expect(xr.dataBits).toBeGreaterThan(0);
    expect(xr.dictPath).toBeUndefined();
  });

  it('writes the chain natively and reads it back from the DWG', () => {
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    const line = back.entities[0];
    expect(line.handle).toBe('E1');
    expect(line.xdict).toBe('D1');
    const dict = back.unknownObjects?.find((o) => o.handle === 'D1');
    expect(dict?.ownerHandle).toBe('E1');
    expect(dict?.entries).toEqual([{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'A1', code: 3 }]);
    const xr = back.unknownObjects?.find((o) => o.handle === 'A1');
    expect(xr?.ownerHandle).toBe('D1');
    /* the bits decode to the values the DXF spelled */
    expect(back.xrecords?.find((x) => x.handle === 'A1')?.values)
      .toEqual([{ code: 1, value: 'AB' }, { code: 90, value: 7 }, { code: 40, value: 1.5 }, { code: 340, value: 'E1' }]);
  });
});

/* ------------------------------------------------------------------ */

describe('draw order under preserveHandles', () => {
  it('a space out of handle order gets a SORTENTSTABLE, and reads back in array order', () => {
    const d = emptyDrawing();
    const line = (handle: string, x: number): Entity => ({
      type: 'line', handle, layer: '0', color: { kind: 'byLayer' },
      start: { x, y: 0, z: 0 }, end: { x, y: 1, z: 0 }
    });
    d.entities = [line('B0', 2), line('A0', 1), line('C0', 3)];
    const text = writeDxf(d, { preserveHandles: true });
    const recs = recordsOf(text);
    const table = recs.find((r) => r.type === 'SORTENTSTABLE')!;
    expect(table).toBeTruthy();
    const pairs = table.groups.filter(([c]) => c === 331 || c === 5)
      .slice(1).map(([, v]) => v);
    /* B0 sorts as A0 and A0 as B0; C0 is where it was */
    expect(pairs).toEqual(['B0', 'A0', 'A0', 'B0']);
    const ms = recs.find((r) => r.type === 'BLOCK_RECORD' && groupOf(r, 2) === '*Model_Space')!;
    const dh = xdictFence(ms)!;
    const dict = byHandle(recs, dh)!;
    expect(entriesOf(dict)).toEqual([['ACAD_SORTENTS', 360, ownHandle(table)!]]);
    expect(recs.some((r) => r.type === 'CLASS' && groupOf(r, 1) === 'SORTENTSTABLE')).toBe(true);
    const back = readDxf(text);
    expect(back.entities.map((e) => e.handle)).toEqual(['B0', 'A0', 'C0']);
  });

  it('a space in handle order needs none', () => {
    const d = emptyDrawing();
    d.entities = [{
      type: 'line', handle: 'A0', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
    }, {
      type: 'line', handle: 'B0', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 2, y: 2, z: 0 }
    }];
    expect(writeDxf(d, { preserveHandles: true })).not.toContain('SORTENTSTABLE');
    expect(writeDxf(d)).not.toContain('SORTENTSTABLE');
  });
});

/* ------------------------------------------------------------------ */

describe('an associative hatch', () => {
  const fixture = (): string => ['0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'L1', '102', '{ACAD_REACTORS', '330', 'H1', '102', '}', '330', '1F',
    '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    '0', 'HATCH', '5', 'H1', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbHatch',
    '10', '0', '20', '0', '30', '0', '210', '0', '220', '0', '230', '1', '2', 'SOLID', '70', '1', '71', '1',
    '91', '1', '92', '7', '72', '0', '73', '1', '93', '3', '10', '0', '20', '0', '10', '1', '20', '0', '10', '0', '20', '1',
    '97', '1', '330', 'L1', '75', '0', '76', '1', '98', '0',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const d = readDxf(fixture());

  it('keeps its boundary objects and the reactor on them', () => {
    const hatch = d.entities.find((e) => e.type === 'hatch')!;
    expect(hatch.type === 'hatch' && hatch.associative).toBe(true);
    expect(hatch.type === 'hatch' && hatch.loops[0].boundaryHandles).toEqual(['L1']);
    expect(d.entities.find((e) => e.type === 'line')?.reactors).toEqual(['H1']);
  });

  it('leaves associative with the links and the reactor, both renumbered', () => {
    const recs = recordsOf(writeDxf(d));
    const line = recs.find((r) => r.type === 'LINE')!;
    const hatch = recs.find((r) => r.type === 'HATCH')!;
    expect(groupOf(hatch, 71)).toBe('1');
    const at = hatch.groups.findIndex(([c]) => c === 97);
    expect(hatch.groups[at]).toEqual([97, '1']);
    expect(hatch.groups[at + 1]).toEqual([330, ownHandle(line)!]);
    const r = line.groups.findIndex(([c, v]) => c === 102 && v === '{ACAD_REACTORS');
    expect(line.groups[r + 1]).toEqual([330, ownHandle(hatch)!]);
  });

  it('leaves non-associative, and unwatched, when its boundary is gone', () => {
    const d2 = readDxf(fixture());
    d2.entities = d2.entities.filter((e) => e.type !== 'line');
    const recs = recordsOf(writeDxf(d2));
    const hatch = recs.find((r) => r.type === 'HATCH')!;
    expect(groupOf(hatch, 71)).toBe('0');
    expect(hatch.groups.find(([c]) => c === 97)).toEqual([97, '0']);
  });
});
