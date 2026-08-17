/* nasjidwg — DWG R12 (AC1009) writer.
 *
 * The last byte-aligned release: a fixed 1725-byte header carrying 205
 * drawing variables at fixed offsets (with the UCS/VPORT/APPID/DIMSTYLE/VX
 * table directories embedded among them), fixed-size table records, flat
 * entity runs, a CRC16 (seed 0xC0C1) closing the header and every record,
 * 16-byte sentinels bracketing every section (the end sentinel is the
 * bitwise complement of the begin sentinel), and a second header at the
 * tail repeating the full section directory. All of it verified against
 * converter-produced files the reader decodes.
 *
 * Native records: line, point, circle, arc, text, solid, 3dface, shape,
 * polyline/vertex/seqend (2D, mesh, polyface), insert (with attribs),
 * dimension, viewport. Ellipse, spline, mtext, hatch, leader, mleader,
 * mline, tolerance and table go out as simpler geometry (`downgraded`);
 * what R12 cannot carry at all is skipped with a note.
 */

import { crc16 } from './bitwriter.js';
import { HEADER_TEMPLATE, VPORT_TEMPLATE, SENTINELS } from './template12.js';
import type { DwgWriteResult } from './writer.js';
import type {
  Color, DimStyle, Drawing, Entity, Layer, MeshEntity, Point2, Point3,
  SplineEntity, TextEntity
} from '../core/model.js';
import { nearestAci } from '../core/color.js';
import { explodeDimension } from '../core/dim.js';
import { drawingBounds } from '../core/geo.js';
import { explodeHatch } from '../hatch/pattern.js';
import { CP1252_HIGH, encodeCadSymbols, escapeUnicode } from '../text/escapes.js';

/* the fixed layout of the AC1009 header block */
const HDR_LEN = 0x6BD;                    /* bytes covered by the header CRC */
const ENTITIES_START = HDR_LEN + 2 + 16;  /* CRC + begin sentinel = 0x6CF */

/* entity type numbers (see pre13.ts) */
const T_LINE = 1, T_POINT = 2, T_CIRCLE = 3, T_SHAPE = 4, T_TEXT = 7,
  T_ARC = 8, T_SOLID = 11, T_BLOCK = 12, T_ENDBLK = 13, T_INSERT = 14,
  T_ATTRIB = 16, T_SEQEND = 17, T_POLYLINE = 19, T_VERTEX = 20,
  T_3DFACE = 22, T_DIMENSION = 23, T_VIEWPORT = 24;

/* fixed table record sizes (CRC included), and their second-header ids */
const TABLES = [
  ['BLOCK', 45, 1], ['LAYER', 41, 2], ['STYLE', 198, 3], ['LTYPE', 191, 5],
  ['VIEW', 153, 6], ['UCS', 109, 7], ['VPORT', 253, 8], ['APPID', 37, 9],
  ['DIMSTYLE', 324, 10], ['VX', 43, 11]
] as const;

/** The section sentinels are written as hex; unpack one to bytes. */
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length >> 1 },
    (_, i) => parseInt(hex.substr(i * 2, 2), 16));

/* Windows-1252 is the one codepage the format speaks for names; the
 * escape-free 32-byte fields cannot carry anything beyond it. */
const CP1252_BACK = new Map<number, number>();
CP1252_HIGH.forEach((cp, i) => CP1252_BACK.set(cp, 0x80 + i));
const cp1252 = (c: number): number =>
  c <= 0xff ? c : CP1252_BACK.get(c) ?? 0x3f;

/** Byte-aligned little-endian builder. */
export class W {
  bytes: number[] = [];
  private scratch = new DataView(new ArrayBuffer(8));
  get len(): number { return this.bytes.length; }
  u8(v: number): void { this.bytes.push(v & 0xff); }
  u16(v: number): void { this.bytes.push(v & 0xff, (v >>> 8) & 0xff); }
  i16(v: number): void { this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v: number): void {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  f64(v: number): void {
    this.scratch.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.bytes.push(this.scratch.getUint8(i));
  }
  pt2(x: number, y: number): void { this.f64(x); this.f64(y); }
  pt3(p: Point3): void { this.f64(p.x); this.f64(p.y); this.f64(p.z); }
  raw(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i] & 0xff);
  }
  /** Fixed-length NUL-padded name field. */
  name(s: string, n: number): void {
    for (let i = 0; i < n; i++) {
      this.bytes.push(i < s.length ? cp1252(s.charCodeAt(i)) : 0);
    }
  }
  /** Length-prefixed string (16-bit count, no terminator). */
  tv(s: string): void {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.bytes.push(cp1252(s.charCodeAt(i)));
  }
}

/** Text payloads leave as pure ASCII: %% symbol codes plus \U+ escapes,
 *  which our reader (and modern AutoCAD) fold back to the original. */
export const asciiText = (s: string): string => escapeUnicode(encodeCadSymbols(s));

export const near0 = (v: number): boolean => Math.abs(v) < 1e-12;

/* ---------------- downgrade geometry ----------------
 * Shared with the pre-R11 writers (writer-pre13.ts): every helper here is
 * pure — it looks at one entity and returns plain geometry. */

export const asPolyline = (
  pts: Point2[], src: Entity, closed = false, elevation = 0
): Entity => ({
  type: 'polyline', layer: src.layer, color: src.color,
  linetype: src.linetype, vertices: pts.map((p) => ({ x: p.x, y: p.y })),
  closed, elevation: elevation || undefined
});

export const sampleEllipse = (e: Entity & { type: 'ellipse' }): Point2[] => {
  const out: Point2[] = [];
  const full = Math.abs((e.endParam - e.startParam) - Math.PI * 2) < 1e-9;
  const n = 64;
  const mx = e.majorAxis.x, my = e.majorAxis.y;
  for (let i = 0; i <= (full ? n - 1 : n); i++) {
    const t = e.startParam + (e.endParam - e.startParam) * (i / n);
    const c = Math.cos(t), s = Math.sin(t);
    out.push({
      x: e.center.x + mx * c - my * e.ratio * s,
      y: e.center.y + my * c + mx * e.ratio * s
    });
  }
  return out;
};

/** de Boor evaluation, weights included; falls back to the control
 *  polygon when the knot vector does not fit the degree. */
export const sampleSpline = (e: SplineEntity): Point2[] => {
  const P = e.controlPoints, d = e.degree, knots = e.knots;
  /* fit-point splines carry no control net; the curve passes through
     the fit points, so a polyline through them is the downgrade */
  if (P.length < 2) return (e.fitPoints ?? []).map((p) => ({ x: p.x, y: p.y }));
  if (d < 1 || knots.length !== P.length + d + 1) {
    return P.map((p) => ({ x: p.x, y: p.y }));
  }
  const wgt = e.weights?.length === P.length ? e.weights : undefined;
  const lo = knots[d], hi = knots[knots.length - 1 - d];
  const out: Point2[] = [];
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const t = i === n ? hi : lo + (hi - lo) * (i / n);
    /* knot span */
    let k = d;
    while (k < P.length - 1 && !(t < knots[k + 1])) k++;
    const px: number[] = [], py: number[] = [], pw: number[] = [];
    for (let j = 0; j <= d; j++) {
      const w0 = wgt ? wgt[k - d + j] : 1;
      px.push(P[k - d + j].x * w0);
      py.push(P[k - d + j].y * w0);
      pw.push(w0);
    }
    for (let r = 1; r <= d; r++) {
      for (let j = d; j >= r; j--) {
        const a = knots[k - d + j], b = knots[k + 1 + j - r];
        const alpha = b === a ? 0 : (t - a) / (b - a);
        px[j] = (1 - alpha) * px[j - 1] + alpha * px[j];
        py[j] = (1 - alpha) * py[j - 1] + alpha * py[j];
        pw[j] = (1 - alpha) * pw[j - 1] + alpha * pw[j];
      }
    }
    out.push({ x: px[d] / (pw[d] || 1), y: py[d] / (pw[d] || 1) });
  }
  return out;
};

export const mtextLines = (e: Entity & { type: 'mtext' }): Entity[] => {
  const lines = e.text.split('\n');
  const gap = e.height * 5 / 3;
  const att = e.attachment ?? 1;
  const row = Math.floor((att - 1) / 3);          /* 0 top 1 middle 2 bottom */
  const total = lines.length * gap;
  const topY = row === 0 ? e.position.y
    : row === 1 ? e.position.y + total / 2 : e.position.y + total;
  const cos = Math.cos(e.rotation), sin = Math.sin(e.rotation);
  return lines.filter((tx) => tx.length).map((tx, i) => {
    const dy = topY - e.position.y - e.height - i * gap;
    return {
      type: 'text', layer: e.layer, color: e.color, style: e.style,
      position: {
        x: e.position.x - dy * sin, y: e.position.y + dy * cos,
        z: e.position.z
      },
      text: tx, height: e.height, rotation: e.rotation
    } as Entity;
  });
};

export const explodeMLeader = (e: Entity & { type: 'mleader' }): Entity[] => {
  const out: Entity[] = [];
  for (const leader of e.leaders) {
    for (const run of leader.lines) {
      if (run.length >= 2) out.push(asPolyline(run, e));
    }
  }
  if (e.text && e.textPosition) {
    out.push(...mtextLines({
      type: 'mtext', layer: e.layer, color: e.color,
      position: e.textPosition, text: e.text,
      height: e.textHeight ?? 2.5, rotation: e.textRotation ?? 0
    }));
  }
  return out;
};

export const explodeTable = (e: Entity & { type: 'table' }): Entity[] => {
  const out: Entity[] = [];
  const xs = [e.position.x];
  for (const cw of e.columnWidths) xs.push(xs[xs.length - 1] + cw);
  const ys = [e.position.y];
  for (const rh of e.rowHeights) ys.push(ys[ys.length - 1] - rh);
  for (const gx of xs) {
    out.push({
      type: 'line', layer: e.layer, color: e.color,
      start: { x: gx, y: ys[0], z: 0 },
      end: { x: gx, y: ys[ys.length - 1], z: 0 }
    });
  }
  for (const gy of ys) {
    out.push({
      type: 'line', layer: e.layer, color: e.color,
      start: { x: xs[0], y: gy, z: 0 },
      end: { x: xs[xs.length - 1], y: gy, z: 0 }
    });
  }
  for (let r = 0; r < e.numRows; r++) {
    for (let c = 0; c < e.numColumns; c++) {
      const cell = e.cells[r * e.numColumns + c];
      if (!cell?.text) continue;
      const h = Math.max(0.1, Math.abs(ys[r + 1] - ys[r]) * 0.6);
      out.push({
        type: 'text', layer: e.layer, color: e.color,
        position: { x: xs[c] + h * 0.2, y: ys[r + 1] + h * 0.3, z: 0 },
        text: cell.text, height: cell.textHeight || h, rotation: 0
      });
    }
  }
  return out;
};

/* ------------------------------------------------------------------ */

export const writeDwgR12 = (drawing: Drawing): DwgWriteResult => {
  const skipped: string[] = [];
  const downgraded: string[] = [];

  /* ---------------- tables ---------------- */
  const layers: Layer[] = drawing.layers.length ? drawing.layers : [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
  const layerIdx = new Map<string, number>();
  layers.forEach((ly, i) => layerIdx.set(ly.name, i));

  const styles = drawing.textStyles.length
    ? drawing.textStyles : [{ name: 'Standard' }];
  const styleIdx = new Map<string, number>();
  styles.forEach((st, i) => styleIdx.set(st.name, i));

  const ltypes = drawing.linetypes
    .filter((lt) => !/^(bylayer|byblock)$/i.test(lt.name));
  if (!ltypes.some((lt) => /^continuous$/i.test(lt.name))) {
    ltypes.unshift({ name: 'CONTINUOUS', description: 'Solid line', pattern: [] });
  }
  const ltypeIdx = new Map<string, number>();
  ltypes.forEach((lt, i) => ltypeIdx.set(lt.name, i));

  const appIds = drawing.appIds?.length ? [...drawing.appIds] : [];
  if (!appIds.some((a) => /^acad$/i.test(a))) appIds.unshift('ACAD');

  const dimStyles: DimStyle[] = drawing.dimStyles ?? [];

  /* R12 viewers draw a dimension from its anonymous block; a dimension
     arriving without one gets a materialized block so it stays visible. */
  const blockDefs: Drawing['blocks'] = { ...drawing.blocks };
  const dimBlockOf = new Map<Entity, string>();
  {
    let synth = 0;
    const allDims = [
      ...drawing.entities,
      ...Object.values(drawing.blocks).flatMap((b) => b.entities)
    ].filter((e): e is Entity & { type: 'dimension' } => e.type === 'dimension');
    for (const dim of allDims) {
      if (dim.blockName !== undefined && blockDefs[dim.blockName]) continue;
      const styleRec = drawing.dimStyles?.find((s) => s.name === dim.style);
      const drawn = explodeDimension(dim, styleRec, drawing.header.vars);
      if (!drawn.length) continue;
      let name = `*D${synth++}`;
      while (blockDefs[name]) name = `*D${synth++}`;
      blockDefs[name] = { name, basePoint: { x: 0, y: 0, z: 0 }, entities: drawn };
      dimBlockOf.set(dim, name);
    }
  }

  /* Blocks. INSERT and DIMENSION name their block by table position, and
     anonymous blocks are stored as a bare "*X" whose position becomes the
     digit in their name — so a numbered anonymous block keeps its slot
     whenever that slot is free, and everything else fills the gaps. */
  const wanted = Object.keys(blockDefs).filter((nm) =>
    !/^\*(model_space|paper_space)/i.test(nm) && !blockDefs[nm].isLayout);
  const slots: (string | undefined)[] = [];
  const late: string[] = [];
  for (const nm of wanted) {
    const anon = /^(\*\D*)(\d+)$/.exec(nm);
    if (anon) {
      const want = Number(anon[2]);
      if (want < wanted.length && slots[want] === undefined) {
        slots[want] = nm;
        continue;
      }
    }
    late.push(nm);
  }
  for (const nm of late) {
    let i = 0;
    while (slots[i] !== undefined) i++;
    slots[i] = nm;
  }
  const blockNames = slots.filter((nm): nm is string => nm !== undefined);
  const blockIdx = new Map<string, number>();
  blockNames.forEach((nm, i) => blockIdx.set(nm, i));

  /* ---------------- downgrades ---------------- */
  const NATIVE = new Set([
    'line', 'point', 'circle', 'arc', 'polyline', 'text', 'insert',
    'solid', 'face3d', 'shape', 'dimension', 'viewport', 'mesh'
  ]);

  const expand = (list: Entity[]): Entity[] => {
    const out: Entity[] = [];
    const down = (e: Entity, parts: Entity[]): void => {
      if (parts.length) { downgraded.push(e.type); out.push(...parts); }
      else skipped.push(e.type);
    };
    for (const e of list) {
      switch (e.type) {
        case 'ellipse':
          down(e, [asPolyline(sampleEllipse(e), e,
            Math.abs((e.endParam - e.startParam) - Math.PI * 2) < 1e-9,
            e.center.z)]);
          break;
        case 'spline': {
          const pts = sampleSpline(e);
          down(e, pts.length >= 2 ? [asPolyline(pts, e, e.closed)] : []);
          break;
        }
        case 'mtext':
          down(e, mtextLines(e));
          break;
        case 'hatch':
          down(e, explodeHatch(e));
          break;
        case 'leader':
          down(e, e.vertices.length >= 2
            ? [asPolyline(e.vertices, e, false, e.vertices[0].z)] : []);
          break;
        case 'mleader':
          down(e, explodeMLeader(e));
          break;
        case 'mline':
          down(e, e.vertices.length >= 2
            ? [asPolyline(e.vertices.map((v) => v.position), e,
              e.closed ?? false, e.basePoint.z)] : []);
          break;
        case 'tolerance':
          down(e, [{
            type: 'text', layer: e.layer, color: e.color,
            position: e.position, height: 2.5, rotation: 0,
            text: e.text.replace(/\{\\F[^;]*;|[{}]/g, '')
          }]);
          break;
        case 'table':
          down(e, explodeTable(e));
          break;
        case 'mesh':
          if (e.meshKind === 'subd') skipped.push('mesh(subd)');
          else out.push(e);
          break;
        case 'insert':
          if (blockIdx.has(e.blockName)) out.push(e);
          else skipped.push('insert(' + e.blockName + ')');
          break;
        case 'unknown':
          skipped.push(e.sourceType);
          break;
        default:
          if (NATIVE.has(e.type)) out.push(e);
          else skipped.push(e.type);
      }
    }
    return out;
  };

  const modelEnts = expand(drawing.entities);
  for (const e of drawing.paperSpace ?? []) {
    skipped.push(e.type + ' (paper space)');
  }
  const blockEnts = new Map<string, Entity[]>();
  for (const nm of blockNames) {
    blockEnts.set(nm, expand(blockDefs[nm].entities));
  }

  /* ---------------- entity records ---------------- */
  interface Extras { color?: number; ltype?: number; elevation?: number }

  const extrasOf = (e: Entity): Extras => {
    const out: Extras = {};
    const c: Color = e.color;
    let aci = c.kind === 'aci' ? c.index
      : c.kind === 'rgb' ? nearestAci(c.rgb)
        : c.kind === 'byBlock' ? 0 : undefined;
    if (aci !== undefined) {
      aci = Math.min(aci, 127);           /* the record stores a signed byte */
      out.color = e.invisible && aci > 0 ? -aci : aci;
    }
    if (e.linetype && !/^bylayer$/i.test(e.linetype)) {
      const li = ltypeIdx.get(e.linetype);
      if (li !== undefined) out.ltype = li;
    }
    return out;
  };

  /** Emit one record: common head, optional common fields, body, CRC.
   *  Returns the record's offset within the run. */
  const record = (
    run: W, type: number, flag: number, layer: number, opts: number,
    extras: Extras, body: (w: W) => void
  ): number => {
    const w = new W();
    let f = flag;
    if (extras.color !== undefined) f |= 1;
    if (extras.ltype !== undefined) f |= 2;
    if (extras.elevation !== undefined) f |= 4;
    w.u8(type);
    w.u8(f);
    w.u16(0);                             /* size, patched below */
    w.i16(layer);
    w.u16(opts);
    if (extras.color !== undefined) w.u8(extras.color);
    if (extras.ltype !== undefined) w.i16(extras.ltype);
    if (extras.elevation !== undefined) w.f64(extras.elevation);
    body(w);
    const size = w.len + 2;
    w.bytes[2] = size & 0xff;
    w.bytes[3] = (size >>> 8) & 0xff;
    const at = run.len;
    run.raw(w.bytes);
    run.u16(crc16(0xC0C1, Uint8Array.from(w.bytes)));
    return at;
  };

  const elev = (extras: Extras, z: number): Extras => {
    if (!near0(z)) extras.elevation = z;
    return extras;
  };

  const textBody = (
    w: W, e: TextEntity, kind: 'text' | 'attrib', tag?: string
  ): number => {
    /* body first; the caller stores the opts word we compute from it */
    const shift = kind === 'text' ? 0 : 1;
    let opts = 0;
    w.pt2(e.position.x, e.position.y);
    w.f64(e.height);
    w.tv(asciiText(e.text));
    if (kind === 'attrib') {
      w.tv(tag ?? 'TAG');
      w.u8(0);                            /* attribute flags */
    }
    const H = ['left', 'center', 'right', 'aligned', 'middle', 'fit'];
    const V = ['baseline', 'bottom', 'middle', 'top'];
    const halign = Math.max(0, H.indexOf(e.halign ?? 'left'));
    const valign = Math.max(0, V.indexOf(e.valign ?? 'baseline'));
    if (e.rotation) { opts |= 1 << shift; w.f64(e.rotation); }
    if (e.widthFactor !== undefined && Math.abs(e.widthFactor - 1) > 1e-9) {
      opts |= 2 << shift;
      w.f64(e.widthFactor);
    }
    if (e.oblique) { opts |= 4 << shift; w.f64(e.oblique); }
    if (e.style !== undefined && styleIdx.has(e.style)) {
      opts |= 8 << shift;
      w.u8(styleIdx.get(e.style)!);
    }
    if (halign) { opts |= 32 << shift; w.u8(halign); }
    if (e.alignmentPoint) {
      opts |= 64 << shift;
      w.pt2(e.alignmentPoint.x, e.alignmentPoint.y);
    }
    if (valign) { opts |= 256 << shift; w.u8(valign); }
    return opts;
  };

  /** Body writers return their opts word, so build into a scratch and
   *  wrap through record() with the word known. */
  const withOpts = (
    run: W, type: number, flag: number, layer: number, extras: Extras,
    body: (w: W) => number
  ): number => {
    const scratch = new W();
    const opts = body(scratch);
    return record(run, type, flag, layer, opts, extras, (w) => w.raw(scratch.bytes));
  };

  /** Encode one entity (plus its follower records); base is the absolute
   *  file address of the run, for SEQEND owner pointers. */
  const emit = (run: W, base: number, e: Entity): void => {
    const layer = layerIdx.get(e.layer) ?? 0;
    const ex = extrasOf(e);
    switch (e.type) {
      case 'line': {
        const flat = near0(e.start.z) && near0(e.end.z);
        record(run, T_LINE, flat ? 4 : 0, layer, 0, ex, (w) => {
          if (flat) { w.pt2(e.start.x, e.start.y); w.pt2(e.end.x, e.end.y); }
          else { w.pt3(e.start); w.pt3(e.end); }
        });
        return;
      }
      case 'point': {
        const flat = near0(e.position.z);
        record(run, T_POINT, flat ? 4 : 0, layer, 0, ex, (w) => {
          w.pt2(e.position.x, e.position.y);
          if (!flat) w.f64(e.position.z);
        });
        return;
      }
      case 'circle':
        record(run, T_CIRCLE, 0, layer, 0, elev(ex, e.center.z), (w) => {
          w.pt2(e.center.x, e.center.y);
          w.f64(e.radius);
        });
        return;
      case 'arc':
        record(run, T_ARC, 0, layer, 0, elev(ex, e.center.z), (w) => {
          w.pt2(e.center.x, e.center.y);
          w.f64(e.radius);
          w.f64(e.startAngle);
          w.f64(e.endAngle);
        });
        return;
      case 'solid':
        record(run, T_SOLID, 0, layer, 0, elev(ex, e.corners[0].z), (w) => {
          for (const c of e.corners) w.pt2(c.x, c.y);
        });
        return;
      case 'face3d': {
        const flat = e.corners.every((c) => near0(c.z));
        withOpts(run, T_3DFACE, flat ? 4 : 0, layer, ex, (w) => {
          for (const c of e.corners) {
            if (flat) w.pt2(c.x, c.y);
            else w.pt3(c);
          }
          if (!e.invisibleEdges) return 0;
          w.i16(e.invisibleEdges);
          return 1;
        });
        return;
      }
      case 'text':
        withOpts(run, T_TEXT, 0, layer, elev(ex, e.position.z),
          (w) => textBody(w, e, 'text'));
        return;
      case 'shape':
        withOpts(run, T_SHAPE, 0, layer, elev(ex, e.position.z), (w) => {
          let opts = 0;
          w.pt2(e.position.x, e.position.y);
          w.f64(e.size);
          w.u8(e.styleId ?? 0);
          if (e.rotation) { opts |= 1; w.f64(e.rotation); }
          if (e.widthFactor !== undefined && Math.abs(e.widthFactor - 1) > 1e-9) {
            opts |= 4;
            w.f64(e.widthFactor);
          }
          if (e.oblique) { opts |= 8; w.f64(e.oblique); }
          return opts;
        });
        return;
      case 'viewport':
        record(run, T_VIEWPORT, 0, layer, 0, ex, (w) => {
          w.pt3(e.center);
          w.f64(e.width);
          w.f64(e.height);
          w.i16(e.statusFlag ?? 0);
        });
        return;
      case 'insert': {
        const flag = e.attributes?.length ? 0x80 : 0;
        const at = withOpts(run, T_INSERT, flag, layer,
          elev(ex, e.position.z), (w) => {
            let opts = 0xf;                 /* scale x y z + rotation, always */
            w.i16(blockIdx.get(e.blockName) ?? 0);
            w.pt2(e.position.x, e.position.y);
            w.f64(e.scale.x);
            w.f64(e.scale.y);
            w.f64(e.rotation);
            w.f64(e.scale.z);
            if (e.columnCount !== undefined) { opts |= 16; w.u16(e.columnCount); }
            if (e.rowCount !== undefined) { opts |= 32; w.u16(e.rowCount); }
            if (e.columnSpacing !== undefined) { opts |= 64; w.f64(e.columnSpacing); }
            if (e.rowSpacing !== undefined) { opts |= 128; w.f64(e.rowSpacing); }
            return opts;
          });
        if (e.attributes?.length) {
          e.attributes.forEach((a, i) => {
            withOpts(run, T_ATTRIB, 0, layerIdx.get(a.layer) ?? layer,
              elev(extrasOf(a), a.position.z),
              (w) => textBody(w, a, 'attrib', 'ATTR' + i));
          });
          record(run, T_SEQEND, 0, layer, 0, {}, (w) => w.u32(base + at));
        }
        return;
      }
      case 'polyline': {
        const at = withOpts(run, T_POLYLINE, 0x80, layer,
          elev({ ...ex }, e.elevation ?? 0), (w) => {
            w.u8(e.closed ? 1 : 0);
            return 1;
          });
        for (const v of e.vertices) {
          withOpts(run, T_VERTEX, 0, layer, {}, (w) => {
              let opts = 0;
              w.pt2(v.x, v.y);
              const sw = v.startWidth ?? e.constantWidth ?? 0;
              const ew = v.endWidth ?? e.constantWidth ?? 0;
              if (sw) { opts |= 1; w.f64(sw); }
              if (ew) { opts |= 2; w.f64(ew); }
              if (v.bulge) { opts |= 4; w.f64(v.bulge); }
              return opts;
            });
        }
        record(run, T_SEQEND, 0, layer, 0, {}, (w) => w.u32(base + at));
        return;
      }
      case 'mesh': {
        emitMesh(run, base, e, layer, ex);
        return;
      }
      case 'dimension': {
        const KINDS = ['linear', 'aligned', 'angular2ln', 'diameter',
          'radius', 'angular3pt', 'ordinate'];
        const kindNo = e.kind ? KINDS.indexOf(e.kind) : (e.dimensionType & 7);
        if (kindNo < 0 || kindNo > 6) { skipped.push('dimension(arc)'); return; }
        withOpts(run, T_DIMENSION, 0, layer, elev(ex, e.elevation ?? 0), (w) => {
          let opts = 2;                    /* the kind byte is always present */
          const blkName = dimBlockOf.get(e) ?? e.blockName;
          const blk = blkName !== undefined ? blockIdx.get(blkName) : undefined;
          w.i16(blk ?? -1);
          w.pt3(e.definitionPoint);
          const mid = e.textMidpoint ?? e.definitionPoint;
          w.pt2(mid.x, mid.y);
          if (e.insertionPoint) {
            opts |= 1;
            w.pt2(e.insertionPoint.x, e.insertionPoint.y);
          }
          w.u8(kindNo | (e.dimensionType & (kindNo === 6 ? 192 : 128)));
          if (e.text !== undefined) { opts |= 4; w.tv(asciiText(e.text)); }
          const p3 = (p: Point3 | undefined, bit: number): void => {
            if (p) { opts |= bit; w.pt3(p); }
          };
          const p2f = (p: Point3 | undefined, bit: number): void => {
            if (p) { opts |= bit; w.pt2(p.x, p.y); }
          };
          const num = (v: number | undefined, bit: number): void => {
            if (v !== undefined) { opts |= bit; w.f64(v); }
          };
          switch (kindNo) {
            case 0:                       /* linear */
              p3(e.point13, 8); p3(e.point14, 16);
              num(e.rotation, 0x100); num(e.obliqueAngle, 0x200);
              num(e.textRotation, 0x400);
              break;
            case 1:                       /* aligned */
              p3(e.point13, 8); p3(e.point14, 16);
              num(e.obliqueAngle, 0x100); num(e.textRotation, 0x400);
              break;
            case 2: case 5:               /* angular */
              p3(e.point13, 8); p3(e.point14, 16); p3(e.point15, 32);
              p2f(e.point16, 64); num(e.textRotation, 0x400);
              break;
            case 3: case 4: {             /* diameter / radius */
              /* with an elevation the reader takes a flat point15 here */
              const flat = kindNo === 3 && !near0(e.elevation ?? 0);
              if (e.point15) {
                opts |= 32;
                if (flat) w.pt2(e.point15.x, e.point15.y);
                else w.pt3(e.point15);
              }
              num(e.leaderLength, 128); num(e.textRotation, 0x400);
              break;
            }
            default:                      /* ordinate */
              p3(e.point13, 8); p3(e.point14, 16);
              num(e.textRotation, 0x400);
          }
          return opts;
        });
        return;
      }
      default:
        skipped.push(e.type);             /* unreachable after expand() */
    }
  };

  const emitMesh = (
    run: W, base: number, e: MeshEntity, layer: number, ex: Extras
  ): void => {
    const pface = e.meshKind === 'faces';
    const at = withOpts(run, T_POLYLINE, 0x80, layer, { ...ex }, (w) => {
      const pflag = pface
        ? 64 : 16 | (e.closedM ? 1 : 0) | (e.closedN ? 32 : 0);
      w.u8(pflag);
      w.u16(pface ? e.vertices.length : (e.mSize ?? e.vertices.length));
      w.u16(pface ? (e.faces?.length ?? 0) : (e.nSize ?? 1));
      return 1 | 16 | 32;
    });
    for (const v of e.vertices) {
      withOpts(run, T_VERTEX, 0, layer, elev({ ...ex }, v.z), (w) => {
        w.pt2(v.x, v.y);
        w.u8(pface ? 192 : 64);           /* location record */
        return 8;
      });
    }
    if (pface) {
      for (const face of e.faces ?? []) {
        withOpts(run, T_VERTEX, 0, layer, { ...ex }, (w) => {
          let opts = 8 | 0x4000;          /* flags byte, no location */
          w.u8(128);                      /* face record */
          const bits = [0x20, 0x40, 0x80, 0x100];
          face.slice(0, 4).forEach((idx, i) => {
            opts |= bits[i];
            w.i16(idx);
          });
          return opts;
        });
      }
    }
    record(run, T_SEQEND, 0, layer, 0, {}, (w) => w.u32(base + at));
  };

  /* ---------------- runs ---------------- */
  const entRun = new W();
  for (const e of modelEnts) emit(entRun, ENTITIES_START, e);
  const entitiesEnd = ENTITIES_START + entRun.len;

  /* section layout: every section is [begin sentinel][records][end sentinel],
     and the directory addresses point at the records */
  const counts: Record<string, number> = {
    BLOCK: blockNames.length, LAYER: layers.length, STYLE: styles.length,
    LTYPE: ltypes.length, VIEW: 0, UCS: 0, VPORT: 2, APPID: appIds.length,
    DIMSTYLE: dimStyles.length, VX: 0
  };
  let at = entitiesEnd + 16;              /* entities end sentinel */
  const addr: Record<string, number> = {};
  for (const [name, size] of TABLES) {
    at += 16;                             /* begin sentinel */
    addr[name] = at;
    at += size * counts[name];
    at += 16;                             /* end sentinel */
  }
  const blocksStart = at + 16;

  const blkRun = new W();
  const blockOffset = new Map<string, number>();
  for (const nm of blockNames) {
    const def = blockDefs[nm];
    blockOffset.set(nm, blkRun.len);
    record(blkRun, T_BLOCK, 0, 0, 4, {}, (w) => {
      w.pt2(def.basePoint.x, def.basePoint.y);
      w.tv(asciiText(nm));
    });
    for (const e of blockEnts.get(nm) ?? []) emit(blkRun, blocksStart, e);
    record(blkRun, T_ENDBLK, 0, 0, 0, {}, () => undefined);
  }
  const extrasStart = blocksStart + blkRun.len + 32;

  /* ---------------- table records ---------------- */
  const tableRec = (run: W, body: (w: W) => void): void => {
    const w = new W();
    body(w);
    run.raw(w.bytes);
    run.u16(crc16(0xC0C1, Uint8Array.from(w.bytes)));
  };
  /** A symbol name that survives the 32-byte codepage field.
   *
   *  R12 names have no escape mechanism: a character Windows-1252 cannot
   *  spell has no spelling here at all, and losing the glyphs is the
   *  format's own limit. What is NOT the format's limit is the character
   *  we fall back to. cp1252() answers '?', which is a wildcard and not a
   *  legal name character: AutoCAD's AUDIT rejects such a record outright
   *  ("Invalid layer name "?????" found. Changed to AUDIT_I_...") — one
   *  error per name, externally reproduced against AutoCAD 2027. '_' is
   *  legal, so the record keeps a name AutoCAD accepts. A four-hex-digit
   *  fingerprint of the original keeps two different unspellable names
   *  from colliding into one record — an Arabic drawing usually has more
   *  than one. */
  const symbolName = (name: string): string => {
    let lossy = false;
    let out = '';
    for (const ch of name) {
      const c = ch.codePointAt(0)!;
      if (c > 0xff && !CP1252_HIGH.includes(c)) { lossy = true; out += '_'; }
      else out += ch;
    }
    if (!lossy) return name;
    let hash = 0x1505;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash * 33) ^ name.charCodeAt(i)) >>> 0;
    }
    const tag = (hash & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    return (out.slice(0, 27) + tag).slice(0, 31);
  };

  /** Flag byte, 32-byte name, and the R11 use count. */
  const head = (w: W, flag: number, name: string): void => {
    w.u8(flag);
    w.name(symbolName(name), 32);
    w.i16(-1);
  };

  const tblBLOCK = new W();
  for (const nm of blockNames) {
    const anon = /^(\*\D*)\d+$/.exec(nm);
    tableRec(tblBLOCK, (w) => {
      head(w, anon ? 0x41 : 0x40, anon ? anon[1] : nm);
      w.u32(0x40000000 | blockOffset.get(nm)!);
      w.u16(0xffff);
      w.u16(0xffff);
    });
  }

  const tblLAYER = new W();
  for (const ly of layers) {
    const aci = ly.color.kind === 'aci' ? ly.color.index
      : ly.color.kind === 'rgb' ? nearestAci(ly.color.rgb) : 7;
    tableRec(tblLAYER, (w) => {
      head(w, (ly.frozen ? 1 : 0) | (ly.locked ? 4 : 0), ly.name);
      w.i16(ly.on ? aci : -aci);
      w.i16(ly.linetype !== undefined ? (ltypeIdx.get(ly.linetype) ?? 0) : 0);
    });
  }

  const tblSTYLE = new W();
  for (const st of styles) {
    tableRec(tblSTYLE, (w) => {
      head(w, 0, st.name);
      w.f64(st.fixedHeight ?? 0);
      w.f64(st.widthFactor ?? 1);
      w.f64(0);                           /* oblique */
      w.u8(0);                            /* generation */
      w.f64(st.fixedHeight || 0.2);       /* last height used */
      w.name(st.font ?? 'txt', 64);
      w.name(st.bigFont ?? '', 64);
    });
  }

  const tblLTYPE = new W();
  for (const lt of ltypes) {
    tableRec(tblLTYPE, (w) => {
      head(w, 0x40, lt.name);
      w.name(lt.description ?? '', 48);
      w.u8(0x41);                         /* alignment, always 'A' */
      w.u8(Math.min(lt.pattern.length, 12));
      w.f64(lt.pattern.reduce((a, v) => a + Math.abs(v), 0));
      for (let i = 0; i < 12; i++) w.f64(lt.pattern[i] ?? 0);
    });
  }

  /* the *ACTIVE viewport pair, framed on the drawing extents */
  const bounds = drawingBounds(drawing);
  const vars = drawing.header.vars ?? {};
  const asPt = (v: unknown): Point3 | undefined => {
    const p = v as Point3 | undefined;
    return p && typeof p.x === 'number' ? p : undefined;
  };
  const viewCtr = asPt(vars.VIEWCTR)
    ?? (bounds
      ? {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2, z: 0
      }
      : { x: 6, y: 4.5, z: 0 });
  const viewSize = typeof vars.VIEWSIZE === 'number' && vars.VIEWSIZE > 0
    ? vars.VIEWSIZE
    : bounds && bounds.max.y > bounds.min.y
      ? (bounds.max.y - bounds.min.y) * 1.05
      : 9;

  const tblVPORT = new W();
  const vportTpl = VPORT_TEMPLATE;
  for (const flag of [0x80, 0x00]) {
    const rec = Uint8Array.from(vportTpl);
    const dv = new DataView(rec.buffer);
    rec[0] = flag;
    dv.setFloat64(123, viewSize, true);
    dv.setFloat64(131, viewCtr.x, true);
    dv.setFloat64(139, viewCtr.y, true);
    tblVPORT.raw(rec);
    tblVPORT.u16(crc16(0xC0C1, rec));
  }

  const tblAPPID = new W();
  for (const app of appIds) {
    tableRec(tblAPPID, (w) => head(w, 0x40, app));
  }

  const tblDIMSTYLE = new W();
  const DS_NUMS = ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE',
    'DIMRND', 'DIMDLE', 'DIMTP', 'DIMTM', 'DIMTXT', 'DIMCEN', 'DIMTSZ',
    'DIMALTF', 'DIMLFAC', 'DIMTVP'];
  const DS_FLAGS = ['DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1',
    'DIMSE2', 'DIMTAD', 'DIMZIN', 'DIMALT', 'DIMALTD', 'DIMTOFL', 'DIMSAH',
    'DIMTIX', 'DIMSOXD'];
  for (const ds of dimStyles) {
    const v = ds.vars ?? {};
    const numOf = (k: string, dflt: number): number =>
      typeof v[k] === 'number' ? v[k] as number : dflt;
    tableRec(tblDIMSTYLE, (w) => {
      head(w, 0, ds.name);
      const DFLT: Record<string, number> = {
        DIMSCALE: 1, DIMASZ: 0.18, DIMEXO: 0.0625, DIMDLI: 0.38,
        DIMEXE: 0.18, DIMTXT: 0.18, DIMLFAC: 1, DIMALTF: 25.4
      };
      for (const k of DS_NUMS) w.f64(numOf(k, DFLT[k] ?? 0));
      for (const k of DS_FLAGS) w.u8(Number(v[k] ?? 0) & 0xff);
      w.name(String(v.DIMPOST ?? ''), 16);
      w.name(String(v.DIMAPOST ?? ''), 16);
      w.name(String(v.DIMBLK ?? ''), 16);
      w.name(String(v.DIMBLK1 ?? ''), 16);
      w.name(String(v.DIMBLK2 ?? ''), 66);
      w.i16(numOf('DIMCLRD', 0));
      w.i16(numOf('DIMCLRE', 0));
      w.i16(numOf('DIMCLRT', 0));
      w.u8(Number(v.DIMUPT ?? 0) & 0xff);
      w.f64(numOf('DIMTFAC', 1));
      w.f64(numOf('DIMGAP', 0.09));
    });
  }

  const tableBytes: Record<string, W> = {
    BLOCK: tblBLOCK, LAYER: tblLAYER, STYLE: tblSTYLE, LTYPE: tblLTYPE,
    VIEW: new W(), UCS: new W(), VPORT: tblVPORT, APPID: tblAPPID,
    DIMSTYLE: tblDIMSTYLE, VX: new W()
  };

  /* ---------------- header ---------------- */
  const hdr = HEADER_TEMPLATE.slice();
  const hv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
  const p32 = (off: number, v: number): void => hv.setUint32(off, v >>> 0, true);
  const p16 = (off: number, v: number): void =>
    hv.setUint16(off, v < 0 ? v + 0x10000 : v, true);
  const pf = (off: number, v: number): void => hv.setFloat64(off, v, true);
  const ppt = (off: number, x: number, y: number, z?: number): void => {
    pf(off, x);
    pf(off + 8, y);
    if (z !== undefined) pf(off + 16, z);
  };

  p32(0x14, ENTITIES_START);
  p32(0x18, entitiesEnd);
  p32(0x1C, blocksStart);
  p32(0x20, (blkRun.len & 0xffffff) | 0x40000000);
  p32(0x24, extrasStart);
  p32(0x28, 0x80000000);

  /* the split table directory: five entries up front, five embedded at
     fixed offsets among the drawing variables */
  const DIR_AT: Record<string, number> = {
    BLOCK: 0x2C, LAYER: 0x36, STYLE: 0x40, LTYPE: 0x4A, VIEW: 0x54,
    UCS: 0x3EF, VPORT: 0x500, APPID: 0x512, DIMSTYLE: 0x522, VX: 0x69F
  };
  for (const [name, size] of TABLES) {
    const off = DIR_AT[name];
    p16(off, size);
    p16(off + 2, counts[name]);
    p16(off + 4, 0);
    p32(off + 6, addr[name]);
  }

  /* drawing variables the model carries; the template supplies the rest */
  const header = drawing.header;
  const extMin: Point3 = header.extMin
    ?? (bounds ? { ...bounds.min, z: 0 } : { x: 0, y: 0, z: 0 });
  const extMax: Point3 = header.extMax
    ?? (bounds ? { ...bounds.max, z: 0 } : { x: 0, y: 0, z: 0 });
  const insBase = asPt(vars.INSBASE) ?? { x: 0, y: 0, z: 0 };
  ppt(0x5E, insBase.x, insBase.y, insBase.z);
  ppt(0x78, extMin.x, extMin.y, extMin.z ?? 0);
  ppt(0x90, extMax.x, extMax.y, extMax.z ?? 0);
  ppt(0xA8, header.limMin?.x ?? 0, header.limMin?.y ?? 0);
  ppt(0xB8, header.limMax?.x ?? 12, header.limMax?.y ?? 9);
  ppt(0xC8, viewCtr.x, viewCtr.y, viewCtr.z);
  pf(0xE0, viewSize);
  pf(0x132, header.linetypeScale ?? 1);
  const clayer = typeof vars.CLAYER === 'string'
    ? layerIdx.get(vars.CLAYER) ?? 0 : 0;
  p16(0x14A, clayer);
  const tstyle = typeof vars.TEXTSTYLE === 'string'
    ? styleIdx.get(vars.TEXTSTYLE) ?? 0 : 0;
  p16(0x18E, tstyle);

  /* the plainly-numbered variables, straight from header.vars */
  const U16_VARS: Array<[number, string]> = [
    [0x76, 'PLINEGEN'], [0xE8, 'SNAPMODE'], [0x112, 'SNAPSTYLE'],
    [0x114, 'SNAPISOPAIR'], [0x116, 'GRIDMODE'], [0x128, 'ORTHOMODE'],
    [0x12A, 'REGENMODE'], [0x12C, 'FILLMODE'], [0x12E, 'QTEXTMODE'],
    [0x130, 'DRAGMODE'], [0x156, 'PSLTSCALE'], [0x158, 'TREEDEPTH'],
    [0x164, 'LUNITS'], [0x166, 'LUPREC'], [0x168, 'AXISMODE'],
    [0x18A, 'AUNITS'], [0x18C, 'AUPREC'], [0x190, 'OSMODE'],
    [0x192, 'ATTMODE'], [0x2E3, 'BLIPMODE']
  ];
  for (const [off, key] of U16_VARS) {
    if (typeof vars[key] === 'number') p16(off, vars[key] as number);
  }
  const F64_VARS: Array<[number, string]> = [
    [0xE0, 'VIEWSIZE'], [0x10A, 'SNAPANG'], [0x13A, 'TEXTSIZE'],
    [0x142, 'TRACEWID'], [0x17A, 'SKETCHINC'], [0x182, 'FILLETRAD'],
    [0x229, 'ELEVATION'], [0x231, 'THICKNESS']
  ];
  for (const [off, key] of F64_VARS) {
    if (typeof vars[key] === 'number') pf(off, vars[key] as number);
  }
  const PT2_VARS: Array<[number, string]> = [
    [0xEA, 'SNAPUNIT'], [0xFA, 'SNAPBASE'], [0x118, 'GRIDUNIT'],
    [0x16A, 'AXISUNIT']
  ];
  for (const [off, key] of PT2_VARS) {
    const p = vars[key] as Point2 | undefined;
    if (p && typeof p.x === 'number') ppt(off, p.x, p.y);
  }
  const vd = asPt(vars.VIEWDIR);
  if (vd) ppt(0x239, vd.x, vd.y, vd.z);
  const DIM_NUMS = ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE',
    'DIMTP', 'DIMTM', 'DIMTXT', 'DIMCEN', 'DIMTSZ'];
  DIM_NUMS.forEach((key, i) => {
    if (typeof vars[key] === 'number') pf(0x1A3 + i * 8, vars[key] as number);
  });
  const DIM_FLAGS = ['DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1',
    'DIMSE2', 'DIMTAD'];
  DIM_FLAGS.forEach((key, i) => {
    if (typeof vars[key] === 'number') hdr[0x1F3 + i] = (vars[key] as number) & 0xff;
  });
  if (typeof vars.LIMCHECK === 'number') hdr[0x1FA] = (vars.LIMCHECK as number) & 0xff;

  /* ---- the four slots AutoCAD's own AUDIT reads and we left at zero ----
   *
   * AC1009 carries more variables than any reader here consumes, and four
   * of them are range-checked by AutoCAD on open: a file that leaves them
   * zero audits with "Error found in auditing header variables" even when
   * it holds a single LINE. The offsets below were located externally
   * against AutoCAD 2027, by writing a self-identifying pattern across
   * the variables block and reading the values its AUDIT reported back
   * (each variable's report names the bytes it read), then confirming the
   * four together: the same minimal file audits 0 errors 0 fixed with
   * them set, and every one of the four returns the moment one is
   * cleared. They are write-only as far as this library is concerned —
   * pre13.ts reads none of them — so nothing else moves. */
  p16(0x520, 1);                          /* CYCLECURR: zero is rejected */
  pf(0x53F, 412148564080);                /* UXDWG: the unit-ratio constant
                                             every AutoCAD header carries */
  pf(0x547, 1);                           /* UXLENI: linear unit ratio.
                                             Overlaps the low two bytes of
                                             the template's decorative
                                             PUCSXDIR, which nothing reads */
  p16(0x6A9, 64);                         /* MAXACTVP: 2..32767, AutoCAD's
                                             own default is 64 */

  /* ---------------- assembly ---------------- */
  const out = new W();
  const sentinel = (hex: string, end = false): void => {
    for (const b of fromHex(hex)) out.u8(end ? b ^ 0xff : b);
  };
  out.raw(hdr);
  out.u16(crc16(0xC0C1, hdr));
  sentinel(SENTINELS.entities);
  out.raw(entRun.bytes);
  sentinel(SENTINELS.entities, true);
  for (const [name] of TABLES) {
    sentinel(SENTINELS[name]);
    out.raw(tableBytes[name].bytes);
    sentinel(SENTINELS[name], true);
  }
  sentinel(SENTINELS.blocks);
  out.raw(blkRun.bytes);
  sentinel(SENTINELS.blocks, true);
  sentinel(SENTINELS.extras);
  sentinel(SENTINELS.extras, true);

  /* second header: the full section directory again, CRC-closed */
  const secondAt = out.len;
  sentinel(SENTINELS.second);
  const sh = new W();
  sh.u16(0x0010);
  sh.u16(138);                            /* block length, marker through CRC */
  sh.u32(ENTITIES_START);
  sh.u32(entitiesEnd);
  sh.u32(blocksStart);
  sh.u32(extrasStart);
  for (let i = 0; i < 10; i++) sh.u8(0);
  sh.u16(TABLES.length);
  for (const [name, size, id] of TABLES) {
    sh.u16(id);
    sh.u16(size);
    sh.i16(counts[name]);
    sh.u32(addr[name]);
  }
  sh.u32(secondAt);
  sh.u16(crc16(0xC0C1, Uint8Array.from(sh.bytes)));
  out.raw(sh.bytes);
  sentinel(SENTINELS.second, true);

  return { data: Uint8Array.from(out.bytes), skipped, downgraded };
};
