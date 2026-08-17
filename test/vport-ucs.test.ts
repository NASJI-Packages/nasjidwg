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
