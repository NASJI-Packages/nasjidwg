/* nasjidwg — dimension geometry generation.
 *
 * A DIMENSION record is only a set of definition points; the drawn form
 * (dimension line, extension lines, arrowheads, measurement text) normally
 * lives in an anonymous *D block. Files authored outside AutoCAD often
 * carry no such block, so this builds the drawn form from the points —
 * used by the SVG/PDF exporters as a fallback and by the R12 writer to
 * materialize a block for viewers that never regenerate.
 */

import type {
  DimensionEntity, DimStyle, Entity, Point2, Point3
} from './model.js';

interface DimVars {
  scale: number;                          /* DIMSCALE */
  arrow: number;                          /* DIMASZ */
  textHeight: number;                     /* DIMTXT */
  extOffset: number;                      /* DIMEXO */
  extBeyond: number;                      /* DIMEXE */
  gap: number;                            /* DIMGAP */
  decimals: number;                       /* DIMDEC / LUPREC */
}

const varsOf = (
  style?: DimStyle, fallback?: Record<string, unknown>
): DimVars => {
  /* the named style first, then the drawing's current values (the header
     vars), then this library's own defaults */
  const v = { ...(fallback ?? {}), ...(style?.vars ?? {}) };
  const num = (key: string, dflt: number): number =>
    typeof v[key] === 'number' && (v[key] as number) > 0 ? v[key] as number : dflt;
  const scale = num('DIMSCALE', 1);
  return {
    scale,
    arrow: num('DIMASZ', 0.18) * scale,
    textHeight: num('DIMTXT', 0.18) * scale,
    extOffset: num('DIMEXO', 0.0625) * scale,
    extBeyond: num('DIMEXE', 0.18) * scale,
    gap: num('DIMGAP', 0.09) * scale,
    decimals: typeof v.DIMDEC === 'number' ? v.DIMDEC as number : 4
  };
};

/** The measurement's displayed text, honoring the override rules:
 *  undefined/'' shows the measurement, ' ' suppresses it, '<>' embeds it. */
const measurementText = (
  dim: DimensionEntity, measured: number, decimals: number
): string => {
  const formatted = (Math.round(measured * 10 ** decimals) / 10 ** decimals)
    .toFixed(Math.min(decimals, 8)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (dim.text === ' ') return '';
  if (dim.text === undefined || dim.text === '') return formatted;
  return dim.text.replace(/<>/g, formatted);
};

/* ------------------------------------------------------------------ */

const sub = (a: Point3, b: Point3): Point2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Point2): number => Math.hypot(v.x, v.y);
const norm = (v: Point2): Point2 => {
  const d = len(v) || 1;
  return { x: v.x / d, y: v.y / d };
};
const perp = (v: Point2): Point2 => ({ x: -v.y, y: v.x });
const at = (p: Point3 | Point2, v: Point2, t: number): Point3 =>
  ({ x: p.x + v.x * t, y: p.y + v.y * t, z: 0 });

/** Generate the drawn form of a dimension as plain entities.
 *  Returns [] when the definition points it needs are absent.
 *
 *  `headerVars` is the drawing's `header.vars`: a DWG's DIMSTYLE table
 *  carries names only, so without it every dimension would be drawn at
 *  this library's defaults instead of the file's own sizes. */
export const explodeDimension = (
  dim: DimensionEntity, style?: DimStyle, headerVars?: Record<string, unknown>
): Entity[] => {
  const dv = varsOf(style, headerVars);
  const out: Entity[] = [];
  const base = { layer: dim.layer, color: dim.color } as const;

  const line = (a: Point3, b: Point3): void => {
    out.push({ ...base, type: 'line', start: { ...a, z: a.z ?? 0 }, end: { ...b, z: b.z ?? 0 } });
  };
  /** A filled arrowhead at `tip`, pointing along `dir`. */
  const arrowAt = (tip: Point3, dir: Point2): void => {
    const back = at(tip, dir, -dv.arrow);
    const side = perp(dir);
    const w = dv.arrow / 6;
    out.push({
      ...base, type: 'solid',
      corners: [
        { ...tip, z: 0 },
        at(back, side, w), at(back, side, -w),
        at(back, side, -w)
      ]
    });
  };
  const textAt = (mid: Point3, text: string, rotation = 0): void => {
    if (!text) return;
    out.push({
      ...base, type: 'text',
      position: { x: mid.x, y: mid.y, z: 0 },
      alignmentPoint: { x: mid.x, y: mid.y, z: 0 },
      text, height: dv.textHeight, rotation,
      halign: 'center', valign: 'middle'
    });
  };

  const kind = dim.kind ?? (['linear', 'aligned', 'angular2ln', 'diameter',
    'radius', 'angular3pt', 'ordinate'] as const)[dim.dimensionType & 7];

  switch (kind) {
    case 'linear':
    case 'aligned': {
      const p13 = dim.point13, p14 = dim.point14;
      if (!p13 || !p14) return [];
      /* direction of the dimension line */
      const u = kind === 'aligned'
        ? norm(sub(p14, p13))
        : { x: Math.cos(dim.rotation ?? 0), y: Math.sin(dim.rotation ?? 0) };
      /* the dimension line passes through the definition point along u;
         each extension origin projects onto it */
      const def = dim.definitionPoint;
      const proj = (p: Point3): Point3 => {
        const d = sub(p, def);
        const t = d.x * u.x + d.y * u.y;
        return at(def, u, t);
      };
      const e1 = proj(p13), e2 = proj(p14);
      /* extension lines, offset off their origin and past the line */
      for (const [from, to] of [[p13, e1], [p14, e2]] as const) {
        const dir = norm(sub(to, from));
        if (len(sub(to, from)) > 1e-12) {
          line(at(from, dir, dv.extOffset), at(to, dir, dv.extBeyond));
        }
      }
      line(e1, e2);
      const measured = dim.measurement ?? len(sub(e2, e1));
      arrowAt(e1, norm(sub(e1, e2)));
      arrowAt(e2, norm(sub(e2, e1)));
      const mid = dim.textMidpoint
        ?? at({ x: (e1.x + e2.x) / 2, y: (e1.y + e2.y) / 2 }, perp(u), dv.gap + dv.textHeight / 2);
      const angle = Math.atan2(u.y, u.x);
      textAt(mid, measurementText(dim, measured, dv.decimals),
        Math.abs(angle) > Math.PI / 2 ? angle + Math.PI : angle);
      return out;
    }

    case 'radius':
    case 'diameter': {
      const p15 = dim.point15;
      if (!p15) return [];
      /* radius: definition point is the center, p15 sits on the curve;
         diameter: the two points straddle the circle */
      const center = kind === 'radius'
        ? dim.definitionPoint
        : {
          x: (dim.definitionPoint.x + p15.x) / 2,
          y: (dim.definitionPoint.y + p15.y) / 2, z: 0
        };
      const r = len(sub(p15, center));
      const measured = dim.measurement ?? (kind === 'radius' ? r : r * 2);
      line(center, p15);
      arrowAt(p15, norm(sub(p15, center)));
      if (kind === 'diameter') arrowAt(dim.definitionPoint, norm(sub(dim.definitionPoint, center)));
      const prefix = kind === 'radius' ? 'R' : '%%c';
      const mid = dim.textMidpoint ?? at(center, norm(sub(p15, center)), r / 2);
      textAt(mid, dim.text === undefined || dim.text === ''
        ? prefix + measurementText(dim, measured, dv.decimals)
        : measurementText(dim, measured, dv.decimals));
      return out;
    }

    case 'angular3pt':
    case 'angular2ln': {
      const p13 = dim.point13, p14 = dim.point14;
      if (!p13 || !p14) return [];
      /* the vertex: given for 3-point, the ray intersection for 2-line */
      let vertex: Point3;
      if (kind === 'angular3pt') {
        if (!dim.point15) return [];
        vertex = dim.point15;
      } else {
        if (!dim.point15 || !dim.point16) return [];
        /* first line p13->p14, second line p15->definitionPoint */
        const d1 = sub(p14, p13), d2 = sub(dim.definitionPoint, dim.point15);
        const den = d1.x * d2.y - d1.y * d2.x;
        if (Math.abs(den) < 1e-12) return [];
        const t = ((dim.point15.x - p13.x) * d2.y - (dim.point15.y - p13.y) * d2.x) / den;
        vertex = at(p13, norm(d1), t * len(d1));
      }
      const arcPoint = kind === 'angular3pt' ? dim.definitionPoint : dim.point16!;
      const r = len(sub(arcPoint, vertex)) || 1;
      let a1 = Math.atan2(p13.y - vertex.y, p13.x - vertex.x);
      let a2 = Math.atan2(p14.y - vertex.y, p14.x - vertex.x);
      const am = Math.atan2(arcPoint.y - vertex.y, arcPoint.x - vertex.x);
      /* pick the sweep that contains the arc point */
      const wrap = (a: number): number => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      if (wrap(am - a1) > wrap(a2 - a1)) [a1, a2] = [a2, a1];
      out.push({ ...base, type: 'arc', center: { ...vertex, z: 0 }, radius: r, startAngle: a1, endAngle: a2 });
      line(vertex, at(vertex, { x: Math.cos(a1), y: Math.sin(a1) }, r));
      line(vertex, at(vertex, { x: Math.cos(a2), y: Math.sin(a2) }, r));
      const measured = dim.measurement ?? wrap(a2 - a1);
      const mid = dim.textMidpoint ?? at(vertex, { x: Math.cos(am), y: Math.sin(am) }, r);
      textAt(mid, dim.text === undefined || dim.text === ''
        ? measurementText(dim, measured * 180 / Math.PI, dv.decimals) + '%%d'
        : measurementText(dim, measured * 180 / Math.PI, dv.decimals));
      return out;
    }

    case 'ordinate': {
      const p13 = dim.point13, p14 = dim.point14;
      if (!p13 || !p14) return [];
      /* a leader from the feature to the text, jogged at the midpoint */
      const xType = (dim.dimensionType & 64) !== 0;
      const midT = { x: p13.x + (p14.x - p13.x) / 2, y: p13.y + (p14.y - p13.y) / 2, z: 0 };
      const jog: Point3 = xType
        ? { x: p13.x, y: midT.y, z: 0 } : { x: midT.x, y: p13.y, z: 0 };
      line(p13, jog);
      line(jog, p14);
      const measured = dim.measurement ?? (xType ? Math.abs(p13.x) : Math.abs(p13.y));
      textAt(dim.textMidpoint ?? p14, measurementText(dim, measured, dv.decimals));
      return out;
    }

    default:
      return [];
  }
};
