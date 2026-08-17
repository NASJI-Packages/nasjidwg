/* nasjidwg — proxy graphics.
 *
 * An application entity nobody else can interpret still ships a cached
 * picture of itself: a little display list of primitives (circles, arcs,
 * polylines, meshes, text) prefixed to the object's record. Decoding it
 * turns an otherwise opaque proxy into drawable geometry, so a viewer can
 * show the entity even without the owning application.
 *
 * The stream is plain little-endian: overall size, primitive count, then
 * per primitive a byte size, a type tag and its payload.
 */

import type { Entity, Point3 } from '../core/model.js';

/** Primitive type tags in the display list. */
const enum Kind {
  Extents = 1, Circle = 2, CirclePt3 = 3, CircularArc = 4, CircularArc3Pt = 5,
  Polyline = 6, Polygon = 7, Mesh = 8, Shell = 9, Text = 10, Text2 = 11,
  XLine = 12, Ray = 13, PolylineWithNormal = 32, LwPolyline = 33,
  UnicodeText = 36
}

interface Cursor { dv: DataView; pos: number; end: number }

const i32 = (c: Cursor): number => {
  if (c.pos + 4 > c.end) throw new RangeError('proxy: past end');
  const v = c.dv.getInt32(c.pos, true);
  c.pos += 4;
  return v;
};
const f64 = (c: Cursor): number => {
  if (c.pos + 8 > c.end) throw new RangeError('proxy: past end');
  const v = c.dv.getFloat64(c.pos, true);
  c.pos += 8;
  return v;
};
const pt = (c: Cursor): Point3 => ({ x: f64(c), y: f64(c), z: f64(c) });

/** Decode the cached display list of a proxy entity into real entities.
 *  Anything unrecognized is skipped; a malformed stream yields whatever
 *  was decoded before the damage. */
export const decodeProxyGraphics = (
  data: Uint8Array, layer: string, color: Entity['color']
): Entity[] => {
  const out: Entity[] = [];
  if (data.length < 8) return out;
  const c: Cursor = {
    dv: new DataView(data.buffer, data.byteOffset, data.byteLength),
    pos: 0,
    end: data.length
  };
  const base = { layer, color } as const;
  try {
    i32(c);                               /* overall size */
    const count = i32(c);
    if (count < 0 || count > 100000) return out;
    for (let i = 0; i < count; i++) {
      if (c.pos + 8 > c.end) break;
      const size = i32(c);                /* includes the size and type */
      const type = i32(c);
      const next = size > 8 ? c.pos + size - 8 : c.end;
      switch (type) {
        case Kind.Circle: {
          const center = pt(c);
          const radius = f64(c);
          if (radius > 0) out.push({ ...base, type: 'circle', center, radius });
          break;
        }
        case Kind.CirclePt3: {
          /* three points on the circle: centre and radius follow from them */
          const p1 = pt(c), p2 = pt(c), p3 = pt(c);
          const circle = circleFrom3(p1, p2, p3);
          if (circle) out.push({ ...base, type: 'circle', ...circle });
          break;
        }
        case Kind.CircularArc: {
          const center = pt(c);
          const radius = f64(c);
          pt(c);                          /* normal */
          const dir = pt(c);
          const sweep = f64(c);
          const start = Math.atan2(dir.y, dir.x);
          if (radius > 0) {
            out.push({
              ...base, type: 'arc', center, radius,
              startAngle: start, endAngle: start + sweep
            });
          }
          break;
        }
        case Kind.CircularArc3Pt: {
          const p1 = pt(c), p2 = pt(c), p3 = pt(c);
          const circle = circleFrom3(p1, p2, p3);
          if (circle) {
            const a = (p: Point3): number =>
              Math.atan2(p.y - circle.center.y, p.x - circle.center.x);
            out.push({
              ...base, type: 'arc', center: circle.center, radius: circle.radius,
              startAngle: a(p1), endAngle: a(p3)
            });
          }
          break;
        }
        case Kind.Polyline:
        case Kind.Polygon:
        case Kind.PolylineWithNormal:
        case Kind.LwPolyline: {
          const n = i32(c);
          if (n < 0 || n > 200000) break;
          const pts: Point3[] = [];
          for (let k = 0; k < n; k++) pts.push(pt(c));
          if (pts.length >= 2) {
            out.push({
              ...base, type: 'polyline',
              vertices: pts.map((p) => ({ x: p.x, y: p.y })),
              closed: type === Kind.Polygon
            });
          }
          break;
        }
        case Kind.Mesh: {
          const rows = i32(c);
          const cols = i32(c);
          const n = rows * cols;
          if (n < 0 || n > 200000) break;
          const pts: Point3[] = [];
          for (let k = 0; k < n; k++) pts.push(pt(c));
          if (pts.length) {
            out.push({
              ...base, type: 'mesh', meshKind: 'grid',
              vertices: pts, mSize: rows, nSize: cols
            });
          }
          break;
        }
        case Kind.Shell: {
          const numPts = i32(c);
          if (numPts < 0 || numPts > 200000) break;
          const pts: Point3[] = [];
          for (let k = 0; k < numPts; k++) pts.push(pt(c));
          const faceDataSize = i32(c);
          const faces: number[][] = [];
          if (faceDataSize > 0 && faceDataSize < 200000) {
            let read = 0;
            while (read < faceDataSize && c.pos + 4 <= next) {
              const n = i32(c);
              read++;
              const face: number[] = [];
              for (let k = 0; k < Math.abs(n) && read < faceDataSize; k++) {
                face.push(i32(c) + 1);    /* proxy indices are 0-based */
                read++;
              }
              if (face.length >= 3) faces.push(face);
            }
          }
          if (pts.length) {
            out.push({
              ...base, type: 'mesh', meshKind: 'faces',
              vertices: pts, faces: faces.length ? faces : undefined
            });
          }
          break;
        }
        case Kind.Text:
        case Kind.Text2:
        case Kind.UnicodeText: {
          const position = pt(c);
          pt(c);                          /* normal */
          const dir = pt(c);
          const height = f64(c);
          f64(c);                         /* width factor */
          f64(c);                         /* oblique */
          const len = i32(c);
          let text = '';
          if (len > 0 && len < 100000) {
            for (let k = 0; k < len && c.pos < next; k++) {
              const ch = type === Kind.UnicodeText
                ? c.dv.getUint16((c.pos += 2) - 2, true)
                : data[c.pos++];
              if (ch) text += String.fromCharCode(ch);
            }
          }
          if (text) {
            out.push({
              ...base, type: 'text', position, text,
              height: height > 0 ? height : 1,
              rotation: Math.atan2(dir.y, dir.x)
            });
          }
          break;
        }
        case Kind.XLine:
        case Kind.Ray: {
          const basePoint = pt(c);
          const second = pt(c);
          out.push({
            ...base, type: type === Kind.Ray ? 'ray' : 'xline',
            basePoint,
            direction: {
              x: second.x - basePoint.x,
              y: second.y - basePoint.y,
              z: (second.z ?? 0) - (basePoint.z ?? 0)
            }
          });
          break;
        }
        default:
          break;                          /* traits and clips carry no shape */
      }
      /* every primitive declares its own length, so a partially-read or
         unknown one never desynchronizes the list */
      if (next <= c.end && next > c.pos) c.pos = next;
      else if (next <= c.pos) continue;
      else break;
    }
  } catch {
    /* keep what was decoded */
  }
  return out;
};

/** Circle through three points, or null when they are collinear. */
const circleFrom3 = (
  a: Point3, b: Point3, cc: Point3
): { center: Point3; radius: number } | null => {
  const d = 2 * (a.x * (b.y - cc.y) + b.x * (cc.y - a.y) + cc.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = cc.x * cc.x + cc.y * cc.y;
  const ux = (a2 * (b.y - cc.y) + b2 * (cc.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (cc.x - b.x) + b2 * (a.x - cc.x) + c2 * (b.x - a.x)) / d;
  const center = { x: ux, y: uy, z: a.z ?? 0 };
  return { center, radius: Math.hypot(a.x - ux, a.y - uy) };
};
