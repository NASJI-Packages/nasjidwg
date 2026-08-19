/* nasjidwg — SORTENTSTABLE draw order.
 *
 * DWG and DXF both hand a viewer their entities in an array, and the
 * array order IS the draw order — but a file whose entities were
 * reordered after creation says so through a SORTENTSTABLE: entry i
 * pairs an entity with a sort key, drawing runs by ascending key, and an
 * entity no entry names sorts under its own handle. The claims under
 * test: both readers apply the table (in place, so a consumer needs no
 * new API), the DWG writers emit one under preserveHandles exactly when
 * the array order differs from ascending handle order, and a default
 * write — whose fresh handles ascend in array order — carries no table
 * at all.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2018 } from '../src/dwg/writer.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

/** Array order point, line, circle — handles descending 30, 20, 10, so
 *  a reader that walks the (handle-sorted) object map sees the reverse
 *  unless the draw-order table corrects it. */
const reordered = (): Drawing => {
  const d = emptyDrawing();
  d.entities = [
    {
      type: 'point', handle: '30', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }
    },
    {
      type: 'line', handle: '20', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
    },
    {
      type: 'circle', handle: '10', layer: '0', color: { kind: 'byLayer' },
      center: { x: 0, y: 0, z: 0 }, radius: 1
    }
  ] as Entity[];
  return d;
};

const types = (d: Drawing): string[] => d.entities.map((e) => e.type);

/** Whether the ASCII text occurs anywhere in the file at ANY bit shift —
 *  DWG records are bit-packed, so a class name rarely lands on a byte. */
const carriesName = (bytes: Uint8Array, text: string): boolean => {
  let hay = '';
  for (const b of bytes) hay += b.toString(2).padStart(8, '0');
  let needle = '';
  for (let i = 0; i < text.length; i++) {
    needle += text.charCodeAt(i).toString(2).padStart(8, '0');
  }
  return hay.includes(needle);
};

describe('SORTENTSTABLE through DWG', () => {
  it.each([['R2000', writeDwg2000], ['R2018', writeDwg2018]] as const)(
    '%s preserveHandles: array order survives, not handle order',
    (_v, writer) => {
      const { data, skipped } = writer(reordered(), { preserveHandles: true });
      expect(skipped).toEqual([]);
      const back = readDwg(data);
      expect(back.warnings).toEqual([]);
      expect(types(back)).toEqual(['point', 'line', 'circle']);
      expect(back.entities.map((e) => e.handle)).toEqual(['30', '20', '10']);
      /* nothing sealed: the table is consumed, not carried as an object */
      expect(back.unknownObjects ?? []).toEqual([]);
    });

  it('the table survives a second preserved generation', () => {
    const once = readDwg(
      writeDwg2018(reordered(), { preserveHandles: true }).data);
    const twice = readDwg(
      writeDwg2018(once, { preserveHandles: true }).data);
    expect(types(twice)).toEqual(['point', 'line', 'circle']);
  });

  it('no table when nothing needs one', () => {
    /* ascending handles in array order: preserved, but already sorted */
    const d = reordered();
    d.entities.reverse();                 /* circle 10, line 20, point 30 */
    const sorted = writeDwg2000(d, { preserveHandles: true }).data;
    expect(carriesName(sorted, 'SORTENTSTABLE')).toBe(false);
    expect(types(readDwg(sorted))).toEqual(['circle', 'line', 'point']);
    /* a default write renumbers in array order — no table either, and
       the array order still comes back */
    const fresh = writeDwg2000(reordered()).data;
    expect(carriesName(fresh, 'SORTENTSTABLE')).toBe(false);
    expect(types(readDwg(fresh))).toEqual(['point', 'line', 'circle']);
    /* positive control: the preserved out-of-order file DOES carry one */
    const tabled = writeDwg2000(reordered(), { preserveHandles: true }).data;
    expect(carriesName(tabled, 'SORTENTSTABLE')).toBe(true);
  });
});

describe('SORTENTSTABLE through DXF', () => {
  it('DWG and DXF read the same drawing in the same order', () => {
    const viaDwg = readDwg(
      writeDwg2018(reordered(), { preserveHandles: true }).data);
    const viaDxf = readDxf(writeDxf(reordered()));
    expect(types(viaDxf)).toEqual(types(viaDwg));
  });

  /** A hand-written table over three lines. The object's OWN handle is a
   *  group 5 too and sits before the AcDbSortentsTable marker — a parser
   *  that collects every 5 misaligns the pairs (the pinned trap). */
  const dxfWith = (tableGroups: string[]): string => [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', '10', '8', '0',
    '10', '1.0', '20', '0.0', '11', '1.0', '21', '1.0',
    '0', 'LINE', '5', '20', '8', '0',
    '10', '2.0', '20', '0.0', '11', '2.0', '21', '1.0',
    '0', 'LINE', '5', '30', '8', '0',
    '10', '3.0', '20', '0.0', '11', '3.0', '21', '1.0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'OBJECTS',
    '0', 'SORTENTSTABLE',
    '5', 'A0',                            /* own handle — NOT a sort key */
    '330', 'C0',
    '100', 'AcDbSortentsTable',
    '330', '1F',                          /* block record owner */
    ...tableGroups,
    '0', 'ENDSEC',
    '0', 'EOF', ''
  ].join('\n');

  it('applies a hand-written table (pairs strictly after the marker)', () => {
    const d = readDxf(dxfWith([
      '331', '10', '5', '30',             /* line 10 sorts as 30 */
      '331', '30', '5', '10'              /* line 30 sorts as 10 */
    ]));
    expect(d.warnings).toEqual([]);
    expect(d.unknownObjects ?? []).toEqual([]);
    const xs = d.entities.map((e) => e.type === 'line' ? e.start.x : NaN);
    /* keys: 30→10, 20→20 (own handle), 10→30 — the run reverses */
    expect(xs).toEqual([3, 2, 1]);
  });

  it('an empty table and an unknown-handle table are both no-ops', () => {
    const empty = readDxf(dxfWith([]));
    expect(empty.entities.map((e) => e.type === 'line' ? e.start.x : NaN))
      .toEqual([1, 2, 3]);
    const dangling = readDxf(dxfWith(['331', '999', '5', '1']));
    expect(dangling.entities.map((e) => e.type === 'line' ? e.start.x : NaN))
      .toEqual([1, 2, 3]);
    expect(dangling.warnings).toEqual([]);
  });
});
