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
  SAB_INT, SAB_NUM, SAB_PTR, SAB_IDENT, SAB_ENUM, SAB_OPEN, SAB_CLOSE
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

/** Mark every edge the body at `bi` owns, following lumps to shells to
 *  faces to loops around their coedge rings. */
const walkBody = (g: Graph, bi: number, own: Int32Array, mark: number): void => {
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

/** Extract the drawable wireframe of a parsed ACIS stream. */
export const wiresOfRecords = (r: AcisRecords): Point3[][] => {
  const base = r.names.map(acisBase);
  const g: Graph = { r, base };
  const n = r.names.length;
  const own = new Int32Array(n);          /* edge -> owning body, 1-based */
  const bodies: number[] = [];
  for (let i = 0; i < n; i++) if (base[i] === 'body') bodies.push(i);
  bodies.forEach((bi, k) => walkBody(g, bi, own, k + 1));

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
  return out;
};

/** Extract the wireframe of an ACIS payload, in either dialect. */
export const acisWiresFromPayload = (
  payload: Uint8Array | string, dialect?: 'sab' | 'sat'
): Point3[][] => {
  const r = dialect === 'sat'
    ? parseSat(payload as string)
    : parseSab(payload) ?? (typeof payload === 'string' ? parseSat(payload) : null);
  return r ? wiresOfRecords(r) : [];
};

const CACHE = new WeakMap<object, Point3[][]>();

/** The wireframe curves of any entity carrying a solid-modeller payload,
 *  in model coordinates: a 3DSOLID, a REGION, a BODY, a surface — and a
 *  record still sealed as `unknown`, whose kernel stream sits inside the
 *  retained bits at whatever bit offset the record's own fields left it.
 *
 *  Anything else answers with an empty list. The work happens on the
 *  first call and is remembered against the entity, because a drawing
 *  opens long before anything asks to see its solids. */
export const acisWires = (e: Entity): Point3[][] => {
  const hit = CACHE.get(e);
  if (hit) return hit;
  let wires: Point3[][] = [];
  if (e.type === 'acis') {
    wires = e.sab ? acisWiresFromPayload(e.sab)
      : e.sat ? acisWiresFromPayload(e.sat, 'sat') : [];
  } else if (e.type === 'unknown' && e.data) {
    wires = acisWiresFromPayload(e.data);
  }
  CACHE.set(e, wires);
  return wires;
};
