/* nasjidwg — the R2013+ SPLINE scenario spelling.
 *
 * From R2013 on the record's leading BL is ALWAYS 1 and the truth moves
 * into the two flag longs: a fit-point spline is splineflags 9 with
 * chord knot parametrization (0), a control-point spline is splineflags
 * 0 with custom knots (15). That is what AutoCAD writes for every one
 * of the 17,391 splines of the reference field drawing and for a fresh
 * 2027 save alike. Writing the pre-2013 scenario-2 spelling instead
 * made AutoCAD 2027 FATAL ("AutoCAD cannot continue") while
 * regenerating the model — our own reader accepts both spellings, so
 * only the external oracle ever saw the difference. These tests pin the
 * on-disk longs, not just the round trip.
 */

import { describe, expect, it } from 'vitest';
import { BitReader } from '../src/dwg/bitstream.js';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { readObjectMap } from '../src/dwg/objectmap.js';
import { readClasses } from '../src/dwg/classes.js';
import { makeContext, decodeObjectBody } from '../src/dwg/objects.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

const fitSpline = (): Extract<Entity, { type: 'spline' }> => ({
  type: 'spline', layer: '0', color: { kind: 'byLayer' },
  degree: 3, controlPoints: [], knots: [],
  fitPoints: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }, { x: 10, y: 0, z: 0 }]
});

const ctrlSpline = (): Extract<Entity, { type: 'spline' }> => ({
  type: 'spline', layer: '0', color: { kind: 'byLayer' },
  degree: 3,
  controlPoints: [
    { x: 0, y: 0, z: 0 }, { x: 3, y: 8, z: 0 },
    { x: 7, y: 8, z: 0 }, { x: 10, y: 0, z: 0 }
  ],
  knots: [0, 0, 0, 0, 1, 1, 1, 1]
});

const one = (e: Entity): Drawing => {
  const d = emptyDrawing();
  d.entities = [e];
  return d;
};

/** Locate the drawing's SPLINE record and capture the BL run its body
 *  decode performs: [reactors, scenario, splineflags, knotparam,
 *  degree]. The capture shims BitReader.bl around decodeObjectBody on
 *  that record alone — the exact primitive any consumer parses the
 *  field with, gated to the one record under test. */
const splineBls = (data: Uint8Array): number[] => {
  const sections = readSections2004(data);
  const objectSpace = sections.get('AcDb:AcDbObjects')!;
  const classesSection = sections.get('AcDb:Classes');
  const classes = classesSection
    ? readClasses(classesSection, 'R2018', undefined) : new Map();
  const ctx = makeContext('R2018', classes, undefined, data[0x11]);
  const omap = readObjectMap(sections.get('AcDb:Handles')!);
  for (let mi = 0; mi < omap.count; mi++) {
    let p = omap.offsets[mi];
    let size = 0, shift = 0;
    for (;;) {
      const word = objectSpace[p] | (objectSpace[p + 1] << 8);
      p += 2;
      size += (word & 0x7fff) * 2 ** shift;
      if (!(word & 0x8000)) break;
      shift += 15;
    }
    let hs = 0, hshift = 0;
    for (;;) {
      const b = objectSpace[p++];
      hs += (b & 0x7f) * 2 ** hshift;
      if (!(b & 0x80)) break;
      hshift += 7;
    }
    const body = objectSpace.subarray(p, p + size);
    const r = new BitReader(body);
    const bb = r.bb();
    const type = bb === 0 ? r.rc() : bb === 1 ? r.rc() + 0x1f0 : r.rs();
    if (type !== 36) continue;            /* SPLINE */
    const captured: number[] = [];
    const orig = BitReader.prototype.bl;
    BitReader.prototype.bl = function (this: BitReader): number {
      const v = orig.call(this);
      if (captured.length < 5) captured.push(v);
      return v;
    };
    try {
      decodeObjectBody(body, ctx, size * 8 - hs);
    } finally {
      BitReader.prototype.bl = orig;
    }
    return captured;
  }
  throw new Error('no SPLINE record in the file');
};

describe('R2018 SPLINE scenario longs match AutoCAD', () => {
  it('fit-point spline: scenario 1, splineflags 9, chord knots', () => {
    const bytes = writeDwg2018(one(fitSpline())).data;
    const bls = splineBls(bytes);
    expect(bls[0]).toBe(0);               /* reactor count */
    expect(bls[1]).toBe(1);               /* scenario: always 1 from 2013 */
    expect(bls[2]).toBe(9);               /* splineflags: fit method */
    expect(bls[3]).toBe(0);               /* knot param: chord */
    expect(bls[4]).toBe(3);               /* degree */
    const back = readDwg(bytes);
    const sp = back.entities.find((e) => e.type === 'spline');
    expect(sp && sp.type === 'spline' && sp.fitPoints?.length).toBe(3);
  });

  it('control-point spline: scenario 1, splineflags 0, custom knots', () => {
    const bytes = writeDwg2018(one(ctrlSpline())).data;
    const bls = splineBls(bytes);
    expect(bls[0]).toBe(0);               /* reactor count */
    expect(bls[1]).toBe(1);               /* scenario */
    expect(bls[2]).toBe(0);               /* splineflags: control points */
    expect(bls[3]).toBe(15);              /* knot param: custom */
    expect(bls[4]).toBe(3);               /* degree */
    const back = readDwg(bytes);
    const sp = back.entities.find((e) => e.type === 'spline');
    expect(sp && sp.type === 'spline' && sp.controlPoints.length).toBe(4);
  });
});
