/* nasjidwg — ACIS/ASM wireframe extraction.
 *
 * A solid modeller stores surfaces, not lines. What a CAD program draws
 * for a 3DSOLID in wireframe is its EDGES: the curves where two faces
 * meet. This module walks the kernel's topology — body, lump, shell,
 * face, loop, coedge, edge — collects every edge once, evaluates the
 * curve behind it over the edge's own parameter range, and hands back
 * plain polylines in model coordinates.
 *
 * It is the same set of curves AutoCAD's XEDGES command extracts.
 */

import type { Entity, Point3 } from '../core/model.js';
import {
  parseSab, parseSat, acisBase,
  SAB_INT, SAB_NUM, SAB_PTR, SAB_IDENT, SAB_ENUM, SAB_OPEN, SAB_CLOSE,
  SAB_BOOL
} from './sab.js';
import type { AcisRecords } from './sab.js';

/** A stream with its record base classes resolved once. */
interface Graph {
  r: AcisRecords;
  base: string[];
}

const isNum = (k: number): boolean => k === SAB_INT || k === SAB_NUM;

/** The first pointer field of record `i` that lands on a `base` record.
 *  Reading the graph by what a pointer POINTS AT, rather than by slot
 *  number, is what makes this survive the field-layout drift between
 *  kernel versions: the pattern pointer newer streams insert, the extra
 *  tolerances a tolerant edge carries, the field an older save omits. */
const ptrTo = (g: Graph, i: number, base: string): number => {
  const { r } = g;
  for (let j = r.start[i]; j < r.start[i + 1]; j++) {
    if (r.kind[j] !== SAB_PTR) continue;
    const t = r.num[j];
    if (t >= 0 && t < g.base.length && g.base[t] === base) return t;
  }
  return -1;
};

/** Where a record's geometry begins: past the attribute pointer, the id,
 *  and the pattern pointer newer kernels insert between them. */
const geoAt = (g: Graph, i: number): number => {
  const { r } = g;
  let j = r.start[i] + 2;
  while (j < r.start[i + 1] && r.kind[j] === SAB_PTR) j++;
  return j;
};

/* ------------------------------------------------------------------ *
 * curve evaluation
 * ------------------------------------------------------------------ */

const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Point3, b: Point3): Point3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const len3 = (a: Point3): number => Math.sqrt(dot(a, a));
const far3 = (a: Point3, b: Point3): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

/** Segment count for a sweep of `arc` radians on a curve of radius `rad`,
 *  held to a chord deviation of `tol` — and to 45 degrees a segment
 *  whatever the tolerance says, so a small feature still reads as round
 *  instead of collapsing onto its own chord. */
const arcSegments = (arc: number, rad: number, tol: number): number => {
  const step = rad > 0
    ? Math.min(Math.PI / 4, 2 * Math.acos(Math.max(-1, 1 - tol / rad)))
    : Math.PI / 4;
  return Math.max(1, Math.min(64, Math.ceil(Math.abs(arc) / step)));
};

/** Read the B-spline a bs3_curve definition holds, wherever it sits
 *  inside an int_cur's brace block.
 *
 *  ACIS stores the knot vector with the end multiplicities ONE SHORT of
 *  the clamped count — a cubic's end knots are written with multiplicity
 *  3, not 4 — so both ends are bumped on the way in. Get that wrong and
 *  the control point count comes out short and the curve collapses. */
const readSpline = (g: Graph, i: number): {
  degree: number; knots: Float64Array; ctrl: Float64Array; closed: boolean;
} | null => {
  const { r } = g;
  const end = r.start[i + 1];
  let j = -1;
  let rational = false;
  for (let k = r.start[i], depth = 0; k < end; k++) {
    if (r.kind[k] === SAB_OPEN) { depth++; continue; }
    if (r.kind[k] === SAB_CLOSE) { depth--; continue; }
    /* only the definition's own spline, never one nested inside a
       surface or a parameter-space curve it references */
    if (depth !== 1 || r.kind[k] !== SAB_IDENT) continue;
    const w = r.text[r.num[k]];
    if (w === 'nubs' || w === 'nurbs') { j = k + 1; rational = w === 'nurbs'; break; }
  }
  if (j < 0 || j >= end) return null;
  const degree = r.num[j++];
  if (!(degree >= 1) || degree > 32) return null;
  /* closure: an enum in the binary dialect, a word in the text one */
  let closed = false;
  if (j < end && r.kind[j] === SAB_ENUM) closed = r.num[j++] !== 0;
  else if (j < end && r.kind[j] === SAB_IDENT) {
    closed = r.text[r.num[j++]] !== 'open';
  }
  const spans = r.num[j++];
  if (!(spans >= 2) || j + spans * 2 > end) return null;
  const value = new Float64Array(spans);
  const mult = new Int32Array(spans);
  let total = 2;                          /* the two implied end repeats */
  for (let k = 0; k < spans; k++) {
    value[k] = r.num[j++];
    mult[k] = Math.max(1, r.num[j++]);
    total += mult[k];
  }
  const n = total - degree - 1;           /* control point count */
  const stride = rational ? 4 : 3;
  if (n < degree + 1 || j + n * stride > end) return null;
  const knots = new Float64Array(total);
  for (let k = 0, at = 0; k < spans; k++) {
    const m = mult[k] + (k === 0 || k === spans - 1 ? 1 : 0);
    for (let q = 0; q < m; q++) knots[at++] = value[k];
  }
  const ctrl = new Float64Array(n * 4);
  for (let k = 0; k < n; k++) {
    ctrl[k * 4] = r.num[j++];
    ctrl[k * 4 + 1] = r.num[j++];
    ctrl[k * 4 + 2] = r.num[j++];
    ctrl[k * 4 + 3] = rational ? r.num[j++] : 1;
  }
  return { degree, knots, ctrl, closed };
};

/** de Boor evaluation, in homogeneous coordinates so a rational curve
 *  costs the same as a plain one. */
const splineAt = (
  s: { degree: number; knots: Float64Array; ctrl: Float64Array }, t: number
): Point3 => {
  const { degree: p, knots, ctrl } = s;
  const n = ctrl.length / 4;
  let span = p;
  while (span < n - 1 && knots[span + 1] <= t) span++;
  const d = new Float64Array((p + 1) * 4);
  for (let i = 0; i <= p; i++) {
    const c = (span - p + i) * 4;
    d[i * 4] = ctrl[c] * ctrl[c + 3];
    d[i * 4 + 1] = ctrl[c + 1] * ctrl[c + 3];
    d[i * 4 + 2] = ctrl[c + 2] * ctrl[c + 3];
    d[i * 4 + 3] = ctrl[c + 3];
  }
  for (let r = 1; r <= p; r++) {
    for (let i = p; i >= r; i--) {
      const lo = knots[i + span - p], hi = knots[i + 1 + span - r];
      const a = hi > lo ? (t - lo) / (hi - lo) : 0;
      for (let c = 0; c < 4; c++) {
        d[i * 4 + c] = (1 - a) * d[(i - 1) * 4 + c] + a * d[i * 4 + c];
      }
    }
  }
  const w = d[p * 4 + 3] || 1;
  return { x: d[p * 4] / w, y: d[p * 4 + 1] / w, z: d[p * 4 + 2] / w };
};

/** Sample the curve record `ci` over [t0, t1]. Returns null for a curve
 *  form this extractor does not evaluate. */
const curvePoints = (
  g: Graph, ci: number, t0: number, t1: number, tol: number
): Point3[] | null => {
  const { r } = g;
  const name = r.names[ci];
  let j = geoAt(g, ci);
  const d = (): number => r.num[j++];
  if (name === 'straight-curve') {
    /* P(t) = root + t * direction, with the direction exactly as stored:
       ACIS does not keep it unit, and the edge's parameters are measured
       against the length it actually has. */
    const ox = d(), oy = d(), oz = d(), dx = d(), dy = d(), dz = d();
    return [
      { x: ox + t0 * dx, y: oy + t0 * dy, z: oz + t0 * dz },
      { x: ox + t1 * dx, y: oy + t1 * dy, z: oz + t1 * dz }
    ];
  }
  if (name === 'ellipse-curve') {
    /* P(t) = centre + major*cos t + (normal x major)*ratio*sin t, t in
       radians. The major axis carries the radius in its own length. */
    const c = { x: d(), y: d(), z: d() };
    const nrm = { x: d(), y: d(), z: d() };
    const maj = { x: d(), y: d(), z: d() };
    const ratio = d();
    const rad = len3(maj);
    if (!(rad > 0)) return null;
    const min = cross(nrm, maj);
    const ml = len3(min);
    if (!(ml > 0)) return null;
    const k = (rad * ratio) / ml;
    const n = arcSegments(t1 - t0, rad * Math.max(ratio, 1), tol);
    const out: Point3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const co = Math.cos(t), si = Math.sin(t) * k;
      out.push({
        x: c.x + maj.x * co + min.x * si,
        y: c.y + maj.y * co + min.y * si,
        z: c.z + maj.z * co + min.z * si
      });
    }
    return out;
  }
  if (acisBase(name) === 'curve') {
    /* intcurve and its kin: a surface-surface intersection approximated
       by the kernel's own B-spline, which is what it draws from too */
    const s = readSpline(g, ci);
    if (!s) return null;
    /* An intcurve may run against its approximating spline, in which case
       the edge's parameters are that spline's negated; and a periodic
       spline's run past the end of its knots and wrap. Both are read off
       the numbers rather than off the reversal flag, which the two
       dialects spell differently and older saves omit. */
    const k0 = s.knots[0], k1 = s.knots[s.knots.length - 1];
    const period = k1 - k0;
    const slack = period * 1e-9;
    const holds = (u: number, v: number): boolean =>
      u >= k0 - slack && v <= k1 + slack;
    let a = t0, b = t1;
    if (!holds(a, b) && holds(-b, -a)) { const lo = -b; b = -a; a = lo; }
    const wrap = !holds(a, b) && s.closed && period > 0;
    let spans = 1;
    for (let k = s.degree; k < s.knots.length - s.degree - 1; k++) {
      if (s.knots[k + 1] <= s.knots[k]) continue;
      if (wrap || (s.knots[k + 1] > a && s.knots[k] < b)) spans++;
    }
    const n = Math.max(4, Math.min(64, spans * 4));
    const out: Point3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = a + ((b - a) * i) / n;
      out.push(splineAt(s, wrap
        ? k0 + (((t - k0) % period) + period) % period
        : Math.max(k0, Math.min(k1, t))));
    }
    return out;
  }
  return null;
};

/* ------------------------------------------------------------------ *
 * topology
 * ------------------------------------------------------------------ */

/** The point a vertex stands on. */
const vertexPoint = (g: Graph, vi: number): Point3 | null => {
  if (vi < 0) return null;
  const pi = ptrTo(g, vi, 'point');
  if (pi < 0) return null;
  const j = geoAt(g, pi);
  const { r } = g;
  if (j + 2 >= r.start[pi + 1]) return null;
  return { x: r.num[j], y: r.num[j + 1], z: r.num[j + 2] };
};

/** An edge's two vertices and their parameters. The layout is
 *  `$start t0 $end t1`, found as the first pointer that a number
 *  follows — which is true of no other slot in the record. */
const edgeEnds = (g: Graph, i: number): {
  v0: number; t0: number; v1: number; t1: number
} | null => {
  const { r } = g;
  const end = r.start[i + 1];
  for (let j = r.start[i] + 2; j + 3 < end; j++) {
    if (r.kind[j] !== SAB_PTR || !isNum(r.kind[j + 1])) continue;
    if (r.kind[j + 2] !== SAB_PTR || !isNum(r.kind[j + 3])) return null;
    return { v0: r.num[j], t0: r.num[j + 1], v1: r.num[j + 2], t1: r.num[j + 3] };
  }
  return null;
};

/** Turn one edge into a polyline, or null when there is nothing to draw. */
const edgeWire = (g: Graph, i: number, tol: number): Point3[] | null => {
  const ends = edgeEnds(g, i);
  if (!ends) return null;
  const a = vertexPoint(g, ends.v0), b = vertexPoint(g, ends.v1);
  let t0 = ends.t0, t1 = ends.t1;
  if (t1 < t0) { const s = t0; t0 = t1; t1 = s; }
  const ci = ptrTo(g, i, 'curve');
  let pts = ci >= 0 && t1 - t0 > 1e-12 ? curvePoints(g, ci, t0, t1, tol) : null;
  /* No curve this reader evaluates, or none at all: the chord between the
     vertices is still where the edge runs, and a gap would read as a hole
     in the drawing. Straight edges are exact either way. */
  if (!pts) pts = a && b ? [a, b] : null;
  if (!pts || pts.length < 2) return null;
  /* The vertices are the kernel's own answer for the ends, so snap to
     them and neighbouring edges close on a shared point. Which vertex
     lands on which end is decided by distance, not by order: a curve
     read against its own direction comes back reversed. */
  if (a && b) {
    const last = pts.length - 1;
    const near = far3(pts[0], a) <= far3(pts[0], b);
    pts[0] = near ? a : b;
    pts[last] = near ? b : a;
  }
  let span = 0;
  for (let k = 1; k < pts.length; k++) {
    span += Math.abs(pts[k].x - pts[k - 1].x) + Math.abs(pts[k].y - pts[k - 1].y)
      + Math.abs(pts[k].z - pts[k - 1].z);
  }
  return span > 1e-12 ? pts : null;       /* a zero-length edge draws nothing */
};

/** Mark every edge AND face the body at `bi` owns, following lumps to
 *  shells to faces to loops around their coedge rings. */
const walkBody = (
  g: Graph, bi: number, own: Int32Array, ownFace: Int32Array, mark: number
): void => {
  const seen = new Set<number>();
  const chain = (from: number, base: string, visit: (at: number) => void): void => {
    for (let at = from; at >= 0; at = ptrTo(g, at, base)) {
      if (seen.has(at)) break;
      seen.add(at);
      visit(at);
    }
  };
  chain(ptrTo(g, bi, 'lump'), 'lump', (lump) => {
    chain(ptrTo(g, lump, 'shell'), 'shell', (shell) => {
      chain(ptrTo(g, shell, 'face'), 'face', (face) => {
        if (ownFace[face] === 0) ownFace[face] = mark;
        chain(ptrTo(g, face, 'loop'), 'loop', (loop) => {
          chain(ptrTo(g, loop, 'coedge'), 'coedge', (co) => {
            const e = ptrTo(g, co, 'edge');
            if (e >= 0 && own[e] === 0) own[e] = mark;
          });
        });
      });
    });
  });
};

/* ------------------------------------------------------------------ *
 * isolines
 * ------------------------------------------------------------------ */

/** What AutoCAD draws for a solid in wireframe is its edges AND, across
 *  every curved face, ISOLINES tessellation lines — with DISPSILH off,
 *  which is its default and how this corpus is saved. On a plain box the
 *  lines have nowhere to go and nothing changes. On a TUBE they are the
 *  only thing there is: a handrail cylinder owns exactly two edges, the
 *  circles capping its ends, and a plan view of it shows those as two
 *  ticks and nothing between them. The rails, posts, round feet and
 *  return bends of a ramp catalogue vanish entirely without them.
 *
 *  Isolines are isoparametric curves of the surface, so — unlike the
 *  silhouette DISPSILH would draw instead — they do not depend on where
 *  the drawing is viewed from, and can be baked once at import.
 *
 *  Cone (which covers the cylinder), torus and sphere are handled here.
 *  A spline face carries isolines too and is left for when a drawing
 *  needs them. */

/** A surface in the form its isolines are drawn from: a point at (u, v),
 *  the parameters of a point, and which of the two directions the surface
 *  actually bends along — only those carry isolines, which is why a
 *  cylinder shows its rulings and not a stack of circles. */
interface Sheet {
  at(u: number, v: number): Point3;
  param(p: Point3): { u: number; v: number };
  /** [u, v]: whether a family of curves at constant u / constant v is drawn. */
  bend: [boolean, boolean];
  /** the radius of the constant-u / constant-v curve, for its chording;
   *  zero for a straight one. */
  rad(dir: 0 | 1, at: number): number;
}

const sub3 = (a: Point3, b: Point3): Point3 =>
  ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

const TAU = Math.PI * 2;

/** The `n` numbers a record's geometry opens with, or null when the run
 *  is short or broken. They start where geoAt says, so the count is also
 *  how far past it the rest of the record begins. */
const nums = (g: Graph, si: number, from: number, n: number): number[] | null => {
  const { r } = g;
  const end = r.start[si + 1];
  if (from + n > end) return null;
  const out: number[] = [];
  for (let j = from; j < from + n; j++) {
    if (!isNum(r.kind[j])) return null;
    out.push(r.num[j]);
  }
  return out;
};

/** cone-surface: root, axis, major axis, ratio, then — past the interval
 *  flags the two dialects spell differently — the half angle's sine and
 *  cosine. A cylinder is the case where the sine is zero, and its
 *  isolines are the straight rulings a plan view reads as a tube. */
const readCone = (g: Graph, si: number): Sheet | null => {
  const { r } = g;
  const end = r.start[si + 1];
  let j = geoAt(g, si);
  const head = nums(g, si, j, 10);
  if (!head) return null;
  j += 10;
  const root = { x: head[0], y: head[1], z: head[2] };
  const axis = { x: head[3], y: head[4], z: head[5] };
  const maj = { x: head[6], y: head[7], z: head[8] };
  const ratio = head[9];
  while (j < end && !isNum(r.kind[j])) j++;
  const sine = j < end ? r.num[j++] : 0;
  const al = len3(axis), r0 = len3(maj);
  if (!(al > 0) || !(r0 > 0) || !(ratio > 0)) return null;
  const cosine = j < end && isNum(r.kind[j]) ? r.num[j] : 1;
  const ax = { x: axis.x / al, y: axis.y / al, z: axis.z / al };
  const min = cross(ax, maj);
  const ml = len3(min);
  if (!(ml > 0)) return null;
  const k = (r0 * ratio) / ml;
  const e2 = { x: min.x * k, y: min.y * k, z: min.z * k };
  const slope = cosine !== 0 ? sine / cosine : 0;
  return {
    at(u, v) {
      const s = 1 + (v * slope) / r0;
      const co = Math.cos(u) * s, si2 = Math.sin(u) * s;
      return {
        x: root.x + ax.x * v + maj.x * co + e2.x * si2,
        y: root.y + ax.y * v + maj.y * co + e2.y * si2,
        z: root.z + ax.z * v + maj.z * co + e2.z * si2
      };
    },
    param(p) {
      const q = sub3(p, root);
      const v = dot(q, ax);
      const w = { x: q.x - ax.x * v, y: q.y - ax.y * v, z: q.z - ax.z * v };
      return { u: Math.atan2(dot(w, e2), dot(w, maj)), v };
    },
    bend: [true, false],
    rad: () => 0                            /* a ruling is straight */
  };
};

/** torus-surface: centre, axis, major radius, minor radius, the direction
 *  u is measured from. Both directions bend, so a return bend carries the
 *  long arcs that make it read as a tube AND the rings across it. */
const readTorus = (g: Graph, si: number): Sheet | null => {
  const head = nums(g, si, geoAt(g, si), 11);
  if (!head) return null;
  const c = { x: head[0], y: head[1], z: head[2] };
  const axis = { x: head[3], y: head[4], z: head[5] };
  const major = head[6], minor = head[7];
  const ori = { x: head[8], y: head[9], z: head[10] };
  const al = len3(axis);
  if (!(al > 0) || !(Math.abs(minor) > 0)) return null;
  const n = { x: axis.x / al, y: axis.y / al, z: axis.z / al };
  /* the direction u is measured from, squared up against the axis */
  const d0 = dot(ori, n);
  const e1r = { x: ori.x - n.x * d0, y: ori.y - n.y * d0, z: ori.z - n.z * d0 };
  const l1 = len3(e1r);
  if (!(l1 > 0)) return null;
  const e1 = { x: e1r.x / l1, y: e1r.y / l1, z: e1r.z / l1 };
  const e2 = cross(n, e1);
  return {
    at(u, v) {
      const rad = major + minor * Math.cos(v), h = minor * Math.sin(v);
      const cu = Math.cos(u) * rad, su = Math.sin(u) * rad;
      return {
        x: c.x + e1.x * cu + e2.x * su + n.x * h,
        y: c.y + e1.y * cu + e2.y * su + n.y * h,
        z: c.z + e1.z * cu + e2.z * su + n.z * h
      };
    },
    param(p) {
      const q = sub3(p, c);
      const h = dot(q, n);
      const a = dot(q, e1), b = dot(q, e2);
      return { u: Math.atan2(b, a), v: Math.atan2(h, Math.hypot(a, b) - major) };
    },
    bend: [true, true],
    rad: (dir, at) => (dir === 0
      ? Math.abs(minor) : Math.abs(major + minor * Math.cos(at)))
  };
};

/** sphere-surface: centre, radius, the pole axis, and the direction u is
 *  measured from — the meridians and parallels a round foot is drawn
 *  with. */
const readSphere = (g: Graph, si: number): Sheet | null => {
  const head = nums(g, si, geoAt(g, si), 10);
  if (!head) return null;
  const c = { x: head[0], y: head[1], z: head[2] };
  const radius = Math.abs(head[3]);
  const pole = { x: head[4], y: head[5], z: head[6] };
  const ori = { x: head[7], y: head[8], z: head[9] };
  const pl = len3(pole);
  if (!(radius > 0) || !(pl > 0)) return null;
  const n = { x: pole.x / pl, y: pole.y / pl, z: pole.z / pl };
  const d0 = dot(ori, n);
  const e1r = { x: ori.x - n.x * d0, y: ori.y - n.y * d0, z: ori.z - n.z * d0 };
  const l1 = len3(e1r);
  if (!(l1 > 0)) return null;
  const e1 = { x: e1r.x / l1, y: e1r.y / l1, z: e1r.z / l1 };
  const e2 = cross(n, e1);
  return {
    at(u, v) {
      const rad = radius * Math.cos(v), h = radius * Math.sin(v);
      const cu = Math.cos(u) * rad, su = Math.sin(u) * rad;
      return {
        x: c.x + e1.x * cu + e2.x * su + n.x * h,
        y: c.y + e1.y * cu + e2.y * su + n.y * h,
        z: c.z + e1.z * cu + e2.z * su + n.z * h
      };
    },
    param(p) {
      const q = sub3(p, c);
      const h = dot(q, n);
      const a = dot(q, e1), b = dot(q, e2);
      return { u: Math.atan2(b, a), v: Math.atan2(h, Math.hypot(a, b)) };
    },
    bend: [true, true],
    rad: (dir, at) => (dir === 0 ? radius : Math.abs(radius * Math.cos(at)))
  };
};

/** A record's first boolean, which in every record this reader asks is
 *  the sense flag: an edge's against its curve, a coedge's against its
 *  edge, a face's against its surface normal. Null when there is none. */
const senseOf = (g: Graph, i: number): number | null => {
  const { r } = g;
  for (let j = r.start[i] + 1; j < r.start[i + 1]; j++) {
    if (r.kind[j] === SAB_BOOL) return r.num[j] ? -1 : 1;
  }
  return null;
};

/** Which way a face lies from a piece of its own boundary. Walking a
 *  coedge with the face's outward normal up, the face is on the LEFT —
 *  that is the whole of the B-rep's orientation rule, and it is the only
 *  thing that can tell the two halves of a tube apart when the boundary
 *  is two rings at opposite ends and the gap either side of them is the
 *  same. Returns +1 or -1 for the way the parameter `dir` grows into the
 *  face, or 0 when the records do not say. */
const insideWay = (
  s: Sheet, sense: number, a: Point3, b: Point3, dir: 0 | 1
): number => {
  const t = {
    x: (b.x - a.x) * sense, y: (b.y - a.y) * sense, z: (b.z - a.z) * sense
  };
  if (!(len3(t) > 0)) return 0;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const q = s.param(mid);
  const h = 1e-4;
  const du = sub3(s.at(q.u + h, q.v), s.at(q.u - h, q.v));
  const dv = sub3(s.at(q.u, q.v + h), s.at(q.u, q.v - h));
  if (!(len3(du) > 0) || !(len3(dv) > 0)) return 0;
  const nrm = cross(du, dv);
  const left = cross(nrm, t);                /* the interior side */
  const into = dot(left, dir === 0 ? du : dv);
  return into > 0 ? 1 : into < 0 ? -1 : 0;
};

const readSheet = (g: Graph, si: number): Sheet | null => {
  const name = g.r.names[si];
  if (name === 'cone-surface') return readCone(g, si);
  if (name === 'torus-surface') return readTorus(g, si);
  if (name === 'sphere-surface') return readSphere(g, si);
  return null;
};

/** The parameter values one direction's isolines sit at.
 *
 *  A direction the face closes right round takes `n` of them, evenly from
 *  the surface's own parameter origin — checked pixel-for-pixel against
 *  AutoCAD, which puts a cylinder's four rulings at 0, 90, 180 and 270
 *  degrees of the stored major axis. A direction the face spans only part
 *  of takes its share of that same spacing, spread to leave equal margins
 *  at both ends: a half turn of a return bend carries two of four, four of
 *  eight. Below one whole spacing it carries none. */
const isoAt = (span: number, from: number, whole: boolean, n: number): number[] => {
  const out: number[] = [];
  if (whole) {
    for (let k = 0; k < n; k++) out.push((k * TAU) / n);
    return out;
  }
  const k = Math.floor((n * span) / TAU + 1e-9);
  for (let i = 0; i < k; i++) out.push(from + (span * (i + 1)) / (k + 1));
  return out;
};

/** The isolines of one face: for each direction the surface bends along, a
 *  set of curves clipped to the face by the crossings its own boundary
 *  makes — which is what keeps a ruling inside a mitred end, and out of a
 *  hole. */
const faceIsolines = (
  g: Graph, fi: number, si: number, tol: number, n: number
): Point3[][] => {
  const s = readSheet(g, si);
  if (!s) return [];

  /* the face's boundary, in the surface's own parameters, with each edge
     unwrapped so one that circles the axis reads as a full turn */
  const chains: { u: number; v: number }[][] = [];
  const rims: { pts: Point3[]; sense: number }[] = [];
  const whole: [boolean, boolean] = [false, false];
  const faceSense = senseOf(g, fi);
  const seenLoop = new Set<number>();
  for (let lp = ptrTo(g, fi, 'loop'); lp >= 0 && !seenLoop.has(lp);
    lp = ptrTo(g, lp, 'loop')) {
    seenLoop.add(lp);
    const seenCo = new Set<number>();
    for (let co = ptrTo(g, lp, 'coedge'); co >= 0 && !seenCo.has(co);
      co = ptrTo(g, co, 'coedge')) {
      seenCo.add(co);
      const ei = ptrTo(g, co, 'edge');
      if (ei < 0) continue;
      const pts = edgeWire(g, ei, tol);
      if (!pts || pts.length < 2) continue;
      /* which way the coedge travels along the sampled points: the edge
         runs from its start parameter to its end one, and edgeWire always
         samples the curve the increasing way */
      const ends = edgeEnds(g, ei);
      const along = ends ? (ends.t1 < ends.t0 ? -1 : 1) : 0;
      const ce = senseOf(g, co);
      rims.push({
        pts,
        sense: (ce && along && faceSense) ? ce * along * faceSense : 0
      });
      const ch = pts.map((p) => s.param(p));
      for (const dir of [0, 1] as const) {
        if (!s.bend[dir]) continue;
        const key = dir === 0 ? 'u' : 'v';
        let travel = 0;
        for (let k = 1; k < ch.length; k++) {
          let step = ch[k][key] - ch[k - 1][key];
          while (step > Math.PI) step -= TAU;
          while (step < -Math.PI) step += TAU;
          ch[k][key] = ch[k - 1][key] + step;
          travel += step;
        }
        if (Math.abs(travel) > TAU - 0.05) whole[dir] = true;
      }
      chains.push(ch);
    }
  }
  if (!chains.length) return [];

  const out: Point3[][] = [];
  for (const dir of [0, 1] as const) {
    if (!s.bend[dir]) continue;
    const held = dir === 0 ? 'u' : 'v';
    const free = dir === 0 ? 'v' : 'u';
    /* the part of the turn the boundary never reaches is its largest gap;
       what is left is the span the face occupies */
    const all: number[] = [];
    for (const ch of chains) {
      for (const q of ch) all.push(((q[held] % TAU) + TAU) % TAU);
    }
    all.sort((a, b) => a - b);
    let gap = all[0] + TAU - all[all.length - 1], at = all[all.length - 1];
    let second = -1;
    for (let k = 1; k < all.length; k++) {
      const d = all[k] - all[k - 1];
      if (d > gap) { second = gap; gap = d; at = all[k - 1]; }
      else if (d > second) second = d;
    }
    let span = TAU - gap;
    let from = at + gap;
    /* The largest gap is only the SMALLEST reading the boundary allows:
       a face may as well occupy the long way round, and a bend of more
       than a half turn does. Worse, two rings at opposite ends leave the
       same gap either side and the reading is a coin toss. The B-rep's
       own orientation settles it — the face lies to the LEFT of its
       boundary's travel — so where the records say which way that is, the
       span is measured from a boundary ring outward instead. */
    if (!whole[dir]) {
      for (const rim of rims) {
        if (!rim.sense) continue;
        /* only a ring that stands square across the direction says where
           the face ENDS; an edge running along it is somewhere in the
           middle and answers nothing */
        let lo = Infinity, hi = -Infinity;
        for (const p of rim.pts) {
          const t = s.param(p)[held];
          if (t < lo) lo = t;
          if (t > hi) hi = t;
        }
        if (hi - lo > 1e-6) continue;
        const mid = rim.pts.length >> 1;
        const way = insideWay(s, rim.sense,
          rim.pts[Math.max(0, mid - 1)], rim.pts[Math.min(rim.pts.length - 1, mid)], dir);
        if (!way) continue;
        const here = (((lo + hi) / 2 % TAU) + TAU) % TAU;
        /* the gap on the far side of that ring is the one the face is
           not: what is left of the turn is the face */
        let step = TAU;
        for (const val of all) {
          let d = way > 0 ? here - val : val - here;
          d = ((d % TAU) + TAU) % TAU;
          if (d > 1e-9 && d < step) step = d;
        }
        if (!(step > 0.05) || step >= TAU) continue;
        span = TAU - step;
        from = way > 0 ? here : here - span;
        break;
      }
    }
    if (!whole[dir] && !(span > 1e-9)) continue;

    for (const val of isoAt(span, from, whole[dir], n)) {
      /* a face that closes right round the OTHER direction — a tube seen
         across its length — has no boundary to cross: the isoline is the
         whole ring */
      if (s.bend[free === 'u' ? 0 : 1] && whole[free === 'u' ? 0 : 1]) {
        const bow = s.rad(dir, val);
        const steps = bow > 0 ? arcSegments(TAU, bow, tol) : 1;
        const ring: Point3[] = [];
        for (let i = 0; i <= steps; i++) {
          const q = (TAU * i) / steps;
          ring.push(dir === 0 ? s.at(val, q) : s.at(q, val));
        }
        out.push(ring);
        continue;
      }
      const hits: { at: number; into: number }[] = [];
      for (let ci = 0; ci < chains.length; ci++) {
        const ch = chains[ci], rim = rims[ci];
        for (let k = 1; k < ch.length; k++) {
          const a = ch[k - 1][held], b = ch[k][held];
          if (a === b) continue;
          const lo = Math.min(a, b), hi = Math.max(a, b);
          /* the isoline repeats every turn, so every image of it the
             segment spans is a crossing; [0, 1) keeps a shared vertex from
             counting twice */
          for (let m = Math.ceil((lo - val) / TAU);
            m <= Math.floor((hi - val) / TAU); m++) {
            const t = (val + m * TAU - a) / (b - a);
            if (t < 0 || t >= 1) continue;
            hits.push({
              at: ch[k - 1][free] + t * (ch[k][free] - ch[k - 1][free]),
              /* which side of this crossing the face is on, so a run can
                 be laid between where it starts and where it ends rather
                 than between the first pair the sort happens to give */
              into: rim.sense
                ? insideWay(s, rim.sense, rim.pts[k - 1], rim.pts[k],
                  free === 'u' ? 0 : 1)
                : 0
            });
          }
        }
      }
      hits.sort((x, y) => x.at - y.at);
      /* a face closed in the free direction has its runs wrap: the last
         opening pairs with the first closing a turn later */
      const round2 = s.bend[free === 'u' ? 0 : 1];
      let start = 0;
      if (round2 && hits.length > 1 && hits.every((h) => h.into !== 0)) {
        const first = hits.findIndex((h) => h.into > 0);
        if (first > 0) start = first;
      }
      const runs: number[][] = [];
      for (let k = 0; k + 1 < hits.length; k += 2) {
        const a = hits[(k + start) % hits.length];
        const b = hits[(k + 1 + start) % hits.length];
        runs.push([a.at, b.at < a.at ? b.at + TAU : b.at]);
      }
      for (const [q0, q1] of runs) {
        if (q1 - q0 < 1e-9) continue;
        const bow = s.rad(dir, val);
        const steps = bow > 0 ? arcSegments(q1 - q0, bow, tol) : 1;
        const run: Point3[] = [];
        for (let i = 0; i <= steps; i++) {
          const q = q0 + ((q1 - q0) * i) / steps;
          run.push(dir === 0 ? s.at(val, q) : s.at(q, val));
        }
        out.push(run);
      }
    }
  }
  return out;
};

/** The body's placement: nine rotation terms, a translation, a scale.
 *  ACIS writes the rotation as the images of the basis vectors, one per
 *  row, so a point is carried by its components against those rows. */
const bodyTransform = (g: Graph, bi: number): Float64Array | null => {
  const ti = ptrTo(g, bi, 'transform');
  if (ti < 0) return null;
  const { r } = g;
  const j = geoAt(g, ti);
  if (j + 12 >= r.start[ti + 1]) return null;
  const m = new Float64Array(13);
  for (let k = 0; k < 12; k++) m[k] = r.num[j + k];
  m[12] = isNum(r.kind[j + 12]) ? r.num[j + 12] || 1 : 1;
  return m;
};

const place = (m: Float64Array | null, p: Point3): Point3 => {
  if (!m) return p;
  const s = m[12];
  return {
    x: (p.x * m[0] + p.y * m[3] + p.z * m[6]) * s + m[9],
    y: (p.x * m[1] + p.y * m[4] + p.z * m[7]) * s + m[10],
    z: (p.x * m[2] + p.y * m[5] + p.z * m[8]) * s + m[11]
  };
};

/* ------------------------------------------------------------------ *
 * public entry points
 * ------------------------------------------------------------------ */

/** Extract the drawable wireframe of a parsed ACIS stream. `isolines` is
 *  the drawing's ISOLINES: how many tessellation lines AutoCAD lays across
 *  each curved face. Four is its default; zero draws edges alone. */
export const wiresOfRecords = (r: AcisRecords, isolines = 4): Point3[][] => {
  const base = r.names.map(acisBase);
  const g: Graph = { r, base };
  const n = r.names.length;
  const own = new Int32Array(n);          /* edge -> owning body, 1-based */
  const ownFace = new Int32Array(n);      /* face -> the same */
  const bodies: number[] = [];
  for (let i = 0; i < n; i++) if (base[i] === 'body') bodies.push(i);
  bodies.forEach((bi, k) => walkBody(g, bi, own, ownFace, k + 1));

  const forms = bodies.map((bi) => bodyTransform(g, bi));
  /* An edge no body claimed still belongs to the stream — a wire body, a
     subshell this walk does not follow. It is drawn under the first
     body's placement, which is the only one a single-body stream has. */
  const fallback = forms.length ? forms[0] : null;

  /* Chord tolerance is keyed to the stream's own size: a handrail fillet
     and a ramp deck get the same visual smoothness, not the same segment
     count. */
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (base[i] !== 'point') continue;
    const j = geoAt(g, i);
    for (let k = 0; k < 3; k++) {
      const v = r.num[j + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const diag = Math.hypot(...hi.map((v, k) => (v > lo[k] ? v - lo[k] : 0)));
  const tol = Math.max(diag * 5e-4, 1e-9);

  const out: Point3[][] = [];
  for (let i = 0; i < n; i++) {
    if (base[i] !== 'edge') continue;
    const pts = edgeWire(g, i, tol);
    if (!pts) continue;
    const m = own[i] > 0 ? forms[own[i] - 1] : fallback;
    if (m) for (let k = 0; k < pts.length; k++) pts[k] = place(m, pts[k]);
    out.push(pts);
  }
  if (isolines > 0) {
    for (let i = 0; i < n; i++) {
      if (base[i] !== 'face') continue;
      const si = ptrTo(g, i, 'surface');
      if (si < 0) continue;
      const m = ownFace[i] > 0 ? forms[ownFace[i] - 1] : fallback;
      for (const pts of faceIsolines(g, i, si, tol, isolines)) {
        if (m) for (let k = 0; k < pts.length; k++) pts[k] = place(m, pts[k]);
        out.push(pts);
      }
    }
  }
  return out;
};

/** Extract the wireframe of an ACIS payload, in either dialect. */
export const acisWiresFromPayload = (
  payload: Uint8Array | string, dialect?: 'sab' | 'sat', isolines = 4
): Point3[][] => {
  const r = dialect === 'sat'
    ? parseSat(payload as string)
    : parseSab(payload) ?? (typeof payload === 'string' ? parseSat(payload) : null);
  return r ? wiresOfRecords(r, isolines) : [];
};

const CACHE = new WeakMap<object, { n: number; wires: Point3[][] }>();

/** The wireframe curves of any entity carrying a solid-modeller payload,
 *  in model coordinates: a 3DSOLID, a REGION, a BODY, a surface — and a
 *  record still sealed as `unknown`, whose kernel stream sits inside the
 *  retained bits at whatever bit offset the record's own fields left it.
 *
 *  Anything else answers with an empty list. The work happens on the
 *  first call and is remembered against the entity, because a drawing
 *  opens long before anything asks to see its solids. */
export const acisWires = (e: Entity, isolines = 4): Point3[][] => {
  const hit = CACHE.get(e);
  if (hit && hit.n === isolines) return hit.wires;
  let wires: Point3[][] = [];
  if (e.type === 'acis') {
    wires = e.sab ? acisWiresFromPayload(e.sab, 'sab', isolines)
      : e.sat ? acisWiresFromPayload(e.sat, 'sat', isolines) : [];
  } else if (e.type === 'unknown' && e.data) {
    wires = acisWiresFromPayload(e.data, 'sab', isolines);
  }
  CACHE.set(e, { n: isolines, wires });
  return wires;
};
