/* nasjidwg — hatch pattern files (.pat) and pattern explosion.
 *
 * A .pat file is a list of named patterns, each a set of definition lines:
 *   *NAME, description
 *   angle, x-origin, y-origin, delta-x, delta-y [, dash...]
 * The same definition lines live inside a HATCH entity, so one parser
 * serves both, and explodePattern() turns them into drawable line runs.
 */

import type {
  Entity, HatchDefLine, HatchEntity, Point2
} from '../core/model.js';
import { boundaryPoints } from '../core/geo.js';

export interface HatchPattern {
  name: string;
  description?: string;
  lines: HatchDefLine[];
}

const DEG = Math.PI / 180;

/** Parse a .pat file into its patterns. Malformed lines are skipped. */
export const readPatternFile = (text: string): HatchPattern[] => {
  const out: HatchPattern[] = [];
  let cur: HatchPattern | null = null;
  for (const raw of String(text ?? '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('*')) {
      const comma = line.indexOf(',');
      cur = {
        name: (comma === -1 ? line.slice(1) : line.slice(1, comma)).trim(),
        description: comma === -1 ? undefined : line.slice(comma + 1).trim(),
        lines: []
      };
      if (cur.name) out.push(cur);
      continue;
    }
    if (!cur) continue;
    const nums = line.split(',').map((s) => parseFloat(s.trim()));
    if (nums.length < 5 || nums.some((n, i) => i < 5 && !isFinite(n))) continue;
    cur.lines.push({
      angle: nums[0],
      base: { x: nums[1], y: nums[2] },
      offset: { x: nums[3], y: nums[4] },
      dashes: nums.slice(5).filter((n) => isFinite(n))
    });
  }
  return out.filter((p) => p.lines.length);
};

/** Serialize patterns back to .pat text. */
export const writePatternFile = (patterns: readonly HatchPattern[]): string => {
  const num = (n: number): string =>
    Number.isInteger(n) ? String(n) : String(Math.round(n * 1e8) / 1e8);
  const out: string[] = [];
  for (const p of patterns) {
    out.push('*' + p.name + (p.description ? ', ' + p.description : ''));
    for (const l of p.lines) {
      const parts = [l.angle, l.base.x, l.base.y, l.offset.x, l.offset.y]
        .map(num)
        .concat(l.dashes.map(num));
      out.push(parts.join(', '));
    }
  }
  return out.join('\n') + '\n';
};

/* ------------------------------------------------------------------ */

interface Seg { a: Point2; b: Point2 }

/** Clip a segment to a polygon using the even-odd rule, keeping the runs
 *  that fall inside. */
const clipToLoops = (seg: Seg, loops: Point2[][]): Seg[] => {
  const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return [];
  const ts: number[] = [0, 1];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      const ex = q.x - p.x, ey = q.y - p.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p.x - seg.a.x) * ey - (p.y - seg.a.y) * ex) / den;
      const u = ((p.x - seg.a.x) * dy - (p.y - seg.a.y) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  const inside = (pt: Point2): boolean => {
    let count = 0;
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        if ((p.y > pt.y) !== (q.y > pt.y)) {
          const xAt = p.x + ((pt.y - p.y) / (q.y - p.y)) * (q.x - p.x);
          if (xAt > pt.x) count++;
        }
      }
    }
    return (count & 1) === 1;
  };
  const out: Seg[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const mid = (t0 + t1) / 2;
    if (!inside({ x: seg.a.x + dx * mid, y: seg.a.y + dy * mid })) continue;
    out.push({
      a: { x: seg.a.x + dx * t0, y: seg.a.y + dy * t0 },
      b: { x: seg.a.x + dx * t1, y: seg.a.y + dy * t1 }
    });
  }
  return out;
};

/** Split a segment into the dash pattern's on-runs. */
const applyDashes = (seg: Seg, dashes: readonly number[], scale: number): Seg[] => {
  if (!dashes.length) return [seg];
  const total = dashes.reduce((s, d) => s + Math.abs(d), 0) * scale;
  if (total < 1e-9) return [seg];
  const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  const ux = (seg.b.x - seg.a.x) / len, uy = (seg.b.y - seg.a.y) / len;
  const out: Seg[] = [];
  let pos = 0, i = 0;
  let guard = 0;
  while (pos < len && guard++ < 100000) {
    const d = dashes[i % dashes.length] * scale;
    const run = Math.abs(d) < 1e-9 ? 1e-6 : Math.abs(d);
    const end = Math.min(pos + run, len);
    if (d >= 0) {
      out.push({
        a: { x: seg.a.x + ux * pos, y: seg.a.y + uy * pos },
        b: { x: seg.a.x + ux * end, y: seg.a.y + uy * end }
      });
    }
    pos = end;
    i++;
  }
  return out;
};

/** Explode a hatch into the line entities its pattern draws inside its
 *  boundaries. Solid fills yield nothing (there is no line work). */
export const explodeHatch = (
  hatch: HatchEntity, pattern?: HatchPattern
): Entity[] => {
  if (hatch.solid) return [];
  const defLines = hatch.definitionLines?.length
    ? hatch.definitionLines
    : pattern?.lines;
  if (!defLines?.length) return [];

  const loops = hatch.loops.map((l) => boundaryPoints(l)).filter((p) => p.length > 2);
  if (!loops.length) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of loops) {
    for (const p of loop) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const span = Math.hypot(maxX - minX, maxY - minY);
  if (!isFinite(span) || span < 1e-9) return [];

  const scale = hatch.scale > 0 ? hatch.scale : 1;
  const rot = (hatch.angle || 0) * DEG;
  const out: Entity[] = [];

  for (const dl of defLines) {
    const ang = dl.angle * DEG + rot;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    /* the offset is expressed along the line and across it */
    const acrossX = -uy, acrossY = ux;
    const across = Math.hypot(dl.offset.x, dl.offset.y) * scale;
    if (across < 1e-9) continue;
    const baseX = dl.base.x * scale, baseY = dl.base.y * scale;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const half = Math.ceil(span / across) + 2;
    /* The family repeats forever, so only the origin's phase within one
       spacing matters — the absolute distance would place every line far
       outside the boundary. */
    const rel = (baseX - cx) * acrossX + (baseY - cy) * acrossY;
    const d0 = rel - Math.round(rel / across) * across;
    /* consecutive lines also step along their own direction */
    const alongStep = dl.offset.x * scale;
    for (let k = -half; k <= half; k++) {
      const d = d0 + k * across;
      const px = cx + acrossX * d, py = cy + acrossY * d;
      const shift = alongStep * k;
      const seg: Seg = {
        a: { x: px - ux * span + ux * shift, y: py - uy * span + uy * shift },
        b: { x: px + ux * span + ux * shift, y: py + uy * span + uy * shift }
      };
      for (const piece of clipToLoops(seg, loops)) {
        for (const dash of applyDashes(piece, dl.dashes, scale)) {
          out.push({
            type: 'line', layer: hatch.layer, color: hatch.color,
            start: { x: dash.a.x, y: dash.a.y, z: 0 },
            end: { x: dash.b.x, y: dash.b.y, z: 0 }
          });
        }
      }
    }
  }
  return out;
};
