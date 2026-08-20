/* nasjidwg — SVG export.
 *
 * Renders model space to a standalone SVG. Covers the full model: MTEXT and TEXT (with logical Arabic left intact —
 * browsers shape it correctly), HATCH solid fills and boundary outlines,
 * SPLINE curves, DIMENSION graphics blocks, meshes, images (placeholder
 * boxes) and nested INSERTs with full transforms.
 */

import type { Color, Drawing, Entity, Point2 } from '../core/model.js';
import { colorToRgb } from '../core/color.js';
import { explodeDimension } from '../core/dim.js';
import { shxTextStrokes } from '../text/shx.js';
import { layoutMtext } from '../text/layout.js';
import {
  arcSweep, contentBounds, flattenPolyline, insertTransform, compose,
  translation, transformEntity, toWcs, type Transform2
} from '../core/geo.js';

export interface SvgOptions {
  /** Output width in px (height follows the drawing's aspect). */
  width?: number;
  background?: string;
  /** Default stroke for ByLayer/ByBlock entities, as #rrggbb. */
  stroke?: string;
  strokeWidth?: number;
}

const esc = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* RTL detection for laid-out MTEXT rows: logical Arabic/Hebrew plus the
 * presentation forms the layout's shaping step produces. */
const RTL_ROW = /[֐-ࣿﭐ-﷿ﹰ-ﻼ]/;

const TAU = Math.PI * 2;

export const writeSvg = (drawing: Drawing, opts: SvgOptions = {}): string => {
  const width = opts.width ?? 1000;
  const bg = opts.background ?? 'none';
  const fallback = opts.stroke ?? '#111111';
  /* the drawing's mass, not its raw extents — a stray entity far from
     the content would otherwise shrink the picture to a speck */
  const bounds = contentBounds(drawing) ?? { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
  const spanX = Math.max(bounds.max.x - bounds.min.x, 1e-9);
  const spanY = Math.max(bounds.max.y - bounds.min.y, 1e-9);
  const margin = 0.02 * Math.max(spanX, spanY);
  const vb = {
    x: bounds.min.x - margin, y: -(bounds.max.y + margin),
    w: spanX + 2 * margin, h: spanY + 2 * margin
  };
  const height = Math.round(width * (vb.h / vb.w));
  const sw = opts.strokeWidth ?? vb.w / width * 1.4;

  const layerColor = new Map<string, number>();
  for (const ly of drawing.layers) layerColor.set(ly.name, colorToRgb(ly.color, 0x111111));

  const colorOf = (e: Entity): string => {
    const c: Color = e.color;
    if (c.kind === 'rgb') return '#' + c.rgb.toString(16).padStart(6, '0');
    if (c.kind === 'aci') return '#' + colorToRgb(c, 0x111111).toString(16).padStart(6, '0');
    const lc = layerColor.get(e.layer);
    return lc !== undefined ? '#' + lc.toString(16).padStart(6, '0') : fallback;
  };

  /* Named linetypes render as dashes. ByLayer resolves through the
     entity's layer; ByBlock and anything unresolvable stays solid, as
     does an empty (CONTINUOUS) pattern. */
  const ltScale = drawing.header.linetypeScale ?? 1;
  const linetypePattern = new Map<string, number[]>();
  for (const lt of drawing.linetypes) {
    linetypePattern.set(lt.name.toLowerCase(), lt.pattern);
  }
  const layerLinetype = new Map<string, string>();
  for (const ly of drawing.layers) {
    if (ly.linetype) layerLinetype.set(ly.name, ly.linetype);
  }

  /** Absolute dash/gap run lengths for an entity in drawing units —
   *  dash from a positive element, gap from a negative one, a dot (0)
   *  as a short 0.1-unit dash — or null when the line is solid. */
  const dashPattern = (e: Entity): number[] | null => {
    let name = e.linetype;
    if (!name || /^bylayer$/i.test(name)) name = layerLinetype.get(e.layer);
    if (!name || /^byblock$/i.test(name)) return null;
    const pattern = linetypePattern.get(name.toLowerCase());
    if (!pattern?.length) return null;
    const k = ltScale * (e.linetypeScale ?? 1);
    const segs = pattern.map((v) => (v > 0 ? v : v < 0 ? -v : 0.1) * k);
    return segs.some((s) => s > 0) ? segs : null;
  };

  const out: string[] = [];
  const P = (n: number): string => {
    const r = Math.round(n * 1e6) / 1e6;
    return Object.is(r, -0) ? '0' : String(r);
  };
  /* Y axis flips: CAD is y-up, SVG y-down — emit -y everywhere. */
  const XY = (p: Point2): string => P(p.x) + ',' + P(-p.y);

  const polyPath = (pts: Point2[], close: boolean): string =>
    'M' + pts.map(XY).join(' L') + (close ? ' Z' : '');

  /** The stroke-dasharray attribute for a dashed entity, '' when solid. */
  const dashAttr = (e: Entity): string => {
    const segs = dashPattern(e);
    return segs ? ` stroke-dasharray="${segs.map(P).join(' ')}"` : '';
  };

  const sampleSpline = (
    ctrl: Point2[], degree: number, knots: number[], samples: number
  ): Point2[] => {
    const n = ctrl.length;
    const p = Math.max(1, Math.min(degree || 3, n - 1));
    let U = knots.length === n + p + 1 ? knots.slice() : null;
    if (!U) {
      U = [];
      for (let i = 0; i < n + p + 1; i++) U.push(i <= p ? 0 : (i >= n ? n - p : i - p));
    }
    const u0 = U[p], u1 = U[n];
    const outPts: Point2[] = [];
    for (let s = 0; s <= samples; s++) {
      const u = u0 + (u1 - u0) * (s / samples);
      let k = p;
      for (let i = p; i < n; i++) {
        if (u >= U[i] && u <= U[i + 1] && U[i + 1] > U[i]) { k = i; break; }
      }
      if (u >= U[n]) k = n - 1;
      const d: Point2[] = [];
      for (let j = 0; j <= p; j++) {
        const c = ctrl[Math.min(n - 1, Math.max(0, j + k - p))];
        d.push({ x: c.x, y: c.y });
      }
      for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
          const i = j + k - p;
          const den = U[i + p - r + 1] - U[i];
          const a = den > 0 ? (u - U[i]) / den : 0;
          d[j] = {
            x: (1 - a) * d[j - 1].x + a * d[j].x,
            y: (1 - a) * d[j - 1].y + a * d[j].y
          };
        }
      }
      outPts.push(d[p]);
    }
    return outPts;
  };

  const arcPoints = (
    cx: number, cy: number, r: number, a0: number, a1: number
  ): Point2[] => {
    let sweep = (a1 - a0) % TAU;
    if (sweep <= 0) sweep += TAU;
    const n = Math.max(4, Math.ceil(sweep / (Math.PI / 32)));
    const pts: Point2[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + sweep * (i / n);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
  };

  const emit = (raw: Entity, stroke: string): void => {
    /* an entity in its own plane is mapped to world coordinates first */
    const e = raw.extrusion ? toWcs(raw) : raw;
    switch (e.type) {
      case 'line':
        out.push(`<path d="M${XY(e.start)} L${XY(e.end)}" stroke="${stroke}"${dashAttr(e)}/>`);
        return;
      case 'point':
        out.push(`<circle cx="${P(e.position.x)}" cy="${P(-e.position.y)}" r="${P(sw * 1.5)}" fill="${stroke}" stroke="none"/>`);
        return;
      case 'circle':
        out.push(`<circle cx="${P(e.center.x)}" cy="${P(-e.center.y)}" r="${P(e.radius)}" stroke="${stroke}"${dashAttr(e)}/>`);
        return;
      case 'arc': {
        /* equal angles are a zero-length arc, not a whole circle: drawing
           the circle put rings in the picture AutoCAD never shows — an
           arc-fit leftover keeps the two angles bit-identical */
        const sweep = arcSweep(e.startAngle, e.endAngle);
        if (!sweep) return;
        out.push(`<path d="${polyPath(arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.startAngle + sweep), false)}" stroke="${stroke}"${dashAttr(e)}/>`);
        return;
      }
      case 'ellipse': {
        const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
        const ry = rx * e.ratio;
        const co = rx ? e.majorAxis.x / rx : 1, si = rx ? e.majorAxis.y / rx : 0;
        let sweep = (e.endParam - e.startParam) % TAU;
        if (sweep <= 0) sweep += TAU;
        const n = Math.max(8, Math.ceil(sweep / (Math.PI / 32)));
        const pts: Point2[] = [];
        for (let i = 0; i <= n; i++) {
          const t = e.startParam + sweep * (i / n);
          const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
          pts.push({ x: e.center.x + ex * co - ey * si, y: e.center.y + ex * si + ey * co });
        }
        out.push(`<path d="${polyPath(pts, Math.abs(sweep - TAU) < 1e-9)}" stroke="${stroke}"${dashAttr(e)}/>`);
        return;
      }
      case 'polyline': {
        const pts = flattenPolyline(e.vertices, e.closed);
        if (pts.length > 1) {
          out.push(`<path d="${polyPath(pts, e.closed)}" stroke="${stroke}"${dashAttr(e)}/>`);
        }
        return;
      }
      case 'spline': {
        const src = e.controlPoints.length >= 2 ? e.controlPoints : (e.fitPoints ?? []);
        if (src.length < 2) return;
        const pts = e.controlPoints.length >= 2
          ? sampleSpline(src, e.degree, e.knots, Math.min(128, src.length * 8))
          : src;
        out.push(`<path d="${polyPath(pts, false)}" stroke="${stroke}"${dashAttr(e)}/>`);
        return;
      }
      case 'mtext': {
        /* real paragraph layout first: \P breaks, word wrap to the
           reference width, attachment anchoring, Arabic shaped before
           the wrap so joined forms survive the line breaks */
        const layout = layoutMtext(e, drawing.textStyles);
        const joined = layout.lines.map((l) => l.text).join('\n');
        /* a registered SHX font renders the laid-out lines as the vector
           strokes a CAD plot would show */
        const shx = shxTextStrokes(
          joined === e.text ? e : { ...e, text: joined }, drawing.textStyles);
        if (shx) {
          const d = shx.map((run) => polyPath(run, false)).join(' ');
          if (d) out.push(`<path d="${d}" stroke="${stroke}"/>`);
          return;
        }
        const h = layout.height;
        const rot = (e.rotation || 0) * 180 / Math.PI;
        const anchor = layout.align === 'center' ? 'middle'
          : layout.align === 'right' ? 'end' : 'start';
        const tx = P(e.position.x), ty = P(-e.position.y);
        const tf = rot ? ` transform="rotate(${P(-rot)} ${tx} ${ty})"` : '';
        for (const ln of layout.lines) {
          out.push(
            `<text x="${tx}" y="${P(-e.position.y + ln.dy)}" font-size="${P(h)}"` +
            ` fill="${stroke}" stroke="none" text-anchor="${anchor}"` +
            ` font-family="sans-serif" direction="${RTL_ROW.test(ln.text) ? 'rtl' : 'ltr'}"${tf}>${esc(ln.text)}</text>`);
        }
        return;
      }
      case 'text': {
        /* a registered SHX font renders the text as the vector strokes a
           CAD plot would show; anything else keeps the <text> fallback */
        const shx = shxTextStrokes(e, drawing.textStyles);
        if (shx) {
          const d = shx.map((run) => polyPath(run, false)).join(' ');
          if (d) out.push(`<path d="${d}" stroke="${stroke}"/>`);
          return;
        }
        const h = e.height > 0 ? e.height : 5;
        const rot = (e.rotation || 0) * 180 / Math.PI;
        const anchor = e.halign === 'center' || e.halign === 'middle' ? 'middle'
          : e.halign === 'right' ? 'end' : 'start';
        const lines = e.text.split('\n');
        const tx = P(e.position.x), ty = P(-e.position.y);
        const tf = rot ? ` transform="rotate(${P(-rot)} ${tx} ${ty})"` : '';
        lines.forEach((ln, i) => {
          out.push(
            `<text x="${tx}" y="${P(-e.position.y + i * h * 1.25)}" font-size="${P(h)}"` +
            ` fill="${stroke}" stroke="none" text-anchor="${anchor}"` +
            ` font-family="sans-serif" direction="${/[֐-ࣿ]/.test(ln) ? 'rtl' : 'ltr'}"${tf}>${esc(ln)}</text>`);
        });
        return;
      }
      case 'insert': {
        const def = drawing.blocks[e.blockName];
        if (!def) return;
        const base = def.basePoint ?? { x: 0, y: 0, z: 0 };
        const m = compose(
          insertTransform(e.position, e.scale, e.rotation),
          translation(-base.x, -base.y));
        for (const child of def.entities) emitTransformed(child, m, stroke);
        for (const a of e.attributes ?? []) emit(a, stroke);
        return;
      }
      case 'hatch': {
        const d: string[] = [];
        for (const loop of e.loops) {
          if (loop.kind === 'circle') {
            d.push(polyPath(arcPoints(loop.center.x, loop.center.y, loop.radius, 0, TAU - 1e-9), true));
          } else if (loop.kind === 'polyline') {
            const pts = flattenPolyline(loop.vertices, true);
            if (pts.length > 2) d.push(polyPath(pts, true));
          } else {
            /* ellipse + edge loops flatten through the geo helpers via a
               temporary polyline boundary */
            const tmp: Entity = { ...e, loops: [loop] };
            const bpts = flattenBoundary(tmp);
            if (bpts.length > 2) d.push(polyPath(bpts, true));
          }
        }
        if (!d.length) return;
        if (e.solid || e.gradient) {
          out.push(`<path d="${d.join(' ')}" fill="${stroke}" fill-rule="evenodd" stroke="none" fill-opacity="0.85"/>`);
        } else {
          out.push(`<path d="${d.join(' ')}" fill="${stroke}" fill-rule="evenodd" stroke="${stroke}" fill-opacity="0.12"/>`);
        }
        return;
      }
      case 'solid':
      case 'face3d': {
        /* SOLID corner order is 1,2,4,3 */
        const c = e.corners;
        const seq = e.type === 'solid' ? [c[0], c[1], c[3], c[2]] : c;
        out.push(`<path d="${polyPath(seq.map((p) => ({ x: p.x, y: p.y })), true)}" ` +
          (e.type === 'solid' ? `fill="${stroke}" stroke="none"/>` : `fill="none" stroke="${stroke}"/>`));
        return;
      }
      case 'leader':
        if (e.vertices.length > 1) {
          out.push(`<path d="${polyPath(e.vertices, false)}" stroke="${stroke}"/>`);
        }
        return;
      case 'mline': {
        const pts = e.vertices.map((v) => v.position);
        if (pts.length > 1) {
          out.push(`<path d="${polyPath(pts, !!e.closed)}" stroke="${stroke}"/>`);
        }
        return;
      }
      case 'mesh': {
        if (e.meshKind !== 'grid' && e.faces?.length) {
          for (const f of e.faces) {
            const pts = f
              .map((i) => e.vertices[Math.abs(i) - 1])
              .filter(Boolean);
            if (pts.length > 1) out.push(`<path d="${polyPath(pts, true)}" stroke="${stroke}"/>`);
          }
        } else if (e.mSize && e.nSize) {
          for (let i = 0; i < e.mSize; i++) {
            const row = e.vertices.slice(i * e.nSize, (i + 1) * e.nSize);
            if (row.length > 1) out.push(`<path d="${polyPath(row, !!e.closedN)}" stroke="${stroke}"/>`);
          }
          for (let j = 0; j < e.nSize; j++) {
            const col: Point2[] = [];
            for (let i = 0; i < e.mSize; i++) {
              const v = e.vertices[i * e.nSize + j];
              if (v) col.push(v);
            }
            if (col.length > 1) out.push(`<path d="${polyPath(col, !!e.closedM)}" stroke="${stroke}"/>`);
          }
        }
        return;
      }
      case 'dimension': {
        const def = e.blockName ? drawing.blocks[e.blockName] : undefined;
        if (def?.entities.length) {
          for (const child of def.entities) emit(child, stroke);
        } else {
          /* no stored block: draw the generated form */
          const styleRec = drawing.dimStyles?.find((s) => s.name === e.style);
          for (const child of explodeDimension(e, styleRec, drawing.header.vars)) {
            emit(child, stroke);
          }
        }
        return;
      }
      case 'image': {
        const c1 = e.position;
        const c2 = {
          x: c1.x + e.uVector.x * e.widthPx + e.vVector.x * e.heightPx,
          y: c1.y + e.uVector.y * e.widthPx + e.vVector.y * e.heightPx
        };
        out.push(`<rect x="${P(Math.min(c1.x, c2.x))}" y="${P(Math.min(-c1.y, -c2.y))}" ` +
          `width="${P(Math.abs(c2.x - c1.x))}" height="${P(Math.abs(c2.y - c1.y))}" ` +
          `stroke="${stroke}" stroke-dasharray="6 3" fill="none"/>`);
        return;
      }
      case 'tolerance':
        out.push(`<text x="${P(e.position.x)}" y="${P(-e.position.y)}" font-size="${P(sw * 10)}" fill="${stroke}" stroke="none">${esc(e.text)}</text>`);
        return;
      case 'shape':
        out.push(`<circle cx="${P(e.position.x)}" cy="${P(-e.position.y)}" r="${P(e.size / 2)}" stroke="${stroke}"/>`);
        return;
      case 'ray':
      case 'xline': {
        const L = Math.max(vb.w, vb.h) * 2;
        const d = Math.hypot(e.direction.x, e.direction.y) || 1;
        const ux = e.direction.x / d, uy = e.direction.y / d;
        const a = e.type === 'xline'
          ? { x: e.basePoint.x - ux * L, y: e.basePoint.y - uy * L }
          : { x: e.basePoint.x, y: e.basePoint.y };
        const b2 = { x: e.basePoint.x + ux * L, y: e.basePoint.y + uy * L };
        out.push(`<path d="M${XY(a)} L${XY(b2)}" stroke="${stroke}" stroke-dasharray="8 4"/>`);
        return;
      }
      case 'light':
        out.push(`<circle cx="${P(e.position.x)}" cy="${P(-e.position.y)}"` +
          ` r="${P(sw * 4)}" stroke="${stroke}" fill="none"/>`);
        return;
      case 'mleader': {
        for (const leader of e.leaders) {
          for (const line of leader.lines) {
            if (line.length > 1) {
              out.push(`<path d="${polyPath(line, false)}" stroke="${stroke}"/>`);
            }
          }
        }
        if (e.text && e.textPosition) {
          emit({
            type: 'mtext', layer: e.layer, color: e.color,
            position: e.textPosition, text: e.text,
            height: e.textHeight ?? 2.5, rotation: e.textRotation ?? 0
          }, stroke);
        }
        return;
      }
      case 'table': {
        const xs: number[] = [e.position.x];
        for (const cw of e.columnWidths) xs.push(xs[xs.length - 1] + cw);
        const ys: number[] = [e.position.y];
        for (const rh of e.rowHeights) ys.push(ys[ys.length - 1] - rh);
        const yTop = ys[0], yBot = ys[ys.length - 1];
        const xLeft = xs[0], xRight = xs[xs.length - 1];
        for (const x2 of xs) {
          out.push(`<path d="M${XY({ x: x2, y: yTop })}` +
            ` L${XY({ x: x2, y: yBot })}" stroke="${stroke}"/>`);
        }
        for (const y2 of ys) {
          out.push(`<path d="M${XY({ x: xLeft, y: y2 })}` +
            ` L${XY({ x: xRight, y: y2 })}" stroke="${stroke}"/>`);
        }
        for (let rIdx = 0; rIdx < e.numRows; rIdx++) {
          for (let cIdx = 0; cIdx < e.numColumns; cIdx++) {
            const cell = e.cells[rIdx * e.numColumns + cIdx];
            if (!cell?.text) continue;
            const h = cell.textHeight && cell.textHeight > 0 ? cell.textHeight
              : Math.max(0.1, Math.abs(ys[rIdx + 1] - ys[rIdx]) * 0.6);
            emit({
              type: 'text', layer: e.layer, color: e.color,
              position: { x: xs[cIdx] + h * 0.2, y: ys[rIdx + 1] + h * 0.3, z: 0 },
              text: cell.text, height: h, rotation: 0
            }, stroke);
          }
        }
        return;
      }
      case 'ole':
        /* the embedded document cannot be rendered here, but its frame is
           part of the drawing and must occupy its place */
        out.push(`<path d="M${XY(e.corners[0])} L${XY(e.corners[1])}` +
          ` L${XY(e.corners[2])} L${XY(e.corners[3])} Z"` +
          ` fill="none" stroke="${stroke}" stroke-dasharray="4 2"/>`);
        return;
      case 'pointcloud': {
        /* the scan lives outside the drawing; its extents keep its place */
        const a = e.extentsMin, c2 = e.extentsMax;
        out.push(`<path d="M${XY(a)} L${XY({ x: c2.x, y: a.y })}` +
          ` L${XY(c2)} L${XY({ x: a.x, y: c2.y })} Z"` +
          ` fill="none" stroke="${stroke}" stroke-dasharray="4 2"/>`);
        return;
      }
      case 'proxy':
        for (const g of e.graphics) emit(g, stroke);
        return;
      case 'unknown':
        for (const g of e.graphics ?? []) emit(g, stroke);
        return;
      case 'viewport':
      case 'acis':
        return;
    }
  };

  const flattenBoundary = (h: Extract<Entity, { type: 'hatch' }>): Point2[] => {
    /* uses entityBounds' boundary walk indirectly: approximate via the
       transformed hatch itself — cheap sampling for ellipse/edge loops */
    const loop = h.loops[0];
    if (loop.kind === 'ellipse') {
      const rx = Math.hypot(loop.majorAxis.x, loop.majorAxis.y);
      const ry = rx * loop.ratio;
      const co = rx ? loop.majorAxis.x / rx : 1, si = rx ? loop.majorAxis.y / rx : 0;
      const pts: Point2[] = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU;
        const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
        pts.push({ x: loop.center.x + ex * co - ey * si, y: loop.center.y + ex * si + ey * co });
      }
      return pts;
    }
    if (loop.kind === 'edges') {
      const pts: Point2[] = [];
      for (const ed of loop.edges) {
        if (ed.kind === 'line') pts.push(ed.start, ed.end);
        else if (ed.kind === 'arc') pts.push(...arcPoints(ed.center.x, ed.center.y, ed.radius, ed.startAngle, ed.endAngle));
        else if (ed.kind === 'ellipticalArc') {
          const rx = Math.hypot(ed.majorAxis.x, ed.majorAxis.y);
          const ry = rx * ed.ratio;
          const co = rx ? ed.majorAxis.x / rx : 1, si = rx ? ed.majorAxis.y / rx : 0;
          let sweep = (ed.endAngle - ed.startAngle) % TAU;
          if (sweep <= 0) sweep += TAU;
          for (let i = 0; i <= 24; i++) {
            const a = ed.startAngle + sweep * (i / 24);
            const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
            pts.push({ x: ed.center.x + ex * co - ey * si, y: ed.center.y + ex * si + ey * co });
          }
        } else {
          pts.push(...(ed.fitPoints?.length ? ed.fitPoints : ed.controlPoints));
        }
      }
      return pts;
    }
    return [];
  };

  const emitTransformed = (e: Entity, m: Transform2, inherited: string): void => {
    const t = transformEntity(e, m);
    const stroke = t.color.kind === 'byLayer' || t.color.kind === 'byBlock'
      ? inherited : colorOf(t);
    emit(t, stroke);
  };

  for (const e of drawing.entities) emit(e, colorOf(e));

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="${P(vb.x)} ${P(vb.y)} ${P(vb.w)} ${P(vb.h)}">`,
    bg !== 'none' ? `<rect x="${P(vb.x)}" y="${P(vb.y)}" width="${P(vb.w)}" height="${P(vb.h)}" fill="${bg}"/>` : '',
    `<g fill="none" stroke-width="${P(sw)}" stroke-linecap="round" stroke-linejoin="round">`,
    ...out,
    '</g></svg>'
  ].join('\n');
};
