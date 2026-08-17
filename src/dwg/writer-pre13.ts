/* nasjidwg — native writers for the byte-aligned releases before R11:
 * R10 (AC1006), R9 (AC1004), R2.6 (AC1003) and R2.10 (AC2.10).
 *
 * These files are AC1009's layout with the later inventions removed, and
 * src/dwg/pre13.ts — the reader every one of these writers is verified
 * against — is the specification for every field:
 *
 * - The header is the signature, a maintenance byte, the run/table/variable
 *   counts, six section pointers (model entities, block entities, extras,
 *   each as start + size), then the whole table directory as one flat run
 *   of (size, count, flags, address) records — nothing is embedded at
 *   fixed offsets among the drawing variables the way AC1009 embeds its
 *   last five directories. The drawing variables follow the directory as
 *   a flat, ordered run and the first entity starts right after them.
 * - The directory holds BLOCK/LAYER/STYLE/LTYPE/VIEW; R10 adds UCS and
 *   VPORT. APPID, DIMSTYLE and VX are R11 inventions, so dimension-style
 *   and appid data cannot travel in these files.
 * - Table records have no use-count word after the 32-byte name, and the
 *   LTYPE record has no alignment/dash-count bytes; STYLE carries its
 *   64-byte bigfont field only from R2.4 on (so not in R2.10).
 * - Entity records keep the R12 framing — type, flag, 16-bit size that
 *   counts the trailing CRC16 (seed 0xC0C1), layer, option word — but the
 *   linetype reference is a single byte. Before R10 every body is 2D and
 *   z lives in the shared elevation field; 3DLINE and 3DFACE are the two
 *   records that carry a z per point, which is how sloped lines and true
 *   3D faces travel. R10 moved the four fully-3D types (line, point,
 *   3dface, 3dline) to inline coordinates, with the elevation flag
 *   re-purposed to mean "this record is flat".
 * - No sentinels, no header CRC, no second header at the tail: those are
 *   R11 additions. The file simply ends after the block-definition run.
 *
 * Per release: R10 lacks only the VIEWPORT entity (paper space is R11).
 * R9 and R2.6 additionally lack meshes and inline 3D. R2.10 additionally
 * lacks the DIMENSION record, so dimensions leave as their drawn form.
 * Names (layers, styles, linetypes, blocks) are raw CP1252 bytes with no
 * escape mechanism; text payloads travel as ASCII with %% codes and \U+
 * escapes exactly as the R12 writer sends them.
 */

import { crc16 } from './bitwriter.js';
import {
  W, asPolyline, asciiText, explodeMLeader, explodeTable, mtextLines,
  near0, sampleEllipse, sampleSpline
} from './writer12.js';
import type { DwgWriteResult } from './writer.js';
import type {
  Color, Drawing, Entity, Layer, MeshEntity, Point2, Point3, TextEntity
} from '../core/model.js';
import { nearestAci } from '../core/color.js';
import { explodeDimension } from '../core/dim.js';
import { drawingBounds } from '../core/geo.js';
import { explodeHatch } from '../hatch/pattern.js';

/* entity type numbers (see pre13.ts) */
const T_LINE = 1, T_POINT = 2, T_CIRCLE = 3, T_SHAPE = 4, T_TEXT = 7,
  T_ARC = 8, T_SOLID = 11, T_BLOCK = 12, T_ENDBLK = 13, T_INSERT = 14,
  T_ATTRIB = 16, T_SEQEND = 17, T_POLYLINE = 19, T_VERTEX = 20,
  T_3DLINE = 21, T_3DFACE = 22, T_DIMENSION = 23;

/** Everything one release's layout decides. */
interface Release {
  /** File signature; also what detectVersion answers with. */
  magic: string;
  /** Announced variable count. The reader takes anything above 74 to mean
   *  the extended tail (LIMCHECK … BLIPMODE) follows the dimension flags. */
  numHeaderVars: number;
  extended: boolean;
  /** R10: inline 3D on line/point/3dface/3dline, PLINEGEN in the header
   *  slot older files used for their entity count. */
  r10: boolean;
  /** STYLE records carry the 64-byte bigfont field (R2.4 on). */
  bigFont: boolean;
  /** The DIMENSION record exists (R2.6 on). */
  dimension: boolean;
  /** POLYLINE mesh/polyface flags exist (R10 on). */
  mesh: boolean;
  /** Table directory entries, in file order, with record sizes (CRC
   *  included) — the same sizes the directory announces to the reader. */
  tables: ReadonlyArray<readonly [string, number]>;
}

/* Fixed record sizes, all CRC-inclusive: BLOCK 39 = flag 1 + name 32 +
 * offset 4 + CRC 2; LAYER 39 = head 33 + colour 2 + ltype 2 + CRC;
 * STYLE 196/132 = head 33 + 3 doubles + gen byte + last height + font 64
 * (+ bigfont 64) + CRC; LTYPE 187 = head 33 + description 48 + length 8 +
 * 12 dashes + CRC; VIEW 91 = head 33 + height 8 + centre 16 + width 8 +
 * direction 24 + CRC; UCS 107 = head 33 + three points + CRC; VPORT 155
 * (written empty — its record layout predates anything the model keeps). */
const CORE_TABLES = [
  ['BLOCK', 39], ['LAYER', 39], ['STYLE', 196], ['LTYPE', 187], ['VIEW', 91]
] as const;

const REL_R10: Release = {
  magic: 'AC1006', numHeaderVars: 80, extended: true, r10: true,
  bigFont: true, dimension: true, mesh: true,
  tables: [...CORE_TABLES, ['UCS', 107], ['VPORT', 155]]
};
const REL_R9: Release = {
  magic: 'AC1004', numHeaderVars: 80, extended: true, r10: false,
  bigFont: true, dimension: true, mesh: false, tables: CORE_TABLES
};
const REL_R2_6: Release = {
  magic: 'AC1003', numHeaderVars: 80, extended: true, r10: false,
  bigFont: true, dimension: true, mesh: false, tables: CORE_TABLES
};
const REL_R2_10: Release = {
  magic: 'AC2.10', numHeaderVars: 74, extended: false, r10: false,
  bigFont: false, dimension: false, mesh: false,
  tables: [['BLOCK', 39], ['LAYER', 39], ['STYLE', 132], ['LTYPE', 187],
    ['VIEW', 91]]
};

/* The drawing-variables run is a fixed sequence: 412 bytes through the
 * seven dimension flags, plus a 235-byte extended tail (LIMCHECK, the
 * 46-byte menu overflow, ELEVATION, THICKNESS, VIEWDIR and its six-point
 * basis, a mode word and BLIPMODE). */
const VARS_BASE = 412;
const VARS_EXT = 235;

/* ------------------------------------------------------------------ */

const writePre13 = (drawing: Drawing, rel: Release): DwgWriteResult => {
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

  const views = drawing.views ?? [];
  const ucsList = rel.r10 ? (drawing.ucs ?? []) : [];

  /* Dimensions draw from their anonymous block here just as in R12, so a
   * dimension arriving without one gets a materialized block. Releases
   * without the DIMENSION record skip this: their dimensions leave as the
   * drawn geometry directly (see expand below). */
  const blockDefs: Drawing['blocks'] = { ...drawing.blocks };
  const dimBlockOf = new Map<Entity, string>();
  if (rel.dimension) {
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

  /* Block slots: INSERT and DIMENSION name their block by table position,
   * and anonymous blocks are stored as a bare "*X" whose position becomes
   * the digit in their name (same allocation as the R12 writer). */
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
    'solid', 'face3d', 'shape'
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
        case 'dimension':
          if (rel.dimension) out.push(e);
          else {
            /* no DIMENSION record before R2.6 — the drawn form goes out */
            const styleRec = drawing.dimStyles?.find((s) => s.name === e.style);
            down(e, explodeDimension(e, styleRec, drawing.header.vars));
          }
          break;
        case 'mesh':
          if (!rel.mesh || e.meshKind === 'subd') {
            skipped.push(`mesh(${e.meshKind})`);
          } else out.push(e);
          break;
        case 'face3d':
          /* pre-R10 3DFACE has no edge-visibility word: the face is kept,
             the mask is not */
          if (!rel.r10 && e.invisibleEdges) {
            downgraded.push('face3d(edges)');
            const copy = { ...e };
            delete copy.invisibleEdges;
            out.push(copy);
          } else out.push(e);
          break;
        case 'viewport':
          skipped.push('viewport');       /* the record is an R11 invention */
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
      if (li !== undefined && li <= 0xff) out.ltype = li;
    }
    return out;
  };

  /** Emit one record: common head, optional common fields, body, CRC.
   *  Identical to R12's framing except the linetype reference, which is a
   *  single byte before R11. Returns the record's offset within the run. */
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
    if (extras.ltype !== undefined) w.u8(extras.ltype);
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
        if (rel.r10) {
          /* R10 lines are inline 3D; the elevation flag marks a flat one */
          const flat = near0(e.start.z) && near0(e.end.z);
          record(run, T_LINE, flat ? 4 : 0, layer, 0, ex, (w) => {
            if (flat) { w.pt2(e.start.x, e.start.y); w.pt2(e.end.x, e.end.y); }
            else { w.pt3(e.start); w.pt3(e.end); }
          });
        } else if (near0(e.start.z - e.end.z)) {
          /* before R10 a LINE is 2D plus a shared elevation */
          record(run, T_LINE, 0, layer, 0, elev(ex, e.start.z), (w) => {
            w.pt2(e.start.x, e.start.y);
            w.pt2(e.end.x, e.end.y);
          });
        } else {
          /* a sloped line needs the per-point z only 3DLINE carries */
          record(run, T_3DLINE, 0, layer, 3, ex, (w) => {
            w.pt3(e.start);
            w.pt3(e.end);
          });
        }
        return;
      }
      case 'point': {
        if (rel.r10) {
          const flat = near0(e.position.z);
          record(run, T_POINT, flat ? 4 : 0, layer, 0, ex, (w) => {
            w.pt2(e.position.x, e.position.y);
            if (!flat) w.f64(e.position.z);
          });
        } else {
          record(run, T_POINT, 0, layer, 0, elev(ex, e.position.z), (w) => {
            w.pt2(e.position.x, e.position.y);
          });
        }
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
        if (rel.r10) {
          withOpts(run, T_3DFACE, flat ? 4 : 0, layer, ex, (w) => {
            for (const c of e.corners) {
              if (flat) w.pt2(c.x, c.y);
              else w.pt3(c);
            }
            if (!e.invisibleEdges) return 0;
            w.i16(e.invisibleEdges);
            return 1;
          });
        } else {
          /* each corner announces its own z through the option bits */
          record(run, T_3DFACE, 0, layer, flat ? 0 : 0xf, ex, (w) => {
            for (const c of e.corners) {
              if (flat) w.pt2(c.x, c.y);
              else w.pt3(c);
            }
          });
        }
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
        emitMesh(run, base, e, layer, ex);  /* R10 only; expand() gates it */
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
          /* the definition point is 3D only from R10 */
          if (rel.r10) w.pt3(e.definitionPoint);
          else w.pt2(e.definitionPoint.x, e.definitionPoint.y);
          const mid = e.textMidpoint ?? e.definitionPoint;
          w.pt2(mid.x, mid.y);
          if (e.insertionPoint) {
            opts |= 1;
            w.pt2(e.insertionPoint.x, e.insertionPoint.y);
          }
          w.u8(kindNo | (e.dimensionType & (kindNo === 6 ? 192 : 128)));
          if (e.text !== undefined) { opts |= 4; w.tv(asciiText(e.text)); }
          /* the "wide" definition points: 3D from R10, flat before */
          const pw = (p: Point3 | undefined, bit: number): void => {
            if (!p) return;
            opts |= bit;
            if (rel.r10) w.pt3(p);
            else w.pt2(p.x, p.y);
          };
          const p2f = (p: Point3 | undefined, bit: number): void => {
            if (p) { opts |= bit; w.pt2(p.x, p.y); }
          };
          const num = (v: number | undefined, bit: number): void => {
            if (v !== undefined) { opts |= bit; w.f64(v); }
          };
          switch (kindNo) {
            case 0:                       /* linear */
              pw(e.point13, 8); pw(e.point14, 16);
              num(e.rotation, 0x100); num(e.obliqueAngle, 0x200);
              num(e.textRotation, 0x400);
              break;
            case 1:                       /* aligned */
              pw(e.point13, 8); pw(e.point14, 16);
              num(e.obliqueAngle, 0x100); num(e.textRotation, 0x400);
              break;
            case 2: case 5:               /* angular */
              pw(e.point13, 8); pw(e.point14, 16); pw(e.point15, 32);
              p2f(e.point16, 64); num(e.textRotation, 0x400);
              break;
            case 3: case 4: {             /* diameter / radius */
              if (e.point15) {
                opts |= 32;
                /* the reader takes a flat point here before R10, and on
                   R10 for a diameter that carries an elevation */
                const flat = !rel.r10
                  || (kindNo === 3 && !near0(e.elevation ?? 0));
                if (flat) w.pt2(e.point15.x, e.point15.y);
                else w.pt3(e.point15);
              }
              num(e.leaderLength, 128); num(e.textRotation, 0x400);
              break;
            }
            default:                      /* ordinate */
              pw(e.point13, 8); pw(e.point14, 16);
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
  /* the first entity starts right after the drawing variables */
  const entitiesStart = 0x2C + rel.tables.length * 10
    + VARS_BASE + (rel.extended ? VARS_EXT : 0);
  const entRun = new W();
  for (const e of modelEnts) emit(entRun, entitiesStart, e);
  const entitiesEnd = entitiesStart + entRun.len;

  const counts: Record<string, number> = {
    BLOCK: blockNames.length, LAYER: layers.length, STYLE: styles.length,
    LTYPE: ltypes.length, VIEW: views.length, UCS: ucsList.length, VPORT: 0
  };
  let at = entitiesEnd;
  const addr: Record<string, number> = {};
  for (const [name, size] of rel.tables) {
    addr[name] = at;
    at += size * counts[name];
  }
  const blocksStart = at;

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
  const extrasStart = blocksStart + blkRun.len;

  /* ---------------- table records ---------------- */
  const tableRec = (run: W, body: (w: W) => void): void => {
    const w = new W();
    body(w);
    run.raw(w.bytes);
    run.u16(crc16(0xC0C1, Uint8Array.from(w.bytes)));
  };
  /** Flag byte and 32-byte name — no use count before R11. */
  const head = (w: W, flag: number, name: string): void => {
    w.u8(flag);
    w.name(name, 32);
  };

  const tblBLOCK = new W();
  for (const nm of blockNames) {
    const anon = /^(\*\D*)\d+$/.exec(nm);
    tableRec(tblBLOCK, (w) => {
      head(w, anon ? 0x41 : 0x40, anon ? anon[1] : nm);
      w.u32(blockOffset.get(nm)!);
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
      if (rel.bigFont) w.name(st.bigFont ?? '', 64);
    });
  }

  const tblLTYPE = new W();
  for (const lt of ltypes) {
    tableRec(tblLTYPE, (w) => {
      head(w, 0x40, lt.name);
      w.name(lt.description ?? '', 48);
      /* no alignment or dash-count bytes before R11 */
      w.f64(lt.pattern.reduce((a, v) => a + Math.abs(v), 0));
      for (let i = 0; i < 12; i++) w.f64(lt.pattern[i] ?? 0);
    });
  }

  const tblVIEW = new W();
  for (const v of views) {
    tableRec(tblVIEW, (w) => {
      head(w, 0, v.name);
      w.f64(v.height);
      w.pt2(v.center.x, v.center.y);
      w.f64(v.width);
      w.pt3(v.direction ?? { x: 0, y: 0, z: 1 });
    });
  }

  const tblUCS = new W();
  for (const u of ucsList) {
    tableRec(tblUCS, (w) => {
      head(w, 0, u.name);
      w.pt3(u.origin);
      w.pt3(u.xAxis);
      w.pt3(u.yAxis);
    });
  }

  const tableBytes: Record<string, W> = {
    BLOCK: tblBLOCK, LAYER: tblLAYER, STYLE: tblSTYLE, LTYPE: tblLTYPE,
    VIEW: tblVIEW, UCS: tblUCS, VPORT: new W()
  };

  /* ---------------- header ---------------- */
  const bounds = drawingBounds(drawing);
  const header = drawing.header;
  const vars = header.vars ?? {};
  const asPt = (v: unknown): Point3 | undefined => {
    const p = v as Point3 | undefined;
    return p && typeof p.x === 'number' ? p : undefined;
  };
  const numOf = (key: string, dflt: number): number =>
    typeof vars[key] === 'number' ? vars[key] as number : dflt;
  const extMin: Point3 = header.extMin
    ?? (bounds ? { ...bounds.min, z: 0 } : { x: 0, y: 0, z: 0 });
  const extMax: Point3 = header.extMax
    ?? (bounds ? { ...bounds.max, z: 0 } : { x: 0, y: 0, z: 0 });
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
  const clayer = typeof vars.CLAYER === 'string'
    ? layerIdx.get(vars.CLAYER) ?? 0 : 0;
  const tstyle = typeof vars.TEXTSTYLE === 'string'
    ? styleIdx.get(vars.TEXTSTYLE) ?? 0 : 0;

  const hdr = new W();
  hdr.name(rel.magic, 6);                 /* release signature */
  for (let i = 0; i < 5; i++) hdr.u8(0);  /* pad to the maintenance byte */
  hdr.u8(0);                              /* 0x0B maintenance release */
  hdr.u8(0);                              /* 0x0C layout discriminator */
  hdr.u16(3);                             /* entity runs: model, blocks, extras */
  hdr.u16(rel.tables.length);             /* table directories that follow */
  hdr.u16(rel.numHeaderVars);             /* drawing variables that follow */
  hdr.u8(0);                              /* internal dwg version */
  hdr.u32(entitiesStart);
  hdr.u32(entitiesEnd);
  hdr.u32(blocksStart);
  hdr.u32(blkRun.len & 0xffffff);
  hdr.u32(extrasStart);
  hdr.u32(0);                             /* no extras run */

  /* the whole table directory, one flat run of ten-byte records */
  for (const [name, size] of rel.tables) {
    hdr.u16(size);
    hdr.i16(counts[name]);
    hdr.u16(0);                           /* flags */
    hdr.u32(addr[name]);
  }

  /* the drawing variables, in the exact order pre13.ts reads them */
  const pt2Var = (key: string, dx = 0, dy = 0): void => {
    const p = vars[key] as Point2 | undefined;
    if (p && typeof p.x === 'number') hdr.pt2(p.x, p.y);
    else hdr.pt2(dx, dy);
  };
  hdr.pt3(asPt(vars.INSBASE) ?? { x: 0, y: 0, z: 0 });
  /* R10 keeps PLINEGEN here; older files their entity count */
  hdr.u16(rel.r10 ? numOf('PLINEGEN', 0) : modelEnts.length & 0xffff);
  hdr.pt3(extMin);
  hdr.pt3(extMax);
  hdr.pt2(header.limMin?.x ?? 0, header.limMin?.y ?? 0);
  hdr.pt2(header.limMax?.x ?? 12, header.limMax?.y ?? 9);
  hdr.pt3(viewCtr);
  hdr.f64(viewSize);
  hdr.u16(numOf('SNAPMODE', 0));
  pt2Var('SNAPUNIT', 1, 1);
  pt2Var('SNAPBASE');
  hdr.f64(numOf('SNAPANG', 0));
  hdr.u16(numOf('SNAPSTYLE', 0));
  hdr.u16(numOf('SNAPISOPAIR', 0));
  hdr.u16(numOf('GRIDMODE', 0));
  pt2Var('GRIDUNIT');
  hdr.u16(numOf('ORTHOMODE', 0));
  hdr.u16(numOf('REGENMODE', 1));
  hdr.u16(numOf('FILLMODE', 1));
  hdr.u16(numOf('QTEXTMODE', 0));
  hdr.u16(numOf('DRAGMODE', 2));
  hdr.f64(header.linetypeScale ?? 1);     /* LTSCALE */
  hdr.f64(numOf('TEXTSIZE', 0.2));
  hdr.f64(numOf('TRACEWID', 0.2));
  hdr.i16(clayer);
  hdr.u32(15);                            /* colour carried from R2 files */
  hdr.u32(0);
  hdr.u16(0);                             /* unknown */
  if (rel.r10) {
    hdr.u16(numOf('PSLTSCALE', 0));
    hdr.u16(numOf('TREEDEPTH', 0));
    hdr.u16(0);
  } else {
    hdr.u16(0); hdr.u16(0); hdr.u16(0);
  }
  hdr.f64(0);                             /* viewport aspect ratio (derived) */
  hdr.u16(numOf('LUNITS', 2));
  hdr.u16(numOf('LUPREC', 4));
  hdr.u16(numOf('AXISMODE', 0));
  pt2Var('AXISUNIT');
  hdr.f64(numOf('SKETCHINC', 0.1));
  hdr.f64(numOf('FILLETRAD', 0));
  hdr.u16(numOf('AUNITS', 0));
  hdr.u16(numOf('AUPREC', 0));
  hdr.i16(tstyle);                        /* TEXTSTYLE, by table position */
  hdr.u16(numOf('OSMODE', 0));
  hdr.u16(numOf('ATTMODE', 1));
  hdr.name('acad', 15);                   /* MENU */
  const DIM_DFLT: Record<string, number> = {
    DIMSCALE: 1, DIMASZ: 0.18, DIMEXO: 0.0625, DIMDLI: 0.38,
    DIMEXE: 0.18, DIMTXT: 0.18, DIMCEN: 0.09
  };
  for (const key of ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE',
    'DIMTP', 'DIMTM', 'DIMTXT', 'DIMCEN', 'DIMTSZ']) {
    hdr.f64(numOf(key, DIM_DFLT[key] ?? 0));
  }
  for (const key of ['DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1',
    'DIMSE2', 'DIMTAD']) {
    hdr.u8(numOf(key, key === 'DIMTIH' || key === 'DIMTOH' ? 1 : 0) & 0xff);
  }
  if (rel.extended) {
    hdr.u8(numOf('LIMCHECK', 0) & 0xff);
    for (let i = 0; i < 46; i++) hdr.u8(0);   /* menu name overflow */
    hdr.f64(numOf('ELEVATION', 0));
    hdr.f64(numOf('THICKNESS', 0));
    hdr.pt3(asPt(vars.VIEWDIR) ?? { x: 0, y: 0, z: 1 });
    for (let i = 0; i < 18; i++) hdr.f64(0);  /* view direction bases */
    hdr.u16(0);                           /* 3d flag */
    hdr.u16(numOf('BLIPMODE', 1));
  }
  if (hdr.len !== entitiesStart) {
    throw new Error(`pre-R13 writer: header is ${hdr.len} bytes, `
      + `expected ${entitiesStart}`);
  }

  /* ---------------- assembly ---------------- */
  const out = new W();
  out.raw(hdr.bytes);
  out.raw(entRun.bytes);
  for (const [name] of rel.tables) out.raw(tableBytes[name].bytes);
  out.raw(blkRun.bytes);

  return { data: Uint8Array.from(out.bytes), skipped, downgraded };
};

/* ------------------------------------------------------------------ */

/** R10 (AC1006): everything R12 writes except the VIEWPORT entity and the
 *  R11 tables (APPID, DIMSTYLE, VX) — so dimension-style records travel
 *  only as the header's DIM* variables. */
export const writeDwgR10 = (drawing: Drawing): DwgWriteResult =>
  writePre13(drawing, REL_R10);

/** R9 (AC1004): R10 minus meshes and inline 3D — z travels in the shared
 *  elevation field, sloped lines as 3DLINE records. */
export const writeDwgR9 = (drawing: Drawing): DwgWriteResult =>
  writePre13(drawing, REL_R9);

/** R2.6 (AC1003): the same shape as R9 under the older signature. */
export const writeDwgR2_6 = (drawing: Drawing): DwgWriteResult =>
  writePre13(drawing, REL_R2_6);

/** R2.10 (AC2.10): additionally lacks the DIMENSION record (dimensions go
 *  out as their drawn form), the STYLE bigfont field and the extended
 *  header tail. */
export const writeDwgR2_10 = (drawing: Drawing): DwgWriteResult =>
  writePre13(drawing, REL_R2_10);
