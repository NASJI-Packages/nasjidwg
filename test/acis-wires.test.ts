/* nasjidwg — the ACIS wireframe extractor.
 *
 * The fixture is a modeller stream written token by token in the tagged
 * grammar src/acis/sab.ts documents, laid out field for field the way a
 * real AutoCAD save does: a square face of four straight edges, a full
 * circle, and two B-spline edges — one read forward, one whose edge
 * parameters run against the spline that approximates it. Every number
 * asserted below was chosen here, so a regression in the reader shows up
 * as a wrong coordinate rather than as a smaller picture.
 *
 * The placement is deliberately NOT the identity: the transform is a
 * quarter turn about Z with an offset, which pins the one convention a
 * viewer cannot guess — that ACIS writes the rotation as the images of
 * the basis vectors, a row at a time.
 */

import { describe, it, expect } from 'vitest';
import { parseSab, parseSat, sabToSat, acisBase } from '../src/acis/sab.js';
import { acisWires, acisWiresFromPayload, wiresOfRecords } from '../src/acis/wires.js';
import type { Entity, Point3 } from '../src/core/model.js';

/* ---- a tagged SAB writer, only as much as the fixture needs ---- */
const stream = () => {
  const out: number[] = [];
  const raw = (s: string): void => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  };
  const raw32 = (v: number): void => {
    out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const f64s = (...vs: number[]): void => {
    for (const v of vs) {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v, true);
      for (const byte of b) out.push(byte);
    }
  };
  return {
    out, raw, raw32,
    str: (s: string) => { out.push(0x07, s.length); raw(s); },
    ident: (s: string) => { out.push(0x0d, s.length); raw(s); },
    sub: (s: string) => { out.push(0x0e, s.length); raw(s); },
    i32: (v: number) => { out.push(0x04); raw32(v); },
    f64: (v: number) => { out.push(0x06); f64s(v); },
    pos: (x: number, y: number, z: number) => { out.push(0x13); f64s(x, y, z); },
    vec: (x: number, y: number, z: number) => { out.push(0x14); f64s(x, y, z); },
    ptr: (v: number) => { out.push(0x0c); raw32(v); },
    yes: () => out.push(0x0a),
    no: () => out.push(0x0b),
    enu: (v: number) => { out.push(0x15); raw32(v); },
    open: () => out.push(0x0f),
    close: () => out.push(0x10),
    end: () => out.push(0x11),
    base64: () => Buffer.from(Uint8Array.from(out)).toString('base64')
  };
};

/** Record ordinals in the fixture. */
const R = {
  header: 0, body: 1, lump: 2, transform: 3, shell: 4, face: 5, loop: 6,
  surface: 7,
  coedge: 8,                              /* 8..11 */
  edge: 12,                               /* 12..15 straight, 16 circle,
                                             17 spline, 18 reversed spline */
  circleEdge: 16, splineEdge: 17, backSplineEdge: 18,
  vertex: 19,                             /* 19..22 square corners */
  circleVertex: 23, splineV0: 24, splineV1: 25,
  point: 26,                              /* 26..29 square corners */
  circlePoint: 30, splineP0: 31, splineP1: 32,
  line: 33,                               /* 33..36 straight curves */
  ellipse: 37, spline: 38, backSpline: 39
};

const SQUARE: ReadonlyArray<readonly [number, number]> =
  [[0, 0], [10, 0], [10, 10], [0, 10]];

/** The fixture stream, in the pre-ASM dialect so its SAT text form can be
 *  taken too (a modern ASM stream has no faithful text spelling). */
const fixture = (): string => {
  const s = stream();
  s.raw('ACIS BinaryFile');
  s.raw32(21200); s.raw32(0); s.raw32(40); s.raw32(4);
  s.str('Autodesk AutoCAD');
  s.str('ASM 225.1.0.65535 NT');
  s.str('Mon Aug 17 09:00:00 2026');
  s.f64(1); s.f64(1e-6); s.f64(1e-10);

  s.ident('asmheader'); s.ptr(-1); s.i32(-1); s.str('225.1.0.65535'); s.end();
  s.ident('body'); s.ptr(-1); s.i32(-1);
  s.ptr(-1); s.ptr(R.lump); s.ptr(-1); s.ptr(R.transform); s.end();
  s.ident('lump'); s.ptr(-1); s.i32(-1);
  s.ptr(-1); s.ptr(-1); s.ptr(R.shell); s.ptr(R.body); s.end();
  /* a quarter turn about Z, then an offset: X goes to +Y, Y goes to -X */
  s.ident('transform'); s.ptr(-1); s.i32(-1);
  s.vec(0, 1, 0); s.vec(-1, 0, 0); s.vec(0, 0, 1); s.pos(100, 200, 300);
  s.f64(1); s.yes(); s.no(); s.no(); s.end();
  s.ident('shell'); s.ptr(-1); s.i32(-1);
  s.ptr(-1); s.ptr(-1); s.ptr(-1); s.ptr(R.face); s.ptr(-1); s.ptr(R.lump);
  s.end();
  s.ident('face'); s.ptr(-1); s.i32(-1);
  s.ptr(-1); s.ptr(-1); s.ptr(R.loop); s.ptr(R.shell); s.ptr(-1);
  s.ptr(R.surface); s.no(); s.no(); s.end();
  s.ident('loop'); s.ptr(-1); s.i32(-1);
  s.ptr(-1); s.ptr(-1); s.ptr(R.coedge); s.ptr(R.face); s.end();
  s.sub('plane'); s.ident('surface');
  /* the subclass tag above precedes the name, so the record reads
     'plane-surface' — written the long way to prove the join */
  s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.pos(0, 0, 0); s.vec(0, 0, 1); s.vec(1, 0, 0);
  s.no(); s.no(); s.no(); s.no(); s.no(); s.end();

  /* four coedges around the loop, each naming its edge */
  for (let i = 0; i < 4; i++) {
    s.ident('coedge'); s.ptr(-1); s.i32(-1); s.ptr(-1);
    s.ptr(R.coedge + ((i + 1) % 4));
    s.ptr(R.coedge + ((i + 3) % 4));
    s.ptr(R.coedge + i);
    s.ptr(R.edge + i);
    s.no(); s.ptr(R.loop); s.ptr(-1); s.end();
  }
  /* four straight edges, then the circle, then the two spline edges */
  for (let i = 0; i < 4; i++) {
    s.ident('edge'); s.ptr(-1); s.i32(-1); s.ptr(-1);
    s.ptr(R.vertex + i); s.f64(0);
    s.ptr(R.vertex + ((i + 1) % 4)); s.f64(10);
    s.ptr(R.coedge + i); s.ptr(R.line + i); s.no(); s.str('unknown'); s.end();
  }
  s.ident('edge'); s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.ptr(R.circleVertex); s.f64(0);
  s.ptr(R.circleVertex); s.f64(Math.PI * 2);
  s.ptr(R.coedge); s.ptr(R.ellipse); s.no(); s.str('unknown'); s.end();
  s.ident('edge'); s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.ptr(R.splineV0); s.f64(0);
  s.ptr(R.splineV1); s.f64(10);
  s.ptr(R.coedge); s.ptr(R.spline); s.no(); s.str('unknown'); s.end();
  /* the same curve read against itself: the edge's parameters are the
     spline's negated, which is how a reversed intcurve travels */
  s.ident('edge'); s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.ptr(R.splineV1); s.f64(-10);
  s.ptr(R.splineV0); s.f64(0);
  s.ptr(R.coedge); s.ptr(R.backSpline); s.no(); s.str('unknown'); s.end();

  for (let i = 0; i < 4; i++) {
    s.ident('vertex'); s.ptr(-1); s.i32(-1); s.ptr(-1);
    s.ptr(R.edge + i); s.i32(0); s.ptr(R.point + i); s.end();
  }
  s.ident('vertex'); s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.ptr(R.circleEdge); s.i32(0); s.ptr(R.circlePoint); s.end();
  s.ident('vertex'); s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.ptr(R.splineEdge); s.i32(0); s.ptr(R.splineP0); s.end();
  s.ident('vertex'); s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.ptr(R.splineEdge); s.i32(0); s.ptr(R.splineP1); s.end();

  for (const [x, y] of SQUARE) {
    s.ident('point'); s.ptr(-1); s.i32(-1); s.ptr(-1); s.pos(x, y, 0); s.end();
  }
  s.ident('point'); s.ptr(-1); s.i32(-1); s.ptr(-1); s.pos(4, 0, 5); s.end();
  s.ident('point'); s.ptr(-1); s.i32(-1); s.ptr(-1); s.pos(0, 0, 0); s.end();
  s.ident('point'); s.ptr(-1); s.i32(-1); s.ptr(-1); s.pos(4, 0, 0); s.end();

  /* the four sides, as root point plus a direction the parameters are
     measured against — ACIS does NOT store it unit-length */
  const DIR: ReadonlyArray<readonly [number, number]> =
    [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let i = 0; i < 4; i++) {
    s.sub('straight'); s.ident('curve');
    s.ptr(-1); s.i32(-1); s.ptr(-1);
    s.pos(SQUARE[i][0], SQUARE[i][1], 0);
    s.vec(DIR[i][0], DIR[i][1], 0);
    s.yes(); s.f64(0); s.yes(); s.f64(10); s.end();
  }
  s.sub('ellipse'); s.ident('curve');
  s.ptr(-1); s.i32(-1); s.ptr(-1);
  s.pos(0, 0, 5); s.vec(0, 0, 1); s.vec(4, 0, 0); s.f64(1);
  s.no(); s.no(); s.end();
  /* a cubic bs3_curve: two distinct knots of multiplicity 3, which the
     reader must bump to 4 at each end to reach four control points */
  const bs3 = (): void => {
    s.open();
    s.ident('exact_int_cur'); s.enu(0);
    s.ident('nubs'); s.i32(3); s.enu(0); s.i32(2);
    s.f64(0); s.i32(3); s.f64(10); s.i32(3);
    s.pos(0, 0, 0); s.pos(1, 6, 0); s.pos(3, 6, 0); s.pos(4, 0, 0);
    s.i32(0); s.ident('null_surface'); s.ident('null_surface');
    s.ident('nullbs'); s.ident('nullbs');
    s.close();
  };
  s.sub('intcurve'); s.ident('curve');
  s.ptr(-1); s.i32(-1); s.ptr(-1); s.no(); bs3(); s.no(); s.no(); s.end();
  s.sub('intcurve'); s.ident('curve');
  s.ptr(-1); s.i32(-1); s.ptr(-1); s.yes(); bs3(); s.no(); s.no(); s.end();

  s.ident('End-of-ACIS-data');
  return s.base64();
};

const solid = (sab: string): Entity =>
  ({ type: 'acis', kind: 'solid3d', layer: '0', color: { kind: 'byLayer' }, sab });

/** The fixture's own placement, applied by hand. */
const placed = (x: number, y: number, z: number): Point3 =>
  ({ x: 100 - y, y: 200 + x, z: 300 + z });

const near = (a: Point3, b: Point3, tol = 1e-9): boolean =>
  Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.z - b.z) < tol;

describe('ACIS wireframe extraction', () => {
  const sab = fixture();

  it('parses the record graph with pointers that resolve by ordinal', () => {
    const r = parseSab(sab);
    expect(r).not.toBeNull();
    expect(r!.version).toBe(21200);
    expect(r!.names[R.header]).toBe('asmheader');
    expect(r!.names[R.body]).toBe('body');
    expect(r!.names[R.surface]).toBe('plane-surface');
    expect(acisBase(r!.names[R.line])).toBe('curve');
    expect(acisBase(r!.names[R.backSplineEdge])).toBe('edge');
    /* the header strings are NOT fields of the first record: if they
       were, every pointer in the stream would address one record early */
    expect(r!.names.filter((n) => n === 'point')).toHaveLength(7);
  });

  it('draws every edge once, in the body placement', () => {
    const wires = acisWiresFromPayload(sab);
    expect(wires).toHaveLength(7);          /* 4 sides + circle + 2 splines */

    const sides = wires.filter((w) => w.length === 2);
    expect(sides).toHaveLength(4);
    /* the square's corners, carried through the quarter turn */
    for (let i = 0; i < 4; i++) {
      const a = placed(SQUARE[i][0], SQUARE[i][1], 0);
      const b = placed(SQUARE[(i + 1) % 4][0], SQUARE[(i + 1) % 4][1], 0);
      expect(sides.some((w) => near(w[0], a) && near(w[1], b))).toBe(true);
    }
  });

  it('closes a full circle on its own radius and centre', () => {
    const wires = acisWiresFromPayload(sab);
    const ring = wires.find((w) => w.length > 8
      && Math.abs(w[0].z - 305) < 1e-9);
    expect(ring).toBeDefined();
    const centre = placed(0, 0, 5);
    for (const p of ring!) {
      expect(Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - 4)).toBeLessThan(1e-9);
      expect(Math.abs(p.z - centre.z)).toBeLessThan(1e-9);
    }
    expect(near(ring![0], ring![ring!.length - 1])).toBe(true);
  });

  it('evaluates a B-spline edge, forwards and reversed alike', () => {
    const wires = acisWiresFromPayload(sab);
    const a = placed(0, 0, 0), b = placed(4, 0, 0);
    const curved = wires.filter((w) => w.length > 2
      && Math.abs(w[0].z - 300) < 1e-9);
    expect(curved).toHaveLength(2);
    for (const w of curved) {
      /* the ends are the kernel's own vertices, whichever way it is read */
      expect(near(w[0], a) || near(w[0], b)).toBe(true);
      expect(near(w[w.length - 1], a) || near(w[w.length - 1], b)).toBe(true);
      expect(near(w[0], w[w.length - 1])).toBe(false);
      /* and it bows: the middle is well off the chord between them */
      const mid = w[w.length >> 1];
      expect(Math.abs(mid.x - 100)).toBeGreaterThan(1);
    }
    /* both readings trace the same curve */
    const fwd = curved[0], back = curved[1].slice().reverse();
    expect(fwd).toHaveLength(back.length);
    for (let i = 0; i < fwd.length; i++) {
      const other = near(fwd[0], back[0]) ? back[i] : curved[1][i];
      expect(near(fwd[i], other, 1e-9)).toBe(true);
    }
  });

  it('reads the SAT text dialect to the same geometry', () => {
    const sat = sabToSat(sab);
    expect(sat).not.toBeNull();
    const text = parseSat(sat!);
    expect(text).not.toBeNull();
    const fromText = wiresOfRecords(text!);
    const fromBinary = acisWiresFromPayload(sab);
    expect(fromText).toHaveLength(fromBinary.length);
    for (let i = 0; i < fromText.length; i++) {
      expect(fromText[i]).toHaveLength(fromBinary[i].length);
      for (let k = 0; k < fromText[i].length; k++) {
        expect(near(fromText[i][k], fromBinary[i][k], 1e-6)).toBe(true);
      }
    }
  });

  it('finds a stream that does not start on a byte boundary', () => {
    /* what a record still sealed inside a DWG looks like: the kernel
       stream shifted by the bits the record's own fields ended on */
    const bytes = Buffer.from(sab, 'base64');
    const shifted = new Uint8Array(bytes.length + 1);
    shifted[0] = 0xa5;
    for (let i = 0; i < bytes.length; i++) {
      shifted[i] = (shifted[i] ?? 0) | (bytes[i] >> 4);
      shifted[i + 1] = (bytes[i] << 4) & 0xff;
    }
    shifted[0] = (0xa0) | (bytes[0] >> 4);
    expect(acisWiresFromPayload(shifted)).toHaveLength(7);
  });

  it('memoizes per entity and answers nothing for what carries no stream', () => {
    const e = solid(sab);
    const first = acisWires(e);
    expect(acisWires(e)).toBe(first);
    expect(first).toHaveLength(7);
    expect(acisWires({
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
    })).toHaveLength(0);
    expect(parseSab('not a modeller stream at all, not even close')).toBeNull();
    expect(acisWiresFromPayload(new Uint8Array(64))).toHaveLength(0);
  });
});
