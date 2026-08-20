/* nasjidwg — PDF export.
 *
 * Renders model space to a standalone, single-page PDF 1.4 file: real
 * vector paths (not a raster), one content stream, no external
 * dependencies. Every entity family the drawing can hold is flattened to
 * paths — nested INSERTs, hatch fills and boundaries, splines, dimension
 * graphics, meshes, image frames — so the page shows what the drawing
 * shows.
 *
 * Text is drawn with the standard Helvetica, which covers WinAnsi. A
 * string outside that repertoire (Arabic, CJK) needs an embedded font,
 * which a self-contained writer cannot invent: those entities are named
 * in the returned `skipped` list rather than silently dropped, and the
 * SVG export renders them in full.
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

export interface PdfOptions {
  /** Page width in points (1/72"). Height follows the drawing's aspect. */
  width?: number;
  /** Page height in points. Given, the page is that sheet and the drawing
   *  is placed inside it — fitted, or at `scale` when one is given. */
  height?: number;
  /** Margin in points around the drawing. */
  margin?: number;
  /** Points per drawing unit. Given, the drawing plots at that scale
   *  instead of being fitted (1:100 of a millimetre drawing is
   *  72 / 25.4 / 100). */
  scale?: number;
  /** Extra offset in points, applied after placement. */
  offset?: { x: number; y: number };
  /** Centre the drawing on the page. Default: true when `height` is set. */
  center?: boolean;
  /** Plot only this rectangle of the drawing (drawing units); anything
   *  outside is clipped away, the way a window plot does. */
  clip?: { min: Point2; max: Point2 };
  /** Every stroke black whatever the entity's colour (monochrome.ctb). */
  monochrome?: boolean;
  /** Colour for ByLayer/ByBlock entities, as 0xrrggbb. */
  stroke?: number;
  /** Line width in points. */
  lineWidth?: number;
  /** Paint a background rectangle in this colour (0xrrggbb). */
  background?: number;
}

export interface PdfResult {
  /** The finished file. */
  data: Uint8Array;
  /** Entities the page could not represent, with the reason. */
  skipped: { type: string; reason: string }[];
}

const TAU = Math.PI * 2;

/** WinAnsi is what the standard fonts cover; anything else needs a font. */
const winAnsi = (s: string): string | null => {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a || c === 0x0d) { out += ' '; continue; }
    if (c >= 0x20 && c <= 0x7e) {
      out += ch === '(' || ch === ')' || ch === '\\' ? '\\' + ch : ch;
      continue;
    }
    if (c >= 0xa0 && c <= 0xff) {
      out += '\\' + c.toString(8).padStart(3, '0');
      continue;
    }
    return null;
  }
  return out;
};

export const writePdf = (drawing: Drawing, opts: PdfOptions = {}): PdfResult => {
  const pageW = opts.width ?? 842;        /* A4 landscape by default */
  const margin = opts.margin ?? 24;
  const fallback = opts.stroke ?? 0x111111;
  const skipped: { type: string; reason: string }[] = [];

  /* contentBounds, not the raw extents: a georeferenced drawing keeps
     stray geometry megaunits from its content, and fitting to that
     printed the real drawing as a speck in the corner. */
  const bounds = opts.clip ?? contentBounds(drawing)
    ?? { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
  const spanX = Math.max(bounds.max.x - bounds.min.x, 1e-9);
  const spanY = Math.max(bounds.max.y - bounds.min.y, 1e-9);
  const usableW = Math.max(pageW - 2 * margin, 1);
  /* Sheet first, then placement. Without a height the page is cut to the
     drawing (the quick-look default); with one it is a real sheet and the
     drawing is fitted into it, or plotted at the scale asked for. */
  const usableH = opts.height != null
    ? Math.max(opts.height - 2 * margin, 1) : Infinity;
  const scale = opts.scale && opts.scale > 0
    ? opts.scale
    : Math.min(usableW / spanX, usableH / spanY);
  const pageH = opts.height ?? Math.round(spanY * scale + 2 * margin);
  const center = opts.center ?? (opts.height != null);
  const originX = center
    ? (pageW - spanX * scale) / 2 : margin;
  const originY = center
    ? (pageH - spanY * scale) / 2 : margin;
  const offX = (opts.offset?.x ?? 0) + originX;
  const offY = (opts.offset?.y ?? 0) + originY;
  /* drawing units -> page points, y already runs upward in PDF */
  const X = (x: number): number => (x - bounds.min.x) * scale + offX;
  const Y = (y: number): number => (y - bounds.min.y) * scale + offY;

  const layerColor = new Map<string, number>();
  for (const ly of drawing.layers) {
    layerColor.set(ly.name, colorToRgb(ly.color, fallback));
  }
  const colorOf = (e: Entity): number => {
    if (opts.monochrome) return 0x000000;
    const c: Color = e.color;
    if (c.kind === 'rgb') return c.rgb;
    if (c.kind === 'aci') return colorToRgb(c, fallback);
    return layerColor.get(e.layer) ?? fallback;
  };

  const body: string[] = [];
  const N = (n: number): string => {
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? '0' : String(r);
  };
  let currentRgb = -1;
  const useColor = (rgb: number): void => {
    if (rgb === currentRgb) return;
    currentRgb = rgb;
    const f = (v: number): string => N(v / 255);
    body.push(`${f((rgb >> 16) & 0xff)} ${f((rgb >> 8) & 0xff)} ${f(rgb & 0xff)} RG`);
  };

  const moveTo = (p: Point2): void => { body.push(`${N(X(p.x))} ${N(Y(p.y))} m`); };
  const lineTo = (p: Point2): void => { body.push(`${N(X(p.x))} ${N(Y(p.y))} l`); };

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

  /** Stroke through `draw` with the entity's dash pattern set (in page
   *  points, so the printed dashes match the drawing's units), then
   *  reset to solid so nothing downstream inherits the dashes. */
  const withDash = (e: Entity, draw: () => void): void => {
    const segs = dashPattern(e);
    if (segs) body.push(`[${segs.map((s) => N(s * scale)).join(' ')}] 0 d`);
    draw();
    if (segs) body.push('[] 0 d');
  };

  const strokePoly = (pts: readonly Point2[], close: boolean): void => {
    if (pts.length < 2) return;
    moveTo(pts[0]);
    for (let i = 1; i < pts.length; i++) lineTo(pts[i]);
    body.push(close ? 'h S' : 'S');
  };

  /** Arcs become cubic segments; a quarter turn per segment is exact
   *  enough that the curve is indistinguishable at any print size. */
  const strokeArc = (
    cx: number, cy: number, rx: number, ry: number,
    from: number, to: number, tilt = 0
  ): void => {
    let sweep = to - from;
    while (sweep <= 0) sweep += TAU;
    const steps = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
    const delta = sweep / steps;
    const k = (4 / 3) * Math.tan(delta / 4);
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    const at = (a: number): Point2 => {
      const px = rx * Math.cos(a), py = ry * Math.sin(a);
      return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos };
    };
    const tangent = (a: number): Point2 => {
      const px = -rx * Math.sin(a), py = ry * Math.cos(a);
      return { x: px * cos - py * sin, y: px * sin + py * cos };
    };
    let a = from;
    moveTo(at(a));
    for (let i = 0; i < steps; i++) {
      const b = a + delta;
      const p0 = at(a), p1 = at(b);
      const t0 = tangent(a), t1 = tangent(b);
      const c1 = { x: p0.x + k * t0.x, y: p0.y + k * t0.y };
      const c2 = { x: p1.x - k * t1.x, y: p1.y - k * t1.y };
      body.push(`${N(X(c1.x))} ${N(Y(c1.y))} ${N(X(c2.x))} ${N(Y(c2.y))}` +
        ` ${N(X(p1.x))} ${N(Y(p1.y))} c`);
      a = b;
    }
    body.push('S');
  };

  const fillPoly = (pts: readonly Point2[]): void => {
    if (pts.length < 3) return;
    moveTo(pts[0]);
    for (let i = 1; i < pts.length; i++) lineTo(pts[i]);
    body.push('h f');
  };

  const textAt = (
    p: Point2, text: string, height: number, rotation: number
  ): boolean => {
    const enc = winAnsi(text);
    if (enc === null) return false;
    const size = Math.max(height * scale, 0.01);
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    body.push('BT', `/F1 ${N(size)} Tf`,
      `${N(cos)} ${N(sin)} ${N(-sin)} ${N(cos)} ${N(X(p.x))} ${N(Y(p.y))} Tm`,
      `(${enc}) Tj`, 'ET');
    return true;
  };

  const emit = (raw: Entity, depth = 0): void => {
    const e = raw.extrusion ? toWcs(raw) : raw;
    if (depth > 8) return;
    useColor(colorOf(e));
    switch (e.type) {
      case 'line':
        withDash(e, () => strokePoly([e.start, e.end], false));
        return;
      case 'point':
        /* a visible tick, sized from the page so it never vanishes */
        strokePoly([
          { x: e.position.x - spanX / 400, y: e.position.y },
          { x: e.position.x + spanX / 400, y: e.position.y }
        ], false);
        return;
      case 'circle':
        withDash(e, () => strokeArc(e.center.x, e.center.y, e.radius, e.radius, 0, TAU));
        return;
      case 'arc': {
        /* equal angles are a zero-length arc, not a whole circle: plotting
           the circle put rings on the page AutoCAD never draws — an
           arc-fit leftover keeps the two angles bit-identical */
        const sweep = arcSweep(e.startAngle, e.endAngle);
        if (!sweep) return;
        withDash(e, () => strokeArc(e.center.x, e.center.y, e.radius, e.radius,
          e.startAngle, e.startAngle + sweep));
        return;
      }
      case 'ellipse': {
        const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
        const tilt = Math.atan2(e.majorAxis.y, e.majorAxis.x);
        withDash(e, () => strokeArc(e.center.x, e.center.y, rx, rx * e.ratio,
          e.startParam, e.endParam, tilt));
        return;
      }
      case 'polyline':
        withDash(e, () => strokePoly(flattenPolyline(e.vertices, e.closed), e.closed));
        return;
      case 'spline': {
        const pts = e.fitPoints?.length ? e.fitPoints : e.controlPoints;
        withDash(e, () => strokePoly(pts, e.closed));
        return;
      }
      case 'ray':
      case 'xline': {
        const len = Math.max(spanX, spanY) * 2;
        const d = Math.hypot(e.direction.x, e.direction.y) || 1;
        const ux = e.direction.x / d, uy = e.direction.y / d;
        const a = e.type === 'xline'
          ? { x: e.basePoint.x - ux * len, y: e.basePoint.y - uy * len }
          : e.basePoint;
        strokePoly([a, { x: e.basePoint.x + ux * len, y: e.basePoint.y + uy * len }],
          false);
        return;
      }
      case 'solid':
        fillPoly([e.corners[0], e.corners[1], e.corners[3], e.corners[2]]);
        return;
      case 'face3d':
        strokePoly([...e.corners, e.corners[0]], false);
        return;
      case 'mtext': {
        /* real paragraph layout first: \P breaks, word wrap to the
           reference width, attachment anchoring, Arabic shaped before
           the wrap so joined forms survive the line breaks */
        const layout = layoutMtext(e, drawing.textStyles);
        const joined = layout.lines.map((l) => l.text).join('\n');
        /* a registered SHX font turns the laid-out lines into real vector
           strokes — which also covers Arabic/CJK the standard fonts
           cannot encode */
        const shx = shxTextStrokes(
          joined === e.text ? e : { ...e, text: joined }, drawing.textStyles);
        if (shx) {
          for (const runPts of shx) strokePoly(runPts, false);
          return;
        }
        if (layout.lines.some((l) => winAnsi(l.text) === null)) {
          /* all or nothing, never a half-rendered paragraph */
          skipped.push({
            type: e.type,
            reason: 'text outside the standard font repertoire'
          });
          return;
        }
        const rot = e.rotation ?? 0;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        for (const ln of layout.lines) {
          /* the line's local offset — alignment left/right, baseline drop
             down — rotates with the block about the insertion point */
          const ax = layout.align === 'center' ? -ln.width / 2
            : layout.align === 'right' ? -ln.width : 0;
          textAt({
            x: e.position.x + ax * cos + ln.dy * sin,
            y: e.position.y + ax * sin - ln.dy * cos
          }, ln.text, layout.height, rot);
        }
        return;
      }
      case 'text': {
        /* a registered SHX font turns the text into real vector strokes —
           which also covers Arabic/CJK the standard fonts cannot encode */
        const shx = shxTextStrokes(e, drawing.textStyles);
        if (shx) {
          for (const runPts of shx) strokePoly(runPts, false);
          return;
        }
        if (!textAt(e.position, e.text, e.height, e.rotation)) {
          skipped.push({
            type: e.type,
            reason: 'text outside the standard font repertoire'
          });
        }
        return;
      }
      case 'insert': {
        const def = drawing.blocks[e.blockName];
        if (!def) return;
        const base = def.basePoint ?? { x: 0, y: 0, z: 0 };
        const m: Transform2 = compose(
          insertTransform(e.position, e.scale, e.rotation),
          translation(-base.x, -base.y));
        const cols = Math.max(1, e.columnCount ?? 1);
        const rows = Math.max(1, e.rowCount ?? 1);
        for (let c = 0; c < cols; c++) {
          for (let rIdx = 0; rIdx < rows; rIdx++) {
            const step = translation(
              c * (e.columnSpacing ?? 0), rIdx * (e.rowSpacing ?? 0));
            const full = compose(step, m);
            for (const child of def.entities) {
              emit(transformEntity(child, full), depth + 1);
            }
          }
        }
        for (const a of e.attributes ?? []) emit(a, depth + 1);
        return;
      }
      case 'hatch':
        for (const loop of e.loops) {
          if (loop.kind === 'circle') {
            strokeArc(loop.center.x, loop.center.y, loop.radius, loop.radius,
              0, TAU);
            continue;
          }
          if (loop.kind === 'ellipse') {
            const rx = Math.hypot(loop.majorAxis.x, loop.majorAxis.y);
            strokeArc(loop.center.x, loop.center.y, rx, rx * loop.ratio,
              0, TAU, Math.atan2(loop.majorAxis.y, loop.majorAxis.x));
            continue;
          }
          const pts = loop.kind === 'polyline'
            ? flattenPolyline(loop.vertices, loop.closed)
            : loop.edges.flatMap((edge) => edge.kind === 'line'
              ? [edge.start, edge.end]
              : edge.kind === 'arc'
                ? [{
                  x: edge.center.x + edge.radius * Math.cos(edge.startAngle),
                  y: edge.center.y + edge.radius * Math.sin(edge.startAngle)
                }, {
                  x: edge.center.x + edge.radius * Math.cos(edge.endAngle),
                  y: edge.center.y + edge.radius * Math.sin(edge.endAngle)
                }]
                : []);
          if (e.solid) fillPoly(pts); else strokePoly(pts, true);
        }
        return;
      case 'dimension':
        if (e.blockName && drawing.blocks[e.blockName]) {
          for (const child of drawing.blocks[e.blockName].entities) {
            emit(child, depth + 1);
          }
        } else {
          /* no stored block: draw the generated form */
          const styleRec = drawing.dimStyles?.find((s) => s.name === e.style);
          for (const child of explodeDimension(e, styleRec, drawing.header.vars)) {
            emit(child, depth + 1);
          }
        }
        return;
      case 'leader':
        strokePoly(e.vertices, false);
        return;
      case 'mline':
        strokePoly(e.vertices.map((v) => v.position), !!e.closed);
        return;
      case 'mesh':
        if (e.meshKind !== 'grid' && e.faces?.length) {
          for (const f of e.faces) {
            const pts = f.map((i) => e.vertices[Math.abs(i) - 1]).filter(Boolean);
            strokePoly(pts, true);
          }
        } else if (e.mSize && e.nSize) {
          for (let i = 0; i < e.mSize; i++) {
            strokePoly(e.vertices.slice(i * e.nSize, (i + 1) * e.nSize), false);
          }
          for (let j = 0; j < e.nSize; j++) {
            const col: Point2[] = [];
            for (let i = 0; i < e.mSize; i++) {
              const p = e.vertices[i * e.nSize + j];
              if (p) col.push(p);
            }
            strokePoly(col, false);
          }
        }
        return;
      case 'image':
      case 'ole': {
        /* the payload cannot be re-encoded here; its frame keeps the place */
        const corners = e.type === 'ole' ? e.corners : [
          e.position,
          { x: e.position.x + e.uVector.x * e.widthPx, y: e.position.y + e.uVector.y * e.widthPx },
          {
            x: e.position.x + e.uVector.x * e.widthPx + e.vVector.x * e.heightPx,
            y: e.position.y + e.uVector.y * e.widthPx + e.vVector.y * e.heightPx
          },
          { x: e.position.x + e.vVector.x * e.heightPx, y: e.position.y + e.vVector.y * e.heightPx }
        ];
        strokePoly([...corners, corners[0]], false);
        skipped.push({
          type: e.type, reason: 'raster or embedded payload drawn as its frame'
        });
        return;
      }
      case 'table': {
        const xs = [e.position.x];
        for (const w of e.columnWidths) xs.push(xs[xs.length - 1] + w);
        const ys = [e.position.y];
        for (const h of e.rowHeights) ys.push(ys[ys.length - 1] - h);
        for (const gx of xs) {
          strokePoly([{ x: gx, y: ys[0] }, { x: gx, y: ys[ys.length - 1] }], false);
        }
        for (const gy of ys) {
          strokePoly([{ x: xs[0], y: gy }, { x: xs[xs.length - 1], y: gy }], false);
        }
        for (let rIdx = 0; rIdx < e.numRows; rIdx++) {
          for (let cIdx = 0; cIdx < e.numColumns; cIdx++) {
            const cell = e.cells[rIdx * e.numColumns + cIdx];
            if (!cell?.text) continue;
            const h = Math.abs(ys[rIdx + 1] - ys[rIdx]) * 0.6;
            textAt({ x: xs[cIdx] + h * 0.2, y: ys[rIdx + 1] + h * 0.3 },
              cell.text, h, 0);
          }
        }
        return;
      }
      case 'mleader':
        for (const l of e.leaders) for (const run of l.lines) strokePoly(run, false);
        if (e.text && e.textPosition) {
          textAt(e.textPosition, e.text, e.textHeight ?? spanY / 60, 0);
        }
        return;
      case 'pointcloud': {
        const a = e.extentsMin, c2 = e.extentsMax;
        strokePoly([a, { x: c2.x, y: a.y }, c2, { x: a.x, y: c2.y }, a], false);
        skipped.push({
          type: 'pointcloud', reason: 'external scan drawn as its extents'
        });
        return;
      }
      case 'shape':
      case 'tolerance':
      case 'light':
      case 'viewport':
        return;                           /* no drawable outline of its own */
      case 'acis':
        skipped.push({ type: 'acis', reason: 'solid model has no 2D outline' });
        return;
      case 'proxy':
        for (const g of e.graphics) emit(g, depth + 1);
        return;
      case 'unknown':
        for (const g of e.graphics ?? []) emit(g, depth + 1);
        return;
    }
  };

  body.push(`${N(opts.lineWidth ?? 0.5)} w`, '1 J', '1 j');
  /* construction lines and rays reach past the drawing on purpose, so the
     page is the clip — or the plotted window, when one was asked for */
  if (opts.clip) {
    const x0 = X(bounds.min.x), y0 = Y(bounds.min.y);
    body.push(`${N(x0)} ${N(y0)} ${N(X(bounds.max.x) - x0)} ${N(Y(bounds.max.y) - y0)} re W n`);
  } else {
    body.push(`0 0 ${N(pageW)} ${N(pageH)} re W n`);
  }
  if (opts.background !== undefined) {
    const bg = opts.background;
    const f = (v: number): string => N(v / 255);
    body.push(`${f((bg >> 16) & 0xff)} ${f((bg >> 8) & 0xff)} ${f(bg & 0xff)} rg`);
    body.push(`0 0 ${N(pageW)} ${N(pageH)} re f`);
    body.push('0 0 0 rg');
  }
  for (const e of drawing.entities) {
    try { emit(e); } catch {
      skipped.push({ type: e.type, reason: 'entity could not be drawn' });
    }
  }

  /* ---- assemble the file ---- */
  const content = body.join('\n') + '\n';
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${N(pageW)} ${N(pageH)}]` +
      ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica' +
      ' /Encoding /WinAnsiEncoding >>'
  ];

  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;

  const data = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) data[i] = pdf.charCodeAt(i) & 0xff;
  return { data, skipped };
};
