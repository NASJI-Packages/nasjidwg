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
 *
 * The fixtures are hand-written token by token, so the tests pin the
 * format knowledge itself rather than another program's output.
 */

import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf, writeDxfBinary } from '../src/dxf/writer.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { readDwg } from '../src/dwg/reader.js';
import type { Drawing, UnknownEntity } from '../src/core/model.js';

/* The fictional entity's tags, in the exact order the file carries them.
 * Deliberately exotic: a fenced extension dictionary, a fenced reactor
 * list whose 330 must NOT be mistaken for the owner, a string value with
 * leading and trailing spaces, a float spelled to seventeen digits, two
 * binary 310 chunks and an xdata run. */
const ENTITY_TAGS: [number, string][] = [
  [5, '1A2B'],                             /* 0: the handle — replaced */
  [102, '{ACAD_XDICTIONARY'],              /* 1 */
  [360, 'DEAD'],                           /* 2: fenced — verbatim */
  [102, '}'],                              /* 3 */
  [102, '{ACAD_REACTORS'],                 /* 4 */
  [330, 'FEED'],                           /* 5: fenced 330 — verbatim */
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
const HANDLE_AT = 0;
const OWNER_AT = 7;
const FLOAT_AT = 15;
/* the model-space BLOCK_RECORD handle the writer owns */
const MS_OWNER = '1F';

const entityFixture = (): string => {
  const rows: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  rows.push('0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1');
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
  source: readonly [number, string][],
  owner: string
): void => {
  expect(tags?.length).toBe(source.length);
  for (let i = 0; i < source.length; i++) {
    const [c, v] = source[i];
    const [c2, v2] = tags![i];
    expect(c2, `code at ${i}`).toBe(c);
    if (i === HANDLE_AT) {
      expect(v2).toMatch(/^[0-9A-F]+$/);
      expect(v2).not.toBe(v);
    } else if (i === OWNER_AT) {
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
    expectSubstitutedOnly(u2?.tags, ENTITY_TAGS, MS_OWNER);
  });

  it('does not confuse a fenced reactor 330 with the owner', () => {
    expect(u2?.tags?.[5]).toEqual([330, 'FEED']);
    expect(u2?.tags?.[2]).toEqual([360, 'DEAD']);
  });

  it('the seventeen-digit float survives byte-for-byte', () => {
    expect(u2?.tags?.[FLOAT_AT]).toEqual([40, '1.5000000000000001']);
  });

  it('does not double the xdata: the 1001 run appears once', () => {
    const text = writeDxf(first);
    expect(text.split('\n1001\nACME_APP\n').length - 1).toBe(1);
    /* and the application it names is registered, as DXFIN requires */
    expect(text).toContain('\nAcDbRegAppTableRecord\n2\nACME_APP\n');
  });

  it('a third generation is stable except the fresh handle', () => {
    const third = readDxf(writeDxf(second));
    const u3 = findUnknown(third);
    expect(u3?.tags?.length).toBe(u2?.tags?.length);
    for (let i = 0; i < ENTITY_TAGS.length; i++) {
      if (i === HANDLE_AT) continue;
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
    expect(u?.tags?.map(([c]) => c)).toEqual(ENTITY_TAGS.map(([c]) => c));
  });

  it('strings keep their spaces, chunks their hex, integers their text', () => {
    expect(u?.tags?.[14]).toEqual([1, '  leading and trailing  ']);
    expect(u?.tags?.[16]).toEqual([310, 'DEADBEEF0102030405']);
    expect(u?.tags?.[17]).toEqual([310, 'CAFEBABE']);
    expect(u?.tags?.[10]).toEqual([62, '5']);
    expect(u?.tags?.[19]).toEqual([1070, '42']);
    expect(u?.tags?.[20]).toEqual([1040, '3.75']);
    expect(u?.tags?.[OWNER_AT]).toEqual([330, MS_OWNER]);
  });

  it('floats survive as the same double in canonical form', () => {
    const [code, v] = u!.tags![FLOAT_AT];
    expect(code).toBe(40);
    expect(parseFloat(v)).toBe(parseFloat('1.5000000000000001'));
    expect(String(parseFloat(v))).toBe(v);   /* already canonical */
  });

  it('is stable across a second binary generation', () => {
    const again = readDxf(writeDxfBinary(viaBin));
    const u2 = findUnknown(again);
    expect(u2?.tags?.length).toBe(u?.tags?.length);
    for (let i = 0; i < ENTITY_TAGS.length; i++) {
      if (i === HANDLE_AT) continue;
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
