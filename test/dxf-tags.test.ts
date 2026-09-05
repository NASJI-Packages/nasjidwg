/* nasjidwg — DXF-side sealed passthrough: raw tag retention.
 *
 * An entity or object record the semantic layer does not model arrives
 * through DXF as a run of (group, value) tags. The claim under test: the
 * reader keeps that run verbatim — string values with their spaces, floats
 * with every digit the file spelled out, binary chunks, extension
 * dictionary fences, xdata — and the writer re-emits it byte for byte,
 * touching exactly two groups: the record's own handle (freshly numbered)
 * and the bare owner 330 ahead of the first subclass marker (repointed at
 * the real owner). Order is part of the contract.
 * The one deliberate exception is the fences of that same region: every
 * object is renumbered and no dictionary travels, so a reactor is
 * repointed at the number its target got here (dropped when the target
 * was not written) and the extension-dictionary fence goes altogether —
 * verbatim, both would name records that are not there, and AUDIT
 * reports each unreachable extension dictionary.
 *
 * The fixtures are hand-written token by token, so the tests pin the
 * format knowledge itself rather than another program's output.
 */

import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf, writeDxfBinary } from '../src/dxf/writer.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { readDwg } from '../src/dwg/reader.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, UnknownEntity } from '../src/core/model.js';

/* The fictional entity's tags, in the exact order the file carries them.
 * Deliberately exotic: a fenced extension dictionary, a fenced reactor
 * list whose 330 must NOT be mistaken for the owner, a string value with
 * leading and trailing spaces, a float spelled to seventeen digits, two
 * binary 310 chunks and an xdata run. */
const ENTITY_TAGS: [number, string][] = [
  [5, '1A2B'],                             /* 0: the handle — replaced */
  [102, '{ACAD_XDICTIONARY'],              /* 1 */
  [360, 'DEAD'],                           /* 2: fenced — dropped on the way out */
  [102, '}'],                              /* 3 */
  [102, '{ACAD_REACTORS'],                 /* 4 */
  [330, 'FEED'],                           /* 5: fenced 330 — NOT the owner; the LINE, repointed */
  [102, '}'],                              /* 6 */
  [330, 'ABBA'],                           /* 7: the owner — replaced */
  [100, 'AcDbEntity'],                     /* 8 */
  [8, '0'],                                /* 9 */
  [62, '5'],                               /* 10 */
  [370, '25'],                             /* 11 */
  [100, 'AcDbSplinex'],                    /* 12 */
  [70, '7'],                               /* 13 */
  [1, '  leading and trailing  '],         /* 14 */
  [40, '1.5000000000000001'],              /* 15 */
  [310, 'DEADBEEF0102030405'],             /* 16 */
  [310, 'CAFEBABE'],                       /* 17 */
  [1001, 'ACME_APP'],                      /* 18 */
  [1070, '42'],                            /* 19 */
  [1040, '3.75']                           /* 20 */
];
/* the model-space BLOCK_RECORD handle the writer owns */
const MS_OWNER = '1F';

/** The tags a round trip is expected to yield: the extension-dictionary
 *  fence gone, the reactor kept and repointed at the LINE beside the
 *  record (the fixture gives the LINE handle FEED) under the number the
 *  LINE got in the output; everything else verbatim. */
const expectedOut = (lineHandle: string): [number, string][] => {
  const t = ENTITY_TAGS.filter((_, i) => i < 1 || i > 3);
  t[2] = [330, lineHandle];
  return t;
};
const OUT_HANDLE_AT = 0;
const OUT_REACTOR_AT = 2;
const OUT_OWNER_AT = 4;
const OUT_FLOAT_AT = 12;
const lineHandleIn = (d: Drawing): string =>
  d.entities.find((e) => e.type === 'line')?.handle ?? '';

const entityFixture = (): string => {
  const rows: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  rows.push('0', 'LINE', '5', 'FEED', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1');
  rows.push('0', 'ACME_SPLINEX');
  for (const [c, v] of ENTITY_TAGS) rows.push(String(c), v);
  rows.push('0', 'ENDSEC', '0', 'EOF', '');
  return rows.join('\n');
};

const findUnknown = (d: Drawing): UnknownEntity | undefined =>
  d.entities.find((e): e is UnknownEntity => e.type === 'unknown');

/** The whole re-emission claim in one walk: every tag verbatim except the
 *  handle (fresh hex, different from the source's) and the owner. */
const expectSubstitutedOnly = (
  tags: [number, string][] | undefined,
  expected: readonly [number, string][],
  owner: string
): void => {
  expect(tags?.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const [c, v] = expected[i];
    const [c2, v2] = tags![i];
    expect(c2, `code at ${i}`).toBe(c);
    if (i === OUT_HANDLE_AT) {
      expect(v2).toMatch(/^[0-9A-F]+$/);
      expect(v2).not.toBe(v);
    } else if (i === OUT_OWNER_AT) {
      expect(v2).toBe(owner);
    } else {
      expect(v2, `value at ${i}`).toBe(v);
    }
  }
};

describe('sealed DXF tags: reading the record', () => {
  const d = readDxf(entityFixture());
  const u = findUnknown(d);

  it('keeps every tag verbatim, in document order', () => {
    expect(u?.sourceType).toBe('ACME_SPLINEX');
    expect(u?.tags).toEqual(ENTITY_TAGS);
  });

  it('still reads the common properties FROM the tags', () => {
    expect(u?.handle).toBe('1A2B');
    expect(u?.layer).toBe('0');
    expect(u?.color).toEqual({ kind: 'aci', index: 5 });
    expect(u?.xdata?.[0]?.appName).toBe('ACME_APP');
  });

  it('keeps the line beside it and says what it kept', () => {
    expect(d.entities.some((e) => e.type === 'line')).toBe(true);
    expect(d.warnings.join(' ')).toContain('ACME_SPLINEX');
  });
});

describe('sealed DXF tags: ASCII round trip', () => {
  const first = readDxf(entityFixture());
  const second = readDxf(writeDxf(first));
  const u2 = findUnknown(second);

  it('re-emits verbatim except handle and owner, order preserved', () => {
    expectSubstitutedOnly(u2?.tags, expectedOut(lineHandleIn(second)), MS_OWNER);
  });

  it('does not confuse the fenced reactor 330 with the owner: it follows the LINE', () => {
    const line = lineHandleIn(second);
    expect(line).toMatch(/^[0-9A-F]+$/);
    expect(line).not.toBe('FEED');
    expect(u2?.tags?.[OUT_REACTOR_AT - 1]).toEqual([102, '{ACAD_REACTORS']);
    expect(u2?.tags?.[OUT_REACTOR_AT]).toEqual([330, line]);
    expect(u2?.tags?.[OUT_REACTOR_AT + 1]).toEqual([102, '}']);
    expect(u2?.tags?.[OUT_OWNER_AT]).toEqual([330, MS_OWNER]);
  });

  it('drops the extension-dictionary fence: no dictionary travels', () => {
    expect(u2?.tags?.some(([, v]) => v === '{ACAD_XDICTIONARY' || v === 'DEAD')).toBe(false);
    expect(writeDxf(first)).not.toContain('\n360\nDEAD\n');
  });

  it('drops a reactor whose target is not in the output', () => {
    const tags = ENTITY_TAGS.map(([c, v]): [number, string] => [c, v === 'FEED' ? 'BEEF' : v]);
    const rows: string[] = ['0', 'SECTION', '2', 'ENTITIES', '0', 'ACME_SPLINEX'];
    for (const [c, v] of tags) rows.push(String(c), v);
    rows.push('0', 'ENDSEC', '0', 'EOF', '');
    const u = findUnknown(readDxf(writeDxf(readDxf(rows.join('\n')))));
    expect(u?.tags?.map(([c]) => c)).toEqual(
      ENTITY_TAGS.filter((_, i) => i < 1 || i > 6).map(([c]) => c));
    expect(u?.tags?.some(([, v]) => v === 'BEEF')).toBe(false);
  });

  it('the seventeen-digit float survives byte-for-byte', () => {
    expect(u2?.tags?.[OUT_FLOAT_AT]).toEqual([40, '1.5000000000000001']);
  });

  it('does not double the xdata: the 1001 run appears once', () => {
    const text = writeDxf(first);
    expect(text.split('\n1001\nACME_APP\n').length - 1).toBe(1);
    /* and the application it names is registered, as DXFIN requires */
    expect(text).toContain('\nAcDbRegAppTableRecord\n2\nACME_APP\n');
  });

  it('a third generation is stable except the fresh handle and the reactor', () => {
    const third = readDxf(writeDxf(second));
    const u3 = findUnknown(third);
    expect(u3?.tags?.length).toBe(u2?.tags?.length);
    for (let i = 0; i < (u2?.tags?.length ?? 0); i++) {
      if (i === OUT_HANDLE_AT) continue;
      if (i === OUT_REACTOR_AT) {
        /* the reactor follows the LINE's number in each generation */
        expect(u3?.tags?.[i]).toEqual([330, lineHandleIn(third)]);
        continue;
      }
      expect(u3?.tags?.[i]).toEqual(u2?.tags?.[i]);
    }
  });
});

describe('sealed DXF tags: binary round trip', () => {
  /* Binary DXF stores values typed, not as text: a double goes out as a
     float64 and comes back in the canonical string the ASCII writer would
     emit for that same number. So through binary the contract is: codes
     and order identical, strings, chunks and integers character-identical,
     floats equal as numbers and stable from then on. */
  const first = readDxf(entityFixture());
  const viaBin = readDxf(writeDxfBinary(first));
  const u = findUnknown(viaBin);

  it('keeps codes and order', () => {
    expect(u?.tags?.map(([c]) => c)).toEqual(expectedOut('').map(([c]) => c));
  });

  it('strings keep their spaces, chunks their hex, integers their text', () => {
    expect(u?.tags?.[11]).toEqual([1, '  leading and trailing  ']);
    expect(u?.tags?.[13]).toEqual([310, 'DEADBEEF0102030405']);
    expect(u?.tags?.[14]).toEqual([310, 'CAFEBABE']);
    expect(u?.tags?.[7]).toEqual([62, '5']);
    expect(u?.tags?.[16]).toEqual([1070, '42']);
    expect(u?.tags?.[17]).toEqual([1040, '3.75']);
    expect(u?.tags?.[OUT_OWNER_AT]).toEqual([330, MS_OWNER]);
    expect(u?.tags?.[OUT_REACTOR_AT]).toEqual([330, lineHandleIn(viaBin)]);
  });

  it('floats survive as the same double in canonical form', () => {
    const [code, v] = u!.tags![OUT_FLOAT_AT];
    expect(code).toBe(40);
    expect(parseFloat(v)).toBe(parseFloat('1.5000000000000001'));
    expect(String(parseFloat(v))).toBe(v);   /* already canonical */
  });

  it('is stable across a second binary generation', () => {
    const again = readDxf(writeDxfBinary(viaBin));
    const u2 = findUnknown(again);
    expect(u2?.tags?.length).toBe(u?.tags?.length);
    for (let i = 0; i < (u?.tags?.length ?? 0); i++) {
      if (i === OUT_HANDLE_AT) continue;
      if (i === OUT_REACTOR_AT) {
        expect(u2?.tags?.[i]).toEqual([330, lineHandleIn(again)]);
        continue;
      }
      expect(u2?.tags?.[i]).toEqual(u?.tags?.[i]);
    }
  });
});

/* ------------------------------------------------------------------ */

const OBJECT_TAGS: [number, string][] = [
  [5, 'D1'],
  [330, 'C'],
  [100, 'AcDbAcmeStore'],
  [90, '7'],
  [1, ' payload text '],
  [40, '2.5']
];

const objectFixture = (): string => {
  const rows: string[] = ['0', 'SECTION', '2', 'OBJECTS'];
  rows.push(
    '0', 'DICTIONARY', '5', 'C', '330', '0',
    '100', 'AcDbDictionary', '281', '1',
    '3', 'ACME_SETTINGS', '350', 'D1'
  );
  rows.push('0', 'ACME_STORE');
  for (const [c, v] of OBJECT_TAGS) rows.push(String(c), v);
  /* a second record nobody's dictionary names — gets the fallback key */
  rows.push('0', 'ACME_EXTRA', '5', 'D2', '330', 'C',
    '100', 'AcDbAcmeExtra', '70', '1');
  rows.push('0', 'ENDSEC', '0', 'EOF', '');
  return rows.join('\n');
};

describe('sealed unknown OBJECTS through DXF', () => {
  const first = readDxf(objectFixture());

  it('lands in unknownObjects with sourceType, tags and dictionary name', () => {
    expect(first.unknownObjects?.length).toBe(2);
    const o = first.unknownObjects?.[0];
    expect(o?.sourceType).toBe('ACME_STORE');
    expect(o?.handle).toBe('D1');
    expect(o?.name).toBe('ACME_SETTINGS');
    expect(o?.ownerHandle).toBe('C');
    expect(o?.tags).toEqual(OBJECT_TAGS);
    expect(first.unknownObjects?.[1]?.name).toBeUndefined();
  });

  const second = readDxf(writeDxf(first));

  it('round-trips under its retained name, verbatim except handle/owner', () => {
    const o = second.unknownObjects?.find((x) => x.sourceType === 'ACME_STORE');
    expect(o?.name).toBe('ACME_SETTINGS');
    expect(o?.tags?.length).toBe(OBJECT_TAGS.length);
    expect(o?.tags?.map(([c]) => c)).toEqual(OBJECT_TAGS.map(([c]) => c));
    /* fresh handle; owner is the named objects dictionary */
    expect(o?.tags?.[0][0]).toBe(5);
    expect(o?.tags?.[0][1]).not.toBe('D1');
    expect(o?.tags?.[1]).toEqual([330, 'C']);
    /* the body, spaces included, is untouched */
    expect(o?.tags?.slice(2)).toEqual(OBJECT_TAGS.slice(2));
  });

  it('an unnamed record leaves under the SEALED_OBJECT_n fallback', () => {
    const o = second.unknownObjects?.find((x) => x.sourceType === 'ACME_EXTRA');
    expect(o?.name).toBe('SEALED_OBJECT_2');
    expect(o?.tags?.slice(2)).toEqual([[100, 'AcDbAcmeExtra'], [70, '1']]);
  });

  it('survives a further generation unchanged', () => {
    const third = readDxf(writeDxf(second));
    const o2 = second.unknownObjects?.find((x) => x.sourceType === 'ACME_STORE');
    const o3 = third.unknownObjects?.find((x) => x.sourceType === 'ACME_STORE');
    expect(o3?.name).toBe('ACME_SETTINGS');
    expect(o3?.tags?.slice(1)).toEqual(o2?.tags?.slice(1));
  });
});

/* ------------------------------------------------------------------ */

describe('tags are a DXF-medium retention: the DWG writer skips them', () => {
  /* A tags-carrying unknown has no DWG bit payload to seal; writing it
     into a DWG would mean inventing bits. The writer must say so in
     `skipped` — the DWG side has its own sealed mechanism — and the rest
     of the drawing must come through untouched. */
  const d = readDxf(entityFixture());
  const { data, skipped } = writeDwg2018(d);

  it('names the unknown in the skipped list', () => {
    expect(skipped).toContain('ACME_SPLINEX');
  });

  it('writes the rest of the drawing intact', () => {
    const back = readDwg(data);
    expect(back.warnings).toEqual([]);
    const line = back.entities.find((e) => e.type === 'line');
    expect(line).toBeTruthy();
    expect(back.entities.some((e) => e.type === 'unknown')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

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
/** Each record's own handle — the 5 ahead of its first subclass marker. */
const ownHandles = (text: string): string[] => recordsOf(text)
  .filter((r) => r.type !== 'SECTION')     /* the header's $HANDSEED is a 5 too */
  .map((r) => { const at = r.groups.findIndex(([c]) => c === 100); return r.groups.slice(0, at < 0 ? undefined : at).find(([c]) => c === 5)?.[1]; })
  .filter((h): h is string => !!h);

/* An XRECORD as the reference writes one: reactor and extension-
 * dictionary fences and the owner ahead of the AcDbXrecord marker, then
 * the application's own data — a 102 string (the table round-trip
 * record opens with one), a 360 owning another object of the file, a
 * 330 naming an entity, a fenced run of its own, a handle-typed 5. */
const xrecordFixture = (): string => {
  const rows: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  rows.push('0', 'LINE', '5', 'E1', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1');
  rows.push('0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS');
  rows.push('0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1',
    '3', 'ACME_DATA', '350', 'D1', '3', 'ACME_STORE', '350', 'D2');
  rows.push('0', 'XRECORD', '5', 'D1',
    '102', '{ACAD_REACTORS', '330', 'C', '102', '}',
    '102', '{ACAD_XDICTIONARY', '360', 'DEAD', '102', '}',
    '330', 'C', '100', 'AcDbXrecord', '280', '1',
    '102', 'ACAD_ROUNDTRIP_2008_TABLE_ENTITY', '360', 'D2', '70', '2', '330', 'E1',
    '102', '{AcDbXrefObjectId', '330', 'BEEF', '90', '0', '102', '}',
    '5', 'ABCD', '1', 'payload');
  rows.push('0', 'ACME_STORE', '5', 'D2', '330', 'C', '100', 'AcDbAcmeStore', '70', '1');
  rows.push('0', 'ENDSEC', '0', 'EOF', '');
  return rows.join('\n');
};

describe('XRECORD through DXF: fences are not data, data is all of it', () => {
  const first = readDxf(xrecordFixture());
  const xr = first.xrecords?.[0];

  it('reads every group past the marker, 102 and handles included, and nothing ahead of it', () => {
    expect(first.xrecords?.length).toBe(1);
    expect(xr?.name).toBe('ACME_DATA');
    expect(xr?.values.map((v) => v.code)).toEqual([102, 360, 70, 330, 102, 330, 90, 102, 5, 1]);
    expect(xr?.values[0]).toEqual({ code: 102, value: 'ACAD_ROUNDTRIP_2008_TABLE_ENTITY' });
    expect(xr?.values[4]).toEqual({ code: 102, value: '{AcDbXrefObjectId' });
    expect(xr?.values.some((v) => 'value' in v && (v.value === 'DEAD' || v.value === '{ACAD_REACTORS'))).toBe(false);
  });

  const text = writeDxf(first);
  const recs = recordsOf(text);
  const out = recs.find((r) => r.type === 'XRECORD')!;
  const store = recs.find((r) => r.type === 'ACME_STORE')!;
  const line = recs.find((r) => r.type === 'LINE')!;

  it('leaves with no handle used twice', () => {
    const hs = ownHandles(text);
    expect(new Set(hs).size).toBe(hs.length);
  });

  it('repoints the 360 at the object it owns, the 330 at the entity it names, nulls the unknown', () => {
    expect(groupOf(out, 360)).toBe(groupOf(store, 5));
    const pointers = out.groups.filter(([c]) => c === 330);
    expect(pointers[1]).toEqual([330, groupOf(line, 5)]);   /* [0] is the owner */
    expect(pointers[2]).toEqual([330, '0']);                 /* BEEF: not written */
  });

  it('keeps the in-body 102 strings and the handle-typed 5 as data, and writes no fence of its own', () => {
    const body = out.groups.slice(out.groups.findIndex(([c]) => c === 100) + 1);
    expect(body.filter(([c]) => c === 102).map(([, v]) => v))
      .toEqual(['ACAD_ROUNDTRIP_2008_TABLE_ENTITY', '{AcDbXrefObjectId', '}']);
    expect(body).toContainEqual([5, 'ABCD']);
    expect(body).toContainEqual([1, 'payload']);
    expect(out.groups.some(([, v]) => v === '{ACAD_REACTORS' || v === '{ACAD_XDICTIONARY')).toBe(false);
  });

  it('survives a further generation with the same shape', () => {
    const second = readDxf(text);
    const xr2 = second.xrecords?.[0];
    expect(xr2?.name).toBe('ACME_DATA');
    expect(xr2?.values.map((v) => v.code)).toEqual(xr?.values.map((v) => v.code));
    expect(xr2?.values[1]).toEqual({ code: 360, value: second.unknownObjects?.[0]?.handle });
    expect(xr2?.values[3]).toEqual({ code: 330, value: second.entities[0].handle });
  });
});

/* ------------------------------------------------------------------ */

const LONG1 = 'x'.repeat(300);
const LONG3 = 'y'.repeat(260) + ' with spaces  ';
const HEX = 'AB'.repeat(120);
const BLOB_TAGS: [number, string][] = [
  [5, 'D1'], [330, 'C'], [100, 'AcDbAcmeBlob'],
  [1, LONG1], [3, LONG3], [310, HEX], [310, 'CAFE'], [90, '7']
];
const blobFixture = (): string => {
  const rows: string[] = ['0', 'SECTION', '2', 'OBJECTS'];
  rows.push('0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1',
    '3', 'ACME_BLOB', '350', 'D1');
  rows.push('0', 'ACME_BLOB');
  for (const [c, v] of BLOB_TAGS) rows.push(String(c), v);
  rows.push('0', 'ENDSEC', '0', 'EOF', '');
  return rows.join('\n');
};

describe('sealed object with binary chunks and strings past 255 characters', () => {
  const first = readDxf(blobFixture());
  const text = writeDxf(first);

  it('reads the tags verbatim, long strings uncut', () => {
    expect(first.unknownObjects?.[0]?.tags).toEqual(BLOB_TAGS);
  });

  it('writes each long string and chunk as the one group it was', () => {
    expect(text).toContain('\n1\n' + LONG1 + '\n');
    expect(text).toContain('\n3\n' + LONG3 + '\n');
    expect(text).toContain('\n310\n' + HEX + '\n310\nCAFE\n');
  });

  it('is byte-identical past handle and owner after another read', () => {
    const o = readDxf(text).unknownObjects?.[0];
    expect(o?.name).toBe('ACME_BLOB');
    expect(o?.tags?.slice(2)).toEqual(BLOB_TAGS.slice(2));
  });
});

/* ------------------------------------------------------------------ */

/* The named-objects tree: a SCALE two levels down under ACAD_SCALELIST,
 * a WIPEOUTVARIABLES straight under the named objects dictionary with
 * its demand-loaded class declared, a FIELD hanging off a LINE's
 * extension dictionary, and a record the named objects dictionary owns
 * without listing. */
const WIPEOUT_APP = 'WipeOut|Product Desc:     WipeOut Dbx Application|Company:          Autodesk, Inc.';
const treeFixture = (acadver = 'AC1015', tableContent = false): string => {
  const rows: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', acadver, '0', 'ENDSEC'];
  rows.push('0', 'SECTION', '2', 'CLASSES',
    '0', 'CLASS', '1', 'WIPEOUTVARIABLES', '2', 'AcDbWipeoutVariables', '3', WIPEOUT_APP,
    '90', '0', '280', '0', '281', '0',
    '0', 'ENDSEC');
  rows.push('0', 'SECTION', '2', 'ENTITIES');
  rows.push('0', 'LINE', '5', 'E1', '102', '{ACAD_XDICTIONARY', '360', 'X1', '102', '}',
    '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine',
    '10', '0', '20', '0', '30', '0', '11', '1', '21', '1', '31', '0');
  rows.push('0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS');
  rows.push('0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1',
    '3', 'ACAD_SCALELIST', '350', 'S0', '3', 'ACAD_WIPEOUT_VARS', '350', 'W1',
    ...(tableContent ? ['3', 'ACAD_TABLE_CONTENT', '350', 'T1'] : []));
  rows.push('0', 'DICTIONARY', '5', 'S0', '102', '{ACAD_REACTORS', '330', 'C', '102', '}',
    '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'A1', '350', 'S1', '3', 'A2', '350', 'S2');
  for (const [h, nm] of [['S1', 'A1'], ['S2', 'A2']]) {
    rows.push('0', 'SCALE', '5', h, '102', '{ACAD_REACTORS', '330', 'S0', '102', '}',
      '330', 'S0', '100', 'AcDbScale', '70', '0', '300', nm, '140', '1.0', '141', '1.0', '290', '1');
  }
  rows.push('0', 'WIPEOUTVARIABLES', '5', 'W1', '102', '{ACAD_REACTORS', '330', 'C', '102', '}',
    '330', 'C', '100', 'AcDbWipeoutVariables', '70', '1');
  rows.push('0', 'DICTIONARY', '5', 'X1', '330', 'E1', '100', 'AcDbDictionary', '281', '1',
    '3', 'ACAD_FIELD', '350', 'F0');
  rows.push('0', 'DICTIONARY', '5', 'F0', '330', 'X1', '100', 'AcDbDictionary', '281', '1',
    '3', 'TEXT', '350', 'F1');
  rows.push('0', 'FIELD', '5', 'F1', '330', 'F0', '100', 'AcDbField', '1', 'AcVar', '2', 'x', '90', '0');
  rows.push('0', 'ACME_LOOSE', '5', 'L1', '330', 'C', '100', 'AcDbAcmeLoose', '70', '1');
  if (tableContent) {
    rows.push('0', 'TABLECONTENT', '5', 'T1', '330', 'C', '100', 'AcDbLinkedData', '1', '', '300', '',
      '100', 'AcDbLinkedTableData', '90', '0', '91', '0', '100', 'AcDbFormattedTableData',
      '100', 'AcDbTableContent', '340', '0');
  }
  rows.push('0', 'ENDSEC', '0', 'EOF', '');
  return rows.join('\n');
};

describe('the named-objects tree: placement, rebuild, and what stays out', () => {
  const first = readDxf(treeFixture());
  const byType = (d: Drawing, t: string) => (d.unknownObjects ?? []).filter((o) => o.sourceType === t);

  it('places each sealed record: path of the owning dictionary, key it is listed under', () => {
    const [a1, a2] = byType(first, 'SCALE');
    expect(a1?.dictPath).toEqual(['ACAD_SCALELIST']);
    expect(a1?.name).toBe('A1');
    expect(a2?.name).toBe('A2');
    const wv = byType(first, 'WIPEOUTVARIABLES')[0];
    expect(wv?.dictPath).toEqual([]);
    expect(wv?.name).toBe('ACAD_WIPEOUT_VARS');
    expect(wv?.appClass).toEqual({
      dxfName: 'WIPEOUTVARIABLES', cppName: 'AcDbWipeoutVariables', appName: WIPEOUT_APP
    });
    const loose = byType(first, 'ACME_LOOSE')[0];
    expect(loose?.dictPath).toEqual([]);
    expect(loose?.name).toBeUndefined();
  });

  it('keeps a record off an extension dictionary in the model, without a path', () => {
    const f = byType(first, 'FIELD')[0];
    expect(f?.name).toBe('TEXT');
    expect(f?.ownerHandle).toBe('F0');
    expect(f?.dictPath).toBeUndefined();
  });

  const text = writeDxf(first);
  const recs = recordsOf(text);

  it('rebuilds ACAD_SCALELIST under the named objects dictionary and lists the scales there', () => {
    const nod = recs.find((r) => r.type === 'DICTIONARY' && groupOf(r, 5) === 'C')!;
    const at = nod.groups.findIndex(([c, v]) => c === 3 && v === 'ACAD_SCALELIST');
    expect(at).toBeGreaterThan(0);
    const listH = nod.groups[at + 1][1];
    const list = recs.find((r) => r.type === 'DICTIONARY' && groupOf(r, 5) === listH)!;
    expect(groupOf(list, 330)).toBe('C');
    expect(list.groups.filter(([c]) => c === 3).map(([, v]) => v)).toEqual(['A1', 'A2']);
    const scales = recs.filter((r) => r.type === 'SCALE');
    expect(scales.map((r) => groupOf(r, 5))).toEqual(list.groups.filter(([c]) => c === 350).map(([, v]) => v));
    expect(scales.map((r) => groupOf(r, 330))).toEqual([listH, listH]);
    /* the flat listing is gone: no scale straight under the named objects dictionary */
    expect(nod.groups.some(([c, v]) => c === 3 && (v === 'A1' || v === 'A2'))).toBe(false);
  });

  it('lists the WIPEOUTVARIABLES straight under the named objects dictionary and re-declares its class', () => {
    const wv = recs.find((r) => r.type === 'WIPEOUTVARIABLES')!;
    expect(groupOf(wv, 330)).toBe('C');
    const cls = recs.filter((r) => r.type === 'CLASS' && groupOf(r, 1) === 'WIPEOUTVARIABLES');
    expect(cls.length).toBe(1);
    expect(groupOf(cls[0], 2)).toBe('AcDbWipeoutVariables');
    expect(groupOf(cls[0], 3)).toBe(WIPEOUT_APP);
    expect(groupOf(cls[0], 281)).toBe('0');
  });

  it('leaves the FIELD out: its owner is rebuilt from the model without an extension dictionary', () => {
    expect(recs.some((r) => r.type === 'FIELD')).toBe(false);
    expect(text).not.toContain('{ACAD_XDICTIONARY');
  });

  it('still lists an unlisted record the named objects dictionary owns, under the fallback key', () => {
    const loose = recs.find((r) => r.type === 'ACME_LOOSE')!;
    expect(groupOf(loose, 330)).toBe('C');
    const nod = recs.find((r) => r.type === 'DICTIONARY' && groupOf(r, 5) === 'C')!;
    const key = nod.groups[nod.groups.findIndex(([, v]) => v === groupOf(loose, 5)) - 1];
    expect(key[0]).toBe(3);
    expect(key[1]).toMatch(/^SEALED_OBJECT_\d+$/);
  });

  it('the placement is stable across generations', () => {
    const second = readDxf(text);
    expect(byType(second, 'SCALE').map((o) => [o.dictPath, o.name]))
      .toEqual([[['ACAD_SCALELIST'], 'A1'], [['ACAD_SCALELIST'], 'A2']]);
    expect(byType(second, 'WIPEOUTVARIABLES')[0]?.dictPath).toEqual([]);
    expect(byType(second, 'FIELD')).toEqual([]);
  });
});

describe('a class whose spelling changed after R2000 does not travel from a later file', () => {
  it('TABLECONTENT from an AC1032 source stays out of the AC1015 file', () => {
    const d = readDxf(treeFixture('AC1032', true));
    expect(d.unknownObjects?.some((o) => o.sourceType === 'TABLECONTENT')).toBe(true);
    expect(recordsOf(writeDxf(d)).some((r) => r.type === 'TABLECONTENT')).toBe(false);
  });

  it('from an R2000 source it is in R2000 spelling and travels', () => {
    const d = readDxf(treeFixture('AC1015', true));
    expect(recordsOf(writeDxf(d)).some((r) => r.type === 'TABLECONTENT')).toBe(true);
  });

  it('the R2008+ value spelling itself (304 ACVALUE_END) keeps a record out, whatever the source declared', () => {
    const rows = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'OBJECTS',
      '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1',
      '3', 'ACAD_DATALINK', '350', 'L0', '3', 'ACAD_SCALELIST', '350', 'S0',
      '0', 'DICTIONARY', '5', 'L0', '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'Link1', '350', 'L1',
      '0', 'DATALINK', '5', 'L1', '330', 'L0', '100', 'AcDbDataLink', '1', 'AcExcel', '300', '',
      '305', 'CUSTOMDATA', '1', 'DATAMAP_BEGIN', '90', '1', '300', 'ACEXCEL_CONNECTION_STRING',
      '301', 'DATAMAP_VALUE', '93', '2', '90', '4', '1', 'book.xls!Sheet1', '94', '0', '300', '', '302', '',
      '304', 'ACVALUE_END', '309', 'DATAMAP_END',
      '0', 'DICTIONARY', '5', 'S0', '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'A1', '350', 'S1',
      '0', 'SCALE', '5', 'S1', '330', 'S0', '100', 'AcDbScale', '70', '0', '300', 'A1', '140', '1.0', '141', '1.0', '290', '1',
      '0', 'ENDSEC', '0', 'EOF', ''];
    const recs = recordsOf(writeDxf(readDxf(rows.join('\n'))));
    expect(recs.some((r) => r.type === 'DATALINK')).toBe(false);
    expect(recs.some((r) => r.type === 'SCALE')).toBe(true);
    /* and no dictionary is rebuilt for a record that stayed out */
    expect(recs.some((r) => r.type === 'DICTIONARY' && r.groups.some(([c, v]) => c === 3 && v === 'ACAD_DATALINK'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('column MTEXT: the recompose record and the repointed column handle', () => {
  const columns = (): Drawing => {
    const d = emptyDrawing();
    const mtext = (handle: string, text: string): Entity => ({
      type: 'mtext', handle, layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, text, height: 2.5, rotation: 0
    });
    const parent = mtext('136', 'first column');
    parent.xdata = [{ appName: 'ACAD', values: [
      { code: 1000, value: 'ACAD_MTEXT_COLUMN_INFO_BEGIN' }, { code: 1070, value: 75 }, { code: 1070, value: 1 },
      { code: 1000, value: 'ACAD_MTEXT_COLUMN_INFO_END' },
      { code: 1000, value: 'ACAD_MTEXT_COLUMNS_BEGIN' }, { code: 1070, value: 47 }, { code: 1070, value: 2 },
      { code: 1005, value: '19DC' }, { code: 1000, value: 'ACAD_MTEXT_COLUMNS_END' }
    ] }];
    d.entities = [parent, mtext('19DC', 'second column')];
    return d;
  };
  const text = writeDxf(columns());
  const recs = recordsOf(text);
  const [parentRec, childRec] = recs.filter((r) => r.type === 'MTEXT');

  it('names the parent in an ACDB_RECOMPOSE_DATA record under the named objects dictionary', () => {
    const nod = recs.find((r) => r.type === 'DICTIONARY' && groupOf(r, 5) === 'C')!;
    const at = nod.groups.findIndex(([c, v]) => c === 3 && v === 'ACDB_RECOMPOSE_DATA');
    expect(at).toBeGreaterThan(0);
    const h = nod.groups[at + 1][1];
    const xr = recs.find((r) => r.type === 'XRECORD' && groupOf(r, 5) === h)!;
    expect(groupOf(xr, 330)).toBe('C');
    const body = xr.groups.slice(xr.groups.findIndex(([c]) => c === 100) + 1);
    expect(body).toEqual([[280, '1'], [90, '1'], [330, groupOf(parentRec, 5)]]);
  });

  it('repoints the 1005 at the number the second column got', () => {
    const at = parentRec.groups.findIndex(([c]) => c === 1005);
    expect(parentRec.groups[at][1]).toBe(groupOf(childRec, 5));
    expect(groupOf(childRec, 5)).not.toBe('19DC');
  });

  it('a carried ACDB_RECOMPOSE_DATA is not doubled on the next generation', () => {
    const again = writeDxf(readDxf(text));
    expect(again.split('\nACDB_RECOMPOSE_DATA\n').length - 1).toBe(1);
    const xr = recordsOf(again).filter((r) => r.type === 'XRECORD');
    expect(xr.length).toBe(1);
  });
});

describe('carried header variables: the handle-valued ones stay home', () => {
  const rows = ['0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1015',
    '9', '$HANDSEED', '5', '102',
    '9', '$CMATERIAL', '347', 'ABC',
    '9', '$INTERFEREOBJVS', '345', 'ABD',
    '9', '$TDCREATE', '40', '2460000.5',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
    '0', 'ENDSEC', '0', 'EOF', ''];
  const text = writeDxf(readDxf(rows.join('\n')));

  it('writes one $HANDSEED, its own, above every handle in the file', () => {
    expect(text.split('\n$HANDSEED\n').length - 1).toBe(1);
    const seed = parseInt(text.split('\n$HANDSEED\n5\n')[1], 16);
    for (const h of ownHandles(text)) expect(parseInt(h, 16)).toBeLessThan(seed);
  });

  it('drops a pointer into the source numbering, keeps a plain variable', () => {
    expect(text).not.toContain('$CMATERIAL');
    expect(text).not.toContain('$INTERFEREOBJVS');
    expect(text).toContain('\n$TDCREATE\n40\n2460000.5\n');
  });
});

describe('a proxy object leaves in the reference\'s own group order', () => {
  it('version word and origin flag ahead of the data, 94 closing the record', () => {
    const d = emptyDrawing();
    d.proxyObjects = [{
      name: 'Link1', sourceType: 'OBJECT_PTR',
      appClass: { dxfName: 'OBJECT_PTR', cppName: 'CAseDLPNTableRecord', appName: 'ASE-LPNTableRecord' },
      proxyVersion: 27, proxyMaint: 50,
      xdata: [{ appName: 'DCO15', values: [{ code: 1000, value: 'x' }] }]
    }];
    const rec = recordsOf(writeDxf(d)).find((r) => r.type === 'ACAD_PROXY_OBJECT')!;
    const codes = rec.groups.map(([c]) => c);
    expect(codes.slice(codes.indexOf(100))).toEqual([100, 90, 91, 95, 70, 94, 1001, 1000]);
    expect(groupOf(rec, 95)).toBe(String(50 * 0x10000 + 27));
  });
});
