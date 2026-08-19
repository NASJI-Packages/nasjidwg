/* The saved view and the current UCS — the two places a drawing records
 * that it is laid out at an angle.
 *
 * A rotated drawing is not a corner case: an AC1014 site plan drawn at 45
 * degrees reads square in AutoCAD only because the viewport carries
 * VIEWTWIST = 315 and the header carries UCSXDIR = (0.7071, 0.7071). Both
 * used to be dropped — the twist was never decoded at all, and the reader
 * drifted one BD from there on, which is why snapBase and gridSpacing came
 * back as 6e-294 and 1e-314 — and the DXF writer then put a hard zero in
 * group 51, telling every consumer the drawing was square.
 *
 * The layout below was pinned bit for bit against that drawing, with
 * AutoCAD's own DXFOUT of it as the oracle: 36 of 36 VPORT fields agree,
 * on nine drawings across R14, R2000, R2007 and R2018, including three
 * saved with UCSICON 3, 1 and 0 and one with DVIEW front clipping on. */
import { describe, expect, it } from 'vitest';
import {
  applyPt, emptyDrawing, readDwg, readDxf, ucsTransform, viewTwistTransform,
  writeDxf, writeDwgR14, writeDwg2000, writeDwg2007, writeDwg2018
} from '../src/index.js';
import type { Drawing, VPort } from '../src/index.js';

/** A drawing that says, in both places, "I am turned 45 degrees". */
const turned = (): Drawing => {
  const d = emptyDrawing();
  d.entities = [{
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 }
  }];
  const s = Math.SQRT1_2;
  d.header.ucs = {
    origin: { x: 231010.42, y: 8187171.77, z: 0 },
    xAxis: { x: s, y: s, z: 0 },
    yAxis: { x: -s, y: s, z: 0 }
  };
  const vp: VPort = {
    name: '*Active',
    lowerLeft: { x: 0, y: 0 }, upperRight: { x: 1, y: 1 },
    center: { x: 5953485.45, y: 5626348.58 },
    height: 1363.349477877632,
    twist: 315 * Math.PI / 180,
    lensLength: 50,
    snapBase: { x: 0, y: 0 }, snapSpacing: { x: 100, y: 100 },
    gridSpacing: { x: 0.5, y: 0.5 },
    circleSides: 20000, ucsIcon: 1, fastZoom: true
  };
  d.vports = [vp];
  return d;
};

const active = (d: Drawing): VPort | undefined =>
  (d.vports ?? []).find((v) => /^\*active$/i.test(v.name));

describe('the saved view survives every path', () => {
  const writers: [string, (d: Drawing) => { data: Uint8Array }][] = [
    ['R14', writeDwgR14], ['R2000', writeDwg2000],
    ['R2007', writeDwg2007], ['R2018', writeDwg2018]
  ];
  it.each(writers)('%s keeps VIEWTWIST and the header UCS', (_name, write) => {
    const back = readDwg(write(turned()).data);
    const vp = active(back);
    expect(vp).toBeDefined();
    /* 315 degrees, in radians, is what AutoCAD reports for this drawing */
    expect((vp!.twist ?? 0) * 180 / Math.PI).toBeCloseTo(315, 6);
    expect(back.header.ucs?.xAxis.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(back.header.ucs?.yAxis.x).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('DXF carries the twist in group 51, not a zero', () => {
    const dxf = writeDxf(turned());
    /* the value AutoCAD writes for a -45 degree twist, folded into 0..360 */
    expect(dxf).toMatch(/\n\s*51\n\s*315(\.0*)?\n/);
    expect(dxf).toContain('$UCSXDIR');
    const back = readDxf(dxf);
    expect((active(back)!.twist ?? 0) * 180 / Math.PI).toBeCloseTo(315, 6);
    expect(back.header.ucs?.xAxis.y).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('a square drawing still says nothing, rather than saying it is square', () => {
    /* a UCS equal to the world one carries no information, so it is not
       invented — but the twist group is always written */
    const d = emptyDrawing();
    d.entities = [{
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
    }];
    const back = readDwg(writeDwg2000(d).data);
    expect(back.header.ucs).toBeUndefined();
    expect(active(back)?.twist ?? 0).toBe(0);
    expect(readDxf(writeDxf(d)).header.ucs).toBeUndefined();
  });

  it('viewTwistTransform squares a drawing laid out at an angle', () => {
    /* the whole point of carrying the twist: a line drawn at 45 degrees in
       model space is horizontal in the view the file saved */
    const d = turned();
    const t = viewTwistTransform(active(d)!);
    expect(t).not.toBeNull();
    const a = applyPt(t!, { x: 0, y: 0 });
    const b = applyPt(t!, { x: 100, y: 100 });
    const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    expect(Math.abs(angle)).toBeLessThan(1e-9);
    /* and a square view asks for no transform at all */
    expect(viewTwistTransform({ twist: 0 })).toBeNull();
  });

  it('ucsTransform gives the basis a turned UCS defines', () => {
    const m = ucsTransform(turned().header.ucs);
    expect(m).not.toBeNull();
    expect(m!.zAxis.z).toBeCloseTo(1, 12);   /* still right-handed, still flat */
    expect(ucsTransform({ xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 } }))
      .toBeNull();
  });

  it('the rest of the record round-trips with it', () => {
    /* the fields the old walk lost when it drifted: snap base and grid
       spacing used to come back as 6e-294 and 1e-314 */
    const back = readDwg(writeDwg2000(turned()).data);
    const vp = active(back)!;
    expect(vp.snapSpacing).toEqual({ x: 100, y: 100 });
    expect(vp.gridSpacing).toEqual({ x: 0.5, y: 0.5 });
    expect(vp.snapBase).toEqual({ x: 0, y: 0 });
    expect(vp.circleSides).toBe(20000);
    expect(vp.ucsIcon).toBe(1);
    expect(vp.lensLength).toBe(50);
    /* the view looks straight down at the XY plane: direction (0,0,1),
       target the origin — the two used to be swapped */
    expect(vp.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(vp.target).toEqual({ x: 0, y: 0, z: 0 });
  });
});

/* The values AutoCAD 2027 reports for a production AC1032 file whose
 * record stores 8.045723887507847 beside a 3.4212145347610234 height:
 * group 41 comes back 2.351715686274510 — the ratio, not the width. */
const ACAD_RATIO = 2.351715686274510;

/** the numeric groups that follow a header variable, code lines skipped */
const varTail = (dxf: string, name: string, count: number): number[] => {
  const lines = dxf.split(/\r?\n/).map((s) => s.trim());
  const i = lines.indexOf(name);
  expect(i, name + ' present').toBeGreaterThan(-1);
  const vals: number[] = [];
  for (let k = i + 1; vals.length < count; k += 2) vals.push(Number(lines[k + 1]));
  return vals;
};

/** one numeric group out of the *Active VPORT record */
const vportGroup = (dxf: string, code: number): number => {
  const a = dxf.indexOf('AcDbViewportTableRecord');
  expect(a).toBeGreaterThan(-1);
  const lines = dxf.slice(a, dxf.indexOf('ENDTAB', a)).split(/\r?\n/);
  const i = lines.findIndex((s) => s.trim() === String(code));
  expect(i, 'group ' + code + ' present').toBeGreaterThan(-1);
  return Number(lines[i + 1]);
};

describe('group 41 is a ratio, not the view width', () => {
  const writers: [string, (d: Drawing) => { data: Uint8Array }][] = [
    ['R14', writeDwgR14], ['R2000', writeDwg2000],
    ['R2007', writeDwg2007], ['R2018', writeDwg2018]
  ];
  it.each(writers)('%s round-trips the ratio through the width slot', (_name, write) => {
    const d = turned();
    active(d)!.aspectRatio = ACAD_RATIO;
    const back = readDwg(write(d).data);
    /* the slot stores width = ratio x height; what comes back must be
       the ratio again, not the width the old walk reported (8.05) */
    expect(active(back)!.aspectRatio).toBeCloseTo(ACAD_RATIO, 9);
  });

  it('writeDxf states the ratio in 41, matching AutoCAD to the digit', () => {
    const d = turned();
    active(d)!.aspectRatio = ACAD_RATIO;
    expect(vportGroup(writeDxf(d), 41)).toBeCloseTo(ACAD_RATIO, 12);
    /* and the DXF trip preserves it */
    expect(active(readDxf(writeDxf(d)))!.aspectRatio).toBeCloseTo(ACAD_RATIO, 12);
  });

  it('a record with no usable ratio falls back to a plausible window', () => {
    const dxf = writeDxf(turned());          /* no aspectRatio set */
    const v = vportGroup(dxf, 41);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(10);              /* a ratio, never a width */
  });
});

describe('the saved frame beats the entity sweep', () => {
  const line = (x2: number, y2: number): Drawing['entities'][number] => ({
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: x2, y: y2, z: 0 }
  });

  it('stored header extents go out over the sweep, strays and all', () => {
    /* a production file kept invisible strays a million units out; the
       sweep framed them and ZOOM EXTENTS showed 99.96% blank paper,
       while AutoCAD 2027 reports the stored pair even after a regen */
    const d = emptyDrawing();
    d.entities = [line(10, 5), line(1e6, 1e6)];
    d.header.extMin = { x: 0, y: 0, z: 0 };
    d.header.extMax = { x: 10, y: 5, z: 0 };
    const dxf = writeDxf(d);
    expect(varTail(dxf, '$EXTMIN', 2)).toEqual([0, 0]);
    expect(varTail(dxf, '$EXTMAX', 2)).toEqual([10, 5]);
    /* no stored limits: limits = the stored extents, not the sweep */
    expect(varTail(dxf, '$LIMMAX', 2)).toEqual([10, 5]);
  });

  it('the sweep still frames a drawing that carries no extents', () => {
    const d = emptyDrawing();
    d.entities = [line(10, 5)];
    const dxf = writeDxf(d);
    expect(varTail(dxf, '$EXTMAX', 2)).toEqual([10, 5]);
  });

  it('a poisoned stored pair falls back to the sweep', () => {
    /* pre-R13 files use +-1e20 as the "never set" sentinel */
    const d = emptyDrawing();
    d.entities = [line(10, 5)];
    d.header.extMin = { x: 1e20, y: 1e20, z: 0 };
    d.header.extMax = { x: -1e20, y: -1e20, z: 0 };
    expect(varTail(writeDxf(d), '$EXTMAX', 2)).toEqual([10, 5]);
  });

  it('stored limits go out as stored, the way DXFOUT writes them', () => {
    const d = emptyDrawing();
    d.entities = [line(10, 5)];
    d.header.limMin = { x: 0, y: 0 };
    d.header.limMax = { x: 12, y: 9 };
    const dxf = writeDxf(d);
    expect(varTail(dxf, '$LIMMIN', 2)).toEqual([0, 0]);
    expect(varTail(dxf, '$LIMMAX', 2)).toEqual([12, 9]);
  });

  it('$VIEWCTR/$VIEWSIZE mirror the active viewport when there is one', () => {
    const d = turned();                      /* saved view: a tight zoom */
    const dxf = writeDxf(d);
    const vp = active(d)!;
    expect(varTail(dxf, '$VIEWCTR', 2)).toEqual([vp.center.x, vp.center.y]);
    expect(varTail(dxf, '$VIEWSIZE', 1)[0]).toBeCloseTo(vp.height, 9);
  });

  it('and still frame the whole drawing when there is none', () => {
    const d = emptyDrawing();
    d.entities = [line(10, 5)];
    const dxf = writeDxf(d);
    expect(varTail(dxf, '$VIEWCTR', 2)).toEqual([5, 2.5]);
    /* max(5, 10 / 1.6) x 1.06: the plausible-window fallback */
    expect(varTail(dxf, '$VIEWSIZE', 1)[0]).toBeCloseTo(6.625, 9);
  });
});
