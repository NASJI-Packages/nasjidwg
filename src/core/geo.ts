/* nasjidwg — geometry utilities: bounding boxes, transforms, explode,
 * deep clone. All pure functions over the document model. */

import type {
  Drawing, Entity, HatchBoundary, Point2, Point3, PolylineVertex
} from './model.js';

export interface Bounds { min: Point2; max: Point2 }

const TAU = Math.PI * 2;

/** 2D affine transform: [a c e; b d f] applied as x' = ax+cy+e, y' = bx+dy+f. */
export interface Transform2 {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export const identity = (): Transform2 =>
  ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const compose = (m: Transform2, n: Transform2): Transform2 => ({
  a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f
});

export const translation = (tx: number, ty: number): Transform2 =>
  ({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });

export const rotationT = (rad: number): Transform2 => ({
  a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad),
  e: 0, f: 0
});

export const scaling = (sx: number, sy: number): Transform2 =>
  ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });

/** The placement transform of an INSERT (translate ∘ rotate ∘ scale). */
export const insertTransform = (
  position: Point3, scale: Point3, rotation: number
): Transform2 =>
  compose(translation(position.x, position.y),
    compose(rotationT(rotation), scaling(scale.x || 1, scale.y || 1)));

export const applyPt = (m: Transform2, p: Point2): Point2 =>
  ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

const apply3 = (m: Transform2, p: Point3): Point3 =>
  ({ ...applyPt(m, p), z: p.z ?? 0 });

/** Deep-copy any model value (plain JSON data by design). */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* ------------------------------------------------------------------ *
 * object coordinates (OCS)
 * ------------------------------------------------------------------ */

/** 3×3 rotation carrying object coordinates into world coordinates. */
export interface Transform3 {
  xAxis: Point3; yAxis: Point3; zAxis: Point3;
}

/** The arbitrary-axis algorithm: the OCS basis a normal implies.
 *  Returns null for the identity case, so callers can skip the work. */
export const ocsTransform = (extrusion?: Point3): Transform3 | null => {
  if (!extrusion) return null;
  const len = Math.hypot(extrusion.x, extrusion.y, extrusion.z);
  if (!len || !isFinite(len)) return null;
  const n = { x: extrusion.x / len, y: extrusion.y / len, z: extrusion.z / len };
  if (Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0) return null;
  /* pick the world axis the normal is least aligned with, per the spec's
     1/64 threshold, and build a right-handed basis from it */
  const w = (Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64)
    ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const cross = (a: Point3, b: Point3): Point3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  });
  const norm = (v: Point3): Point3 => {
    const d = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / d, y: v.y / d, z: v.z / d };
  };
  const xAxis = norm(cross(w, n));
  return { xAxis, yAxis: cross(n, xAxis), zAxis: n };
};

/** The rotation a saved view applies, as a 2D transform from world
 *  coordinates into the view's own frame. A drawing laid out at an angle
 *  is stored that way in model space and only reads square because the
 *  viewport carries VIEWTWIST; a renderer that draws model coordinates
 *  straight to the canvas shows it turned. The twist turns about the view
 *  TARGET, and pan and zoom compose on top of it.
 *
 *  The sense is the one that squares the drawing, measured rather than
 *  assumed: an AC1014 site plan whose line lengths pile up at 44 and 134
 *  degrees comes out at 0 and 88 under this transform, and stays skewed
 *  under its inverse.
 *
 *  Returns null for an untwisted view, so callers can skip the work. */
export const viewTwistTransform = (vport: {
  twist?: number; target?: Point3
}): Transform2 | null => {
  const twist = vport.twist ?? 0;
  if (!twist || !isFinite(twist)) return null;
  const t = vport.target ?? { x: 0, y: 0, z: 0 };
  return compose(
    compose(translation(t.x, t.y), rotationT(twist)),
    translation(-t.x, -t.y)
  );
};

/** The basis a UCS defines, ready for `ocsToWcs`. A drawing whose header
 *  carries a turned UCS keeps its rotation there and nowhere else before
 *  R2000, so this is the other half of reading such a file straight.
 *  Returns null when the UCS is the world one. */
export const ucsTransform = (ucs?: {
  xAxis: Point3; yAxis: Point3
}): Transform3 | null => {
  if (!ucs) return null;
  const { xAxis, yAxis } = ucs;
  const world = xAxis.x === 1 && xAxis.y === 0 && xAxis.z === 0
    && yAxis.x === 0 && yAxis.y === 1 && yAxis.z === 0;
  if (world) return null;
  const zAxis = {
    x: xAxis.y * yAxis.z - xAxis.z * yAxis.y,
    y: xAxis.z * yAxis.x - xAxis.x * yAxis.z,
    z: xAxis.x * yAxis.y - xAxis.y * yAxis.x
  };
  return { xAxis, yAxis, zAxis };
};

/** Map one point out of an OCS plane into world coordinates. */
export const ocsToWcs = (m: Transform3, p: Point3): Point3 => {
  const z = p.z ?? 0;
  return {
    x: m.xAxis.x * p.x + m.yAxis.x * p.y + m.zAxis.x * z,
    y: m.xAxis.y * p.x + m.yAxis.y * p.y + m.zAxis.y * z,
    z: m.xAxis.z * p.x + m.yAxis.z * p.y + m.zAxis.z * z
  };
};

/** Rewrite an entity's geometry from its own object plane into world
 *  coordinates, so renderers and measurements need no OCS awareness.
 *  Entities with the default normal are returned untouched.
 *
 *  A mirrored circle is the everyday case: AutoCAD stores it with a
 *  negated normal and a negated centre X, which reads as the wrong place
 *  until this runs. */
export const toWcs = (ent: Entity): Entity => {
  const m = ocsTransform(ent.extrusion);
  if (!m) return ent;
  const p = (q: Point3): Point3 => ocsToWcs(m, q);
  const p2 = (q: Point2, z = 0): Point2 => {
    const r = ocsToWcs(m, { x: q.x, y: q.y, z });
    return { x: r.x, y: r.y };
  };
  /* the plane's rotation about the normal, for angle-bearing entities */
  const spin = Math.atan2(m.xAxis.y, m.xAxis.x);
  const flipped = m.zAxis.z < 0;
  const out = { ...ent } as Entity;
  delete out.extrusion;
  switch (out.type) {
    case 'circle':
      out.center = p(out.center);
      return out;
    case 'arc': {
      /* a flipped plane reverses the sweep, so the ends trade places */
      out.center = p(out.center);
      const s = out.startAngle, e = out.endAngle;
      out.startAngle = flipped ? spin - e : spin + s;
      out.endAngle = flipped ? spin - s : spin + e;
      return out;
    }
    case 'ellipse':
      /* ELLIPSE is the one entity whose centre and major axis are already
         WORLD coordinates (DXF spells both "in WCS"); its normal only
         names the plane. Mapping them through the object plane threw
         every mirrored ellipse to the other side of the Y axis — checked
         against AutoCAD 2027, which draws them where they are stored.
         A negated normal does run the parameters the other way, so the
         swept range is reflected instead. */
      if (flipped) {
        const s = out.startParam, e = out.endParam;
        out.startParam = -e;
        out.endParam = -s;
      }
      return out;
    case 'point':
    case 'text':
    case 'mtext':
    case 'shape':
    case 'tolerance':
      out.position = p(out.position);
      if (out.type === 'text' && out.alignmentPoint) {
        out.alignmentPoint = p(out.alignmentPoint);
      }
      if ((out.type === 'text' || out.type === 'mtext') && spin) {
        out.rotation = (out.rotation ?? 0) + spin;
      }
      return out;
    case 'insert':
      out.position = p(out.position);
      /* A negated normal is a REFLECTION, not a half turn. The placement
         M·(P + R(rot)·S·q) is R(-rot)·diag(-sx, sy)·q about the mapped
         point, so the reference comes out mirrored and turned the other
         way — adding pi to the rotation instead flipped it about the wrong
         axis and put the block's contents on the other side of it.
         Checked against AutoCAD 2027, which frames one such reference in
         this file at (269.28, 180.05) where the half turn had it at
         (349.41, -18.49). */
      if (flipped) {
        out.rotation = -(out.rotation ?? 0);
        const s = out.scale ?? { x: 1, y: 1, z: 1 };
        out.scale = { x: -s.x, y: s.y, z: s.z };
      } else if (spin) out.rotation = (out.rotation ?? 0) + spin;
      return out;
    case 'solid':
    case 'face3d':
      out.corners = out.corners.map(p) as typeof out.corners;
      return out;
    case 'polyline': {
      const z = out.elevation ?? 0;
      out.vertices = out.vertices.map((v) => ({ ...v, ...p2(v, z) }));
      if (z) {
        const lifted = ocsToWcs(m, { x: 0, y: 0, z });
        out.elevation = lifted.z;
      }
      return out;
    }
    case 'hatch':
      out.loops = out.loops.map((loop) => {
        if (loop.kind === 'polyline') {
          return {
            ...loop,
            vertices: loop.vertices.map((v) => ({ ...v, ...p2(v, out.elevation ?? 0) }))
          };
        }
        if (loop.kind === 'circle') return { ...loop, center: p2(loop.center) };
        if (loop.kind === 'ellipse') {
          return {
            ...loop, center: p2(loop.center), majorAxis: p2(loop.majorAxis)
          };
        }
        return loop;
      });
      return out;
    default:
      return out;
  }
};

/* ------------------------------------------------------------------ *
 * bulges and arcs
 * ------------------------------------------------------------------ */

/** Below this a bulge is arc-fit junk, not curvature: |b| is the sagitta
 *  over half the chord, so 1e-8 puts the bow 5e-9 of the chord off the
 *  straight line — an implied radius of 1e8 chords. AutoCAD draws the
 *  chord; sampling the "arc" only spreads the rounding noise of a
 *  centre a hundred million chords away over the segment. */
const BULGE_EPS = 1e-8;

/** Signed CCW sweep from `start` to `end`, the way AutoCAD reads an arc:
 *  a whole turn only when the file really spells one out. Equal angles are
 *  a zero-length arc — the degenerate leftover of an arc-fit — and NOT the
 *  full circle that `(end - start) mod 2pi` alone would make of them. */
export const arcSweep = (start: number, end: number): number => {
  const raw = end - start;
  if (Math.abs(raw) >= TAU - 1e-9) return TAU;
  const s = raw % TAU;
  if (Math.abs(s) < 1e-12) return 0;
  return s < 0 ? s + TAU : s;
};

/** Sample a bulged polyline segment (excluding the start point). */
export const sampleBulge = (
  p1: Point2, p2: Point2, bulge: number, maxSeg = 32
): Point2[] => {
  if (!bulge || Math.abs(bulge) < BULGE_EPS) return [{ x: p2.x, y: p2.y }];
  const theta = 4 * Math.atan(bulge);
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dist < 1e-12) return [{ x: p2.x, y: p2.y }];
  const radius = dist / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const perp = (Math.abs(theta) > Math.PI ? -1 : 1) * Math.sign(bulge);
  const h = Math.sqrt(Math.max(0, radius * radius - (dist / 2) ** 2)) * perp;
  const cx = mx - (h * (p2.y - p1.y)) / dist;
  const cy = my + (h * (p2.x - p1.x)) / dist;
  const a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const n = Math.max(2, Math.min(maxSeg, Math.ceil(Math.abs(theta) / (Math.PI / 24))));
  const out: Point2[] = [];
  for (let i = 1; i <= n; i++) {
    const a = a1 + theta * (i / n);
    out.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  out[out.length - 1] = { x: p2.x, y: p2.y };
  return out;
};

/** Flatten polyline vertices (with bulges) into a plain point run. */
export const flattenPolyline = (
  vertices: readonly PolylineVertex[], closed: boolean
): Point2[] => {
  if (!vertices.length) return [];
  const pts: Point2[] = [{ x: vertices[0].x, y: vertices[0].y }];
  const n = vertices.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const v = vertices[i], w = vertices[(i + 1) % n];
    pts.push(...sampleBulge(v, w, v.bulge ?? 0));
  }
  return pts;
};

/** Flatten any hatch boundary into a sampled point loop. */
export const boundaryPoints = (b: HatchBoundary): Point2[] => {
  switch (b.kind) {
    case 'polyline': return flattenPolyline(b.vertices, b.closed);
    case 'circle': {
      const out: Point2[] = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * TAU;
        out.push({ x: b.center.x + b.radius * Math.cos(a), y: b.center.y + b.radius * Math.sin(a) });
      }
      return out;
    }
    case 'ellipse': {
      const rx = Math.hypot(b.majorAxis.x, b.majorAxis.y);
      const ry = rx * b.ratio;
      const co = rx ? b.majorAxis.x / rx : 1, si = rx ? b.majorAxis.y / rx : 0;
      const out: Point2[] = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * TAU;
        const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
        out.push({ x: b.center.x + ex * co - ey * si, y: b.center.y + ex * si + ey * co });
      }
      return out;
    }
    case 'edges': {
      const out: Point2[] = [];
      for (const e of b.edges) {
        if (e.kind === 'line') { out.push(e.start, e.end); }
        else if (e.kind === 'arc') {
          const sweep = sweepOf(e.startAngle, e.endAngle, e.ccw);
          for (let i = 0; i <= 24; i++) {
            const a = e.startAngle + sweep * (i / 24);
            out.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
          }
        } else if (e.kind === 'ellipticalArc') {
          const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
          const ry = rx * e.ratio;
          const co = rx ? e.majorAxis.x / rx : 1, si = rx ? e.majorAxis.y / rx : 0;
          const sweep = sweepOf(e.startAngle, e.endAngle, e.ccw);
          for (let i = 0; i <= 24; i++) {
            const a = e.startAngle + sweep * (i / 24);
            const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
            out.push({ x: e.center.x + ex * co - ey * si, y: e.center.y + ex * si + ey * co });
          }
        } else {
          out.push(...(e.fitPoints?.length ? e.fitPoints : e.controlPoints));
        }
      }
      return out;
    }
  }
};

const sweepOf = (a0: number, a1: number, ccw: boolean): number => {
  let sweep = (a1 - a0) % TAU;
  if (ccw && sweep <= 0) sweep += TAU;
  if (!ccw && sweep >= 0) sweep -= TAU;
  if (!sweep) return TAU;
  /* A boundary edge that wraps all but a hair of a full turn is arc-fit
     junk: its two ends are a hairline apart, and the direction flag sends
     the sampler the long way round, which turns a 5-unit sliver of a
     chair outline into a 4000-unit disc. AutoCAD draws the hair, so the
     complement is what the loop means. An island that really is a whole
     circle spells the turn exactly and is left alone. */
  const gap = TAU - Math.abs(sweep);
  if (gap > 1e-9 && gap < 0.1) return sweep > 0 ? sweep - TAU : sweep + TAU;
  return sweep;
};

/* ------------------------------------------------------------------ *
 * bounding boxes
 * ------------------------------------------------------------------ */

const growAll = (b: Bounds, pts: Iterable<Point2>): void => {
  for (const p of pts) {
    if (!isFinite(p.x) || !isFinite(p.y)) continue;
    if (p.x < b.min.x) b.min.x = p.x;
    if (p.y < b.min.y) b.min.y = p.y;
    if (p.x > b.max.x) b.max.x = p.x;
    if (p.y > b.max.y) b.max.y = p.y;
  }
};

/** 2D bounding box of one entity; null when it has none (xline/ray/unknown). */
export const entityBounds = (
  entity: Entity, blocks?: Drawing['blocks']
): Bounds | null => {
  /* geometry in its own plane must reach world coordinates first, or a
     mirrored entity measures on the wrong side of the drawing */
  const ent = entity.extrusion ? toWcs(entity) : entity;
  const b: Bounds = {
    min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity }
  };
  switch (ent.type) {
    case 'line': growAll(b, [ent.start, ent.end]); break;
    case 'point': growAll(b, [ent.position]); break;
    case 'circle':
      growAll(b, [
        { x: ent.center.x - ent.radius, y: ent.center.y - ent.radius },
        { x: ent.center.x + ent.radius, y: ent.center.y + ent.radius }
      ]);
      break;
    case 'arc': {
      /* the run it draws, not the circle it was cut from: files carry
         arc-fit slivers of megaunit radius, and boxing those as whole
         circles put a 0.07-unit hairline on a 56000000-unit page */
      const sweep = arcSweep(ent.startAngle, ent.endAngle);
      const at = (a: number): Point2 => ({
        x: ent.center.x + ent.radius * Math.cos(a),
        y: ent.center.y + ent.radius * Math.sin(a)
      });
      if (sweep >= TAU) {
        growAll(b, [
          { x: ent.center.x - ent.radius, y: ent.center.y - ent.radius },
          { x: ent.center.x + ent.radius, y: ent.center.y + ent.radius }
        ]);
        break;
      }
      growAll(b, [at(ent.startAngle), at(ent.startAngle + sweep)]);
      for (let q = 0; q < 4; q++) {
        const a = q * (Math.PI / 2);
        let d = (a - ent.startAngle) % TAU;
        if (d < 0) d += TAU;
        if (d <= sweep) growAll(b, [at(a)]);
      }
      break;
    }
    case 'ellipse': {
      const rr = Math.hypot(ent.majorAxis.x, ent.majorAxis.y);
      growAll(b, [
        { x: ent.center.x - rr, y: ent.center.y - rr },
        { x: ent.center.x + rr, y: ent.center.y + rr }
      ]);
      break;
    }
    case 'polyline': growAll(b, flattenPolyline(ent.vertices, ent.closed)); break;
    case 'spline':
      growAll(b, ent.controlPoints);
      growAll(b, ent.fitPoints ?? []);
      break;
    case 'text':
    case 'mtext': {
      const h = ent.height > 0 ? ent.height : 5;
      growAll(b, [
        { x: ent.position.x, y: ent.position.y - h },
        { x: ent.position.x + ent.text.length * h * 0.8, y: ent.position.y + h }
      ]);
      break;
    }
    case 'insert': {
      const def = blocks?.[ent.blockName];
      if (def) {
        const m = insertTransform(ent.position, ent.scale, ent.rotation);
        for (const child of def.entities) {
          const cb = entityBounds(child, blocks);
          if (!cb) continue;
          growAll(b, [
            applyPt(m, cb.min), applyPt(m, cb.max),
            applyPt(m, { x: cb.min.x, y: cb.max.y }),
            applyPt(m, { x: cb.max.x, y: cb.min.y })
          ]);
        }
      } else growAll(b, [ent.position]);
      break;
    }
    case 'hatch': for (const l of ent.loops) growAll(b, boundaryPoints(l)); break;
    case 'solid': growAll(b, ent.corners); break;
    case 'face3d': growAll(b, ent.corners); break;
    case 'leader': growAll(b, ent.vertices); break;
    case 'mline': growAll(b, ent.vertices.map((v) => v.position)); break;
    case 'mesh': growAll(b, ent.vertices); break;
    case 'shape': growAll(b, [ent.position]); break;
    case 'tolerance': growAll(b, [ent.position]); break;
    case 'dimension':
      growAll(b, [ent.definitionPoint]);
      for (const p of [ent.textMidpoint, ent.point13, ent.point14, ent.point15, ent.point16]) {
        if (p) growAll(b, [p]);
      }
      break;
    case 'viewport': {
      growAll(b, [
        { x: ent.center.x - ent.width / 2, y: ent.center.y - ent.height / 2 },
        { x: ent.center.x + ent.width / 2, y: ent.center.y + ent.height / 2 }
      ]);
      break;
    }
    case 'image': {
      const ex = ent.position.x + ent.uVector.x * ent.widthPx + ent.vVector.x * ent.heightPx;
      const ey = ent.position.y + ent.uVector.y * ent.widthPx + ent.vVector.y * ent.heightPx;
      growAll(b, [ent.position, { x: ex, y: ey }]);
      break;
    }
    case 'light':
      growAll(b, ent.target ? [ent.position, ent.target] : [ent.position]);
      break;
    case 'mleader': {
      for (const l of ent.leaders) for (const line of l.lines) growAll(b, line);
      if (ent.textPosition) growAll(b, [ent.textPosition]);
      break;
    }
    case 'table': {
      const w = ent.columnWidths.reduce((s, v) => s + v, 0);
      const h = ent.rowHeights.reduce((s, v) => s + v, 0);
      growAll(b, [ent.position, { x: ent.position.x + w, y: ent.position.y - h }]);
      break;
    }
    case 'ole':
      growAll(b, ent.corners);
      break;
    case 'pointcloud':
      growAll(b, [ent.extentsMin, ent.extentsMax]);
      break;
    case 'proxy':
      for (const s of ent.graphics) {
        const sb = entityBounds(s, blocks);
        if (sb) growAll(b, [sb.min, sb.max]);
      }
      break;
    case 'unknown':
      for (const s of ent.graphics ?? []) {
        const sb = entityBounds(s, blocks);
        if (sb) growAll(b, [sb.min, sb.max]);
      }
      break;
    case 'ray': case 'xline': case 'acis': return null;
  }
  return b.min.x <= b.max.x ? b : null;
};

/** Model-space bounding box of a drawing (inserts resolved through blocks). */
export const drawingBounds = (drawing: Drawing): Bounds | null => {
  const b: Bounds = {
    min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity }
  };
  for (const e of drawing.entities) {
    const eb = entityBounds(e, drawing.blocks);
    if (eb) { growAll(b, [eb.min, eb.max]); }
  }
  return b.min.x <= b.max.x ? b : null;
};

/** The bounds of the drawing's dense mass, not its raw extents.
 *
 * A stray entity parked megaunits from the content — georeferenced UTM
 * drawings keep junk at the origin, and vice versa — makes drawingBounds
 * frame the real drawing as a dot. Cluster = 5th..95th percentile of
 * entity-bounds centres per axis, grown 2x its span to take in outliers
 * that still belong; the cluster only wins when the full extents dwarf it
 * (>4x linear), so ordinary drawings return exactly drawingBounds. */
export const contentBounds = (drawing: Drawing): Bounds | null => {
  const full = drawingBounds(drawing);
  if (!full) return null;
  const bs: Bounds[] = [];
  for (const e of drawing.entities) {
    const eb = entityBounds(e, drawing.blocks);
    if (eb && isFinite(eb.min.x) && isFinite(eb.max.x) &&
        isFinite(eb.min.y) && isFinite(eb.max.y)) bs.push(eb);
  }
  if (!bs.length) return full;
  const xs = bs.map((b) => (b.min.x + b.max.x) / 2).sort((a, b) => a - b);
  const ys = bs.map((b) => (b.min.y + b.max.y) / 2).sort((a, b) => a - b);
  const q = (arr: number[], p: number): number =>
    arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const spanX = Math.max(q(xs, 0.95) - q(xs, 0.05), 1e-9);
  const spanY = Math.max(q(ys, 0.95) - q(ys, 0.05), 1e-9);
  const gx0 = q(xs, 0.05) - 2 * spanX, gx1 = q(xs, 0.95) + 2 * spanX;
  const gy0 = q(ys, 0.05) - 2 * spanY, gy1 = q(ys, 0.95) + 2 * spanY;
  const c: Bounds = {
    min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity }
  };
  for (const b of bs) {
    const bx = (b.min.x + b.max.x) / 2, by = (b.min.y + b.max.y) / 2;
    if (bx < gx0 || bx > gx1 || by < gy0 || by > gy1) continue;
    growAll(c, [b.min, b.max]);
  }
  if (c.min.x > c.max.x) return full;
  const keep =
    (full.max.x - full.min.x) < 4 * Math.max(c.max.x - c.min.x, 1e-9) &&
    (full.max.y - full.min.y) < 4 * Math.max(c.max.y - c.min.y, 1e-9);
  return keep ? full : c;
};

/* ------------------------------------------------------------------ *
 * transform + explode
 * ------------------------------------------------------------------ */

/** Return a transformed copy of an entity (2D affine; z passes through). */
export const transformEntity = (ent: Entity, m: Transform2): Entity => {
  const e = clone(ent);
  const rot = Math.atan2(m.b, m.a);
  const scl = Math.hypot(m.a, m.b);
  switch (e.type) {
    case 'line': e.start = apply3(m, e.start); e.end = apply3(m, e.end); break;
    case 'point': e.position = apply3(m, e.position); break;
    case 'circle': case 'arc':
      e.center = apply3(m, e.center);
      e.radius *= scl;
      if (e.type === 'arc') { e.startAngle += rot; e.endAngle += rot; }
      break;
    case 'ellipse': {
      e.center = apply3(m, e.center);
      const maj = applyPt(m, { x: e.majorAxis.x, y: e.majorAxis.y });
      const org = applyPt(m, { x: 0, y: 0 });
      e.majorAxis = { x: maj.x - org.x, y: maj.y - org.y, z: 0 };
      break;
    }
    case 'polyline':
      for (const v of e.vertices) {
        const p = applyPt(m, v);
        v.x = p.x; v.y = p.y;
        if (v.startWidth) v.startWidth *= scl;
        if (v.endWidth) v.endWidth *= scl;
      }
      if (e.constantWidth) e.constantWidth *= scl;
      break;
    case 'spline':
      e.controlPoints = e.controlPoints.map((p) => apply3(m, p));
      if (e.fitPoints) e.fitPoints = e.fitPoints.map((p) => apply3(m, p));
      break;
    case 'text': case 'mtext':
      e.position = apply3(m, e.position);
      if (e.type === 'text' && e.alignmentPoint) {
        e.alignmentPoint = apply3(m, e.alignmentPoint);
      }
      e.height *= scl;
      e.rotation += rot;
      break;
    case 'insert':
      e.position = apply3(m, e.position);
      e.rotation += rot;
      e.scale = { x: e.scale.x * scl, y: e.scale.y * scl, z: e.scale.z };
      break;
    case 'solid': case 'face3d':
      e.corners = e.corners.map((p) => apply3(m, p)) as typeof e.corners;
      break;
    case 'leader': e.vertices = e.vertices.map((p) => apply3(m, p)); break;
    case 'mesh': e.vertices = e.vertices.map((p) => apply3(m, p)); break;
    case 'mline':
      e.basePoint = apply3(m, e.basePoint);
      for (const v of e.vertices) v.position = apply3(m, v.position);
      e.scale *= scl;
      break;
    case 'ray': case 'xline':
      e.basePoint = apply3(m, e.basePoint);
      break;
    case 'dimension':
      e.definitionPoint = apply3(m, e.definitionPoint);
      if (e.textMidpoint) e.textMidpoint = apply3(m, e.textMidpoint);
      for (const k of ['point13', 'point14', 'point15', 'point16'] as const) {
        if (e[k]) e[k] = apply3(m, e[k]!);
      }
      break;
    case 'hatch':
      for (const l of e.loops) {
        if (l.kind === 'polyline') {
          for (const v of l.vertices) { const p = applyPt(m, v); v.x = p.x; v.y = p.y; }
        } else if (l.kind === 'circle') {
          l.center = applyPt(m, l.center); l.radius *= scl;
        } else if (l.kind === 'ellipse') {
          const maj = applyPt(m, { x: l.center.x + l.majorAxis.x, y: l.center.y + l.majorAxis.y });
          l.center = applyPt(m, l.center);
          l.majorAxis = { x: maj.x - l.center.x, y: maj.y - l.center.y };
        } else {
          for (const ed of l.edges) {
            if (ed.kind === 'line') { ed.start = applyPt(m, ed.start); ed.end = applyPt(m, ed.end); }
            else if (ed.kind === 'arc') {
              ed.center = applyPt(m, ed.center); ed.radius *= scl;
              ed.startAngle += rot; ed.endAngle += rot;
            } else if (ed.kind === 'ellipticalArc') {
              const maj = applyPt(m, { x: ed.center.x + ed.majorAxis.x, y: ed.center.y + ed.majorAxis.y });
              ed.center = applyPt(m, ed.center);
              ed.majorAxis = { x: maj.x - ed.center.x, y: maj.y - ed.center.y };
              ed.startAngle += rot; ed.endAngle += rot;
            } else {
              ed.controlPoints = ed.controlPoints.map((p) => applyPt(m, p));
              if (ed.fitPoints) ed.fitPoints = ed.fitPoints.map((p) => applyPt(m, p));
            }
          }
        }
      }
      break;
    case 'image':
      e.position = apply3(m, e.position);
      break;
    case 'shape': case 'tolerance':
      e.position = apply3(m, e.position);
      break;
    case 'viewport':
      e.center = apply3(m, e.center);
      e.width *= scl; e.height *= scl;
      break;
    case 'light':
      e.position = apply3(m, e.position);
      if (e.target) e.target = apply3(m, e.target);
      break;
    case 'mleader':
      for (const l of e.leaders) {
        l.lines = l.lines.map((line) => line.map((p) => apply3(m, p)));
        if (l.landing) l.landing = apply3(m, l.landing);
      }
      if (e.textPosition) e.textPosition = apply3(m, e.textPosition);
      if (e.blockPosition) e.blockPosition = apply3(m, e.blockPosition);
      break;
    case 'table':
      e.position = apply3(m, e.position);
      break;
    case 'ole':
      e.corners = e.corners.map((p2) => apply3(m, p2)) as typeof e.corners;
      break;
    case 'pointcloud':
      e.extentsMin = apply3(m, e.extentsMin);
      e.extentsMax = apply3(m, e.extentsMax);
      break;
    case 'proxy':
      e.graphics = e.graphics.map((s) => transformEntity(s, m));
      break;
    case 'unknown':
      if (e.graphics) e.graphics = e.graphics.map((s) => transformEntity(s, m));
      break;
    case 'acis': break;
  }
  return e;
};

/** Explode an INSERT into transformed copies of its block's entities.
 *  Nested inserts are exploded recursively up to `depth`. */
export const explodeInsert = (
  ent: Extract<Entity, { type: 'insert' }>,
  blocks: Drawing['blocks'],
  depth = 8
): Entity[] => {
  const def = blocks[ent.blockName];
  if (!def || depth <= 0) return [];
  const base = def.basePoint ?? { x: 0, y: 0, z: 0 };
  const m = compose(
    insertTransform(ent.position, ent.scale, ent.rotation),
    translation(-base.x, -base.y));
  const out: Entity[] = [];
  for (const child of def.entities) {
    const t = transformEntity(child, m);
    if (t.type === 'insert') out.push(...explodeInsert(t, blocks, depth - 1), t);
    else out.push(t);
  }
  out.push(...(ent.attributes ?? []).map(clone));
  return out;
};

/** Explode a polyline into lines and arcs (bulges become true arcs). */
export const explodePolyline = (
  ent: Extract<Entity, { type: 'polyline' }>
): Entity[] => {
  const out: Entity[] = [];
  const n = ent.vertices.length;
  const last = ent.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const v = ent.vertices[i], w = ent.vertices[(i + 1) % n];
    if (v.bulge) {
      const theta = 4 * Math.atan(v.bulge);
      const dist = Math.hypot(w.x - v.x, w.y - v.y);
      if (dist > 1e-12) {
        const radius = dist / (2 * Math.sin(Math.abs(theta) / 2));
        const mx = (v.x + w.x) / 2, my = (v.y + w.y) / 2;
        const perp = (Math.abs(theta) > Math.PI ? -1 : 1) * Math.sign(v.bulge);
        const h = Math.sqrt(Math.max(0, radius * radius - (dist / 2) ** 2)) * perp;
        const cx = mx - (h * (w.y - v.y)) / dist;
        const cy = my + (h * (w.x - v.x)) / dist;
        let a1 = Math.atan2(v.y - cy, v.x - cx);
        let a2 = Math.atan2(w.y - cy, w.x - cx);
        if (v.bulge < 0) [a1, a2] = [a2, a1];
        out.push({
          type: 'arc', layer: ent.layer, color: ent.color,
          center: { x: cx, y: cy, z: 0 }, radius, startAngle: a1, endAngle: a2
        });
        continue;
      }
    }
    out.push({
      type: 'line', layer: ent.layer, color: ent.color,
      start: { x: v.x, y: v.y, z: 0 }, end: { x: w.x, y: w.y, z: 0 }
    });
  }
  return out;
};
