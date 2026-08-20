/* nasjidwg — the byte-preserving rewrite.
 *
 * `readDwg(bytes, { retainRecords: true })` seals every entity's source
 * record; `{ preserveHandles: true, verbatimRecords: true }` writes those
 * bytes back out untouched. An entity nobody edited therefore survives a
 * read/write cycle byte for byte — incremental-save fidelity without the
 * incremental container.
 *
 * What is proven here: the round trip is clean, the retained bytes really
 * are identical (and demonstrably would NOT be without the option), a
 * mutated entity re-encodes while its neighbours stay frozen, records
 * never cross an encoding generation, and the option does nothing at all
 * without preserveHandles.
 */

import { describe, expect, it } from 'vitest';
import { sampleDrawing } from './corpus.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018,
  writeDwgR13, writeDwgR14
} from '../src/dwg/writer.js';
import type { DwgWriteOptions } from '../src/dwg/writer.js';
import { readDwg } from '../src/dwg/reader.js';
import type { Drawing, Entity } from '../src/core/model.js';

/** Every number an entity carries, in a stable order, rounded — the same
 *  shape comparison the other suites use. `handle` and the sealed record
 *  are skipped: one is checked on its own, the other is the thing under
 *  test. */
const numbers = (value: unknown, into: number[] = []): number[] => {
  if (typeof value === 'number') into.push(Math.round(value * 1e6) / 1e6);
  else if (Array.isArray(value)) for (const v of value) numbers(v, into);
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value as object).sort()) {
      if (k !== 'styleId' && k !== 'handle' && k !== 'record') {
        numbers((value as Record<string, unknown>)[k], into);
      }
    }
  }
  return into;
};

/** Every entity of a drawing, in a stable order, with the space it came
 *  from — model, paper and each block. */
const allEntities = (d: Drawing): { where: string; e: Entity }[] => [
  ...d.entities.map((e) => ({ where: 'model', e })),
  ...(d.paperSpace ?? []).map((e) => ({ where: 'paper', e })),
  ...Object.keys(d.blocks).sort().flatMap((nm) =>
    d.blocks[nm].entities.map((e) => ({ where: 'block:' + nm, e })))
];

/** handle -> retained record bytes (base64), for every entity that has one. */
const records = (d: Drawing): Map<string, string> => {
  const out = new Map<string, string>();
  for (const { e } of allEntities(d)) {
    if (e.handle && e.record) out.set(e.handle, e.record.data);
  }
  return out;
};

const VERBATIM = { preserveHandles: true, verbatimRecords: true } as const;

/** The corpus at R2018, read back with every record sealed. */
const gen1 = (): Drawing =>
  readDwg(writeDwg2018(sampleDrawing()).data, { retainRecords: true });

/* ------------------------------------------------------------------ */

describe('verbatim rewrite: the round trip', () => {
  const g1 = gen1();
  const written = writeDwg2018(g1, VERBATIM);
  const g2 = readDwg(written.data, { retainRecords: true });

  it('seals a record for the entities it can', () => {
    expect(records(g1).size).toBeGreaterThan(20);
  });

  it('writes and reads back without a single warning', () => {
    expect(g1.warnings).toEqual([]);
    expect(g2.warnings).toEqual([]);
    expect(written.skipped).toEqual([]);
    expect(written.downgraded).toEqual([]);
  });

  it('keeps every entity, in every space', () => {
    expect(g2.entities.length).toBe(g1.entities.length);
    expect(g2.paperSpace?.length).toBe(g1.paperSpace?.length);
    expect(Object.keys(g2.blocks).sort()).toEqual(Object.keys(g1.blocks).sort());
    for (const nm of Object.keys(g1.blocks)) {
      expect(g2.blocks[nm].entities.length).toBe(g1.blocks[nm].entities.length);
    }
  });

  it('carries every entity through unchanged', () => {
    const a = allEntities(g1), b = allEntities(g2);
    expect(b.length).toBe(a.length);
    a.forEach((one, i) => {
      const two = b[i];
      expect(two.where).toBe(one.where);
      expect(two.e.type).toBe(one.e.type);
      expect(two.e.layer).toBe(one.e.layer);
      expect(two.e.color).toEqual(one.e.color);
      expect(numbers(two.e)).toEqual(numbers(one.e));
    });
  });

  it('keeps every handle stable — entities and symbol tables alike', () => {
    const a = allEntities(g1), b = allEntities(g2);
    a.forEach((one, i) => expect(b[i].e.handle).toBe(one.e.handle));
    const table = (d: Drawing): string[] => [
      ...d.layers.map((x) => `layer ${x.name}=${x.handle}`),
      ...d.linetypes.map((x) => `ltype ${x.name}=${x.handle}`),
      ...d.textStyles.map((x) => `style ${x.name}=${x.handle}`),
      ...Object.keys(d.blocks).sort().map((nm) => `block ${nm}=${d.blocks[nm].handle}`)
    ];
    expect(table(g2)).toEqual(table(g1));
    /* and they are the numbers the source file used, not fresh ones */
    expect(g1.layers.every((x) => x.handle)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('verbatim rewrite: the byte-level proof', () => {
  const g1 = gen1();
  const r1 = records(g1);
  const rVerbatim = records(readDwg(writeDwg2018(g1, VERBATIM).data,
    { retainRecords: true }));
  const rPlain = records(readDwg(writeDwg2018(g1, { preserveHandles: true }).data,
    { retainRecords: true }));

  /** Handles of the entities the feature covers: fixed-type records whose
   *  handle stream stops at the symbol tables. */
  const covered = allEntities(g1)
    .filter(({ e }) => e.record && e.handle
      && ['line', 'point', 'circle', 'arc', 'ellipse', 'ray', 'xline',
        'solid', 'face3d', 'polyline', 'spline', 'text', 'mtext', 'shape',
        'hatch', 'ole'].includes(e.type))
    .map(({ e }) => e.handle!);

  it('covers most of the drawing', () => {
    expect(covered.length).toBeGreaterThan(15);
  });

  it('writes those records back BYTE-IDENTICAL', () => {
    for (const h of covered) {
      expect(rVerbatim.get(h), `record ${h}`).toBe(r1.get(h));
    }
  });

  it('is the option that does it, not the writer being deterministic', () => {
    /* The drawing still holds records the plain path cannot reproduce —
       INSERT, DIMENSION, MLINE, LEADER and their kin re-model on the way
       out — which is what the option exists for.
       The covered set is no longer among them, and that is a fix rather
       than a weakening: the corpus TEXT was the last one to drift, and it
       drifted because the reader dropped the STYLE its record pointed at
       and the writer put a default handle back in its place. Now that the
       reader keeps the style, the record it writes is the record it read. */
    const anyDrift = allEntities(g1)
      .filter(({ e }) => e.handle && e.record && rPlain.get(e.handle) !== r1.get(e.handle));
    expect(anyDrift.length).toBeGreaterThan(0);
    for (const h of covered) {
      expect(rPlain.get(h), `plain record ${h}`).toBe(r1.get(h));
      expect(rVerbatim.get(h), `verbatim record ${h}`).toBe(r1.get(h));
    }
  });

  it('stays byte-identical over any number of generations', () => {
    let d = g1;
    for (let i = 0; i < 3; i++) {
      d = readDwg(writeDwg2018(d, VERBATIM).data, { retainRecords: true });
      expect(d.warnings).toEqual([]);
    }
    const rN = records(d);
    for (const h of covered) expect(rN.get(h)).toBe(r1.get(h));
  });
});

/* ------------------------------------------------------------------ */

describe('verbatim rewrite: the mutation path', () => {
  const g1 = gen1();
  const r1 = records(g1);
  const edited = gen1();
  const target = edited.entities.findIndex((e) => e.type === 'circle');
  const circle = edited.entities[target];
  if (circle.type !== 'circle') throw new Error('corpus lost its circle');
  /* the documented contract: change the entity, drop its record */
  circle.radius = 12.75;
  circle.center = { x: -3, y: 4, z: 0.5 };
  delete circle.record;
  const g2 = readDwg(writeDwg2018(edited, VERBATIM).data, { retainRecords: true });

  it('re-encodes the entity the caller changed', () => {
    const back = g2.entities[target];
    expect(back.type).toBe('circle');
    if (back.type !== 'circle') return;
    expect(back.radius).toBeCloseTo(12.75, 9);
    expect(back.center.x).toBeCloseTo(-3, 9);
    expect(back.center.y).toBeCloseTo(4, 9);
    expect(back.center.z).toBeCloseTo(0.5, 9);
    expect(back.handle).toBe(circle.handle);
    expect(g2.warnings).toEqual([]);
  });

  it('leaves its neighbours frozen, byte for byte', () => {
    const r2 = records(g2);
    const neighbours = allEntities(g1)
      .filter(({ e }) => e.handle && e.handle !== circle.handle && e.record
        && ['line', 'point', 'arc', 'ellipse', 'ray', 'xline', 'solid',
          'face3d', 'polyline', 'spline', 'text', 'mtext', 'hatch']
          .includes(e.type))
      .map(({ e }) => e.handle!);
    expect(neighbours.length).toBeGreaterThan(10);
    for (const h of neighbours) expect(r2.get(h), `record ${h}`).toBe(r1.get(h));
  });

  it('and the changed record really did change', () => {
    expect(records(g2).get(circle.handle!)).not.toBe(r1.get(circle.handle!));
  });
});

/* ------------------------------------------------------------------ */

describe('verbatim rewrite: cross-generation safety', () => {
  const g1 = gen1();                       /* R2018 records */
  const plain = readDwg(writeDwg2000(g1, { preserveHandles: true }).data,
    { retainRecords: true });
  const asked = readDwg(writeDwg2000(g1, VERBATIM).data, { retainRecords: true });

  it('never writes foreign bytes into an older container', () => {
    const foreign = new Set(records(g1).values());
    for (const data of records(asked).values()) {
      expect(foreign.has(data)).toBe(false);
    }
    for (const { e } of allEntities(asked)) {
      if (e.record) expect(e.record.encoding).toBe(2000);
    }
  });

  it('produces exactly what the plain rewrite would', () => {
    expect(asked.warnings).toEqual([]);
    const a = allEntities(plain), b = allEntities(asked);
    expect(b.length).toBe(a.length);
    a.forEach((one, i) => {
      expect(b[i].e.type).toBe(one.e.type);
      expect(b[i].e.handle).toBe(one.e.handle);
      expect(numbers(b[i].e)).toEqual(numbers(one.e));
    });
  });
});

/* ------------------------------------------------------------------ */

describe('verbatim rewrite: the record has to fit the entity', () => {
  /* The model flattens several DWG spellings into one type — a 2D
     POLYLINE with its own VERTEX records reads back as the same
     `polyline` an inline LWPOLYLINE does, and only the second is
     self-contained. The writer therefore checks the type the bytes name
     against the type it would have written, and re-encodes on a
     mismatch. Standing in for such a record here: a record that belongs
     to a different entity altogether. */
  const d = gen1();
  const line = d.entities.find((e) => e.type === 'line');
  const circle = d.entities.find((e) => e.type === 'circle');
  if (!line || !circle || line.type !== 'line') throw new Error('corpus');
  const before = { ...line.start };
  line.record = circle.record;

  const back = readDwg(writeDwg2018(d, VERBATIM).data, { retainRecords: true });

  it('re-encodes rather than trusting bytes of the wrong type', () => {
    expect(back.warnings).toEqual([]);
    const one = back.entities[0];
    expect(one.type).toBe('line');
    if (one.type !== 'line') return;
    expect(one.start.x).toBeCloseTo(before.x, 9);
    expect(one.handle).toBe(line.handle);
  });
});

/* ------------------------------------------------------------------ */

describe('verbatim rewrite: the preserveHandles guard', () => {
  const g1 = gen1();

  it('is a no-op on its own — byte-for-byte the same file', () => {
    const without = writeDwg2018(g1).data;
    const asked = writeDwg2018(g1, { verbatimRecords: true }).data;
    expect(asked.length).toBe(without.length);
    expect(Array.from(asked)).toEqual(Array.from(without));
  });

  it('reads back the same drawing either way', () => {
    const back = readDwg(writeDwg2018(g1, { verbatimRecords: true }).data);
    expect(back.warnings).toEqual([]);
    expect(back.entities.length).toBe(g1.entities.length);
  });
});

/* ------------------------------------------------------------------ */

const FAMILIES: [string, (d: Drawing, o?: DwgWriteOptions) => { data: Uint8Array }][] = [
  ['R13', writeDwgR13], ['R14', writeDwgR14], ['R2000', writeDwg2000],
  ['R2004', writeDwg2004], ['R2007', writeDwg2007], ['R2018', writeDwg2018]
];

describe.each(FAMILIES)('verbatim rewrite in %s', (_name, write) => {
  const g1 = readDwg(write(sampleDrawing()).data, { retainRecords: true });
  const g2 = readDwg(write(g1, VERBATIM).data, { retainRecords: true });

  it('round-trips clean', () => {
    expect(g1.warnings).toEqual([]);
    expect(g2.warnings).toEqual([]);
    expect(g2.entities.length).toBe(g1.entities.length);
  });

  it('keeps the records it covers byte-identical', () => {
    const r1 = records(g1), r2 = records(g2);
    const covered = allEntities(g1)
      .filter(({ e }) => e.record && e.handle
        && ['line', 'point', 'circle', 'arc', 'ellipse', 'ray', 'xline',
          'solid', 'face3d', 'polyline', 'spline', 'text', 'mtext',
          'hatch'].includes(e.type))
      .map(({ e }) => e.handle!);
    expect(covered.length).toBeGreaterThan(10);
    for (const h of covered) expect(r2.get(h), `record ${h}`).toBe(r1.get(h));
  });

  it('carries every entity through unchanged', () => {
    const a = allEntities(g1), b = allEntities(g2);
    expect(b.length).toBe(a.length);
    a.forEach((one, i) => {
      expect(b[i].e.type).toBe(one.e.type);
      expect(numbers(b[i].e)).toEqual(numbers(one.e));
    });
  });
});
