/* nasjidwg — tolerant ASCII DXF reader.
 *
 * Ported from nasjicad's dxf.js: a group-code pair scanner that never
 * throws on malformed input. Where the app schema forced approximations
 * (sampled ellipses, collapsed MTEXT, single hatch loops, flattened
 * nested inserts) the nasjidwg model keeps the data exact instead.
 */

import type {
  AcisEntity, BlockDefinition, Color, DimensionEntity, DimensionKind,
  Drawing, Entity,
  Face3DEntity, FileVersion, GeoData, HatchBoundary, HatchDefLine, HatchEdge,
  HatchEntity, HatchGradient, HatchLoopFlags, ImageEntity, Layer, LeaderEntity, Linetype,
  Group as EntityGroup, Layout, MeshEntity, MLeaderEntity, MLeaderLeader,
  MLineEntity, MLineStyle,
  MLineStyleElement, MLineVertex, MTextEntity, Point2, Point3,
  PolylineEntity, PolylineVertex, ProxyEntity, ProxyObject, ShapeEntity,
  SplineEntity, TableCell, TableEntity, TextEntity,
  TextHAlign, TextStyle, TextVAlign, ToleranceEntity, UnderlayEntity,
  UnknownEntity, UnknownObject,
  View, VPort, XdataGroup, XdataValue, XRecord
} from '../core/model.js';
import { decodeProxyGraphics } from '../dwg/proxy.js';
import { decodeCadText, stripMtextCodes } from '../text/escapes.js';
import { binaryDxfToPairs, isBinaryDxf } from './binary.js';

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

type Group = [number, string];

const H_ALIGNS: readonly TextHAlign[] =
  ['left', 'center', 'right', 'aligned', 'middle', 'fit'];
const V_ALIGNS: readonly TextVAlign[] = ['baseline', 'bottom', 'middle', 'top'];

const VERSION_MAP: Record<string, FileVersion> = {
  AC1012: 'R13', AC1014: 'R14', AC1015: 'R2000', AC1018: 'R2004',
  AC1021: 'R2007', AC1024: 'R2010', AC1027: 'R2013', AC1032: 'R2018'
};

/** Query helper over a record's group list. */
const G = (g: Group[]) => ({
  num(code: number, def: number): number {
    for (const [c, v] of g) if (c === code) { const n = parseFloat(v); return isFinite(n) ? n : def; }
    return def;
  },
  numOr(code: number): number | null {
    for (const [c, v] of g) if (c === code) { const n = parseFloat(v); return isFinite(n) ? n : null; }
    return null;
  },
  int(code: number, def: number): number {
    for (const [c, v] of g) if (c === code) { const n = parseInt(v, 10); return isFinite(n) ? n : def; }
    return def;
  },
  str(code: number, def: string): string {
    for (const [c, v] of g) if (c === code) return v.trim();
    return def;
  },
  rawAll(code: number): string[] {
    const out: string[] = [];
    for (const [c, v] of g) if (c === code) out.push(v);
    return out;
  },
  nums(code: number): number[] {
    const out: number[] = [];
    for (const [c, v] of g) if (c === code) { const n = parseFloat(v); if (isFinite(n)) out.push(n); }
    return out;
  },
  all(): Group[] { return g; }
});
type Q = ReturnType<typeof G>;

const pt3 = (q: Q, xc: number, yc: number, zc: number): Point3 =>
  ({ x: q.num(xc, 0), y: q.num(yc, 0), z: q.num(zc, 0) });

/** Pair parallel coordinate arrays into points (missing z -> 0). */
const zip3 = (xs: number[], ys: number[], zs: number[]): Point3[] => {
  const n = Math.min(xs.length, ys.length);
  const pts: Point3[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: xs[i], y: ys[i], z: zs[i] ?? 0 });
  return pts;
};

/** 310 hex chunks to bytes; anything non-hex is skipped. */
const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

/** The middle both proxy record forms share (ACAD_PROXY_ENTITY and
 *  ACAD_PROXY_OBJECT): 91 names the application class, 92 opens the
 *  graphics bytes and 93 the entity-data BITS — each followed by 310 hex
 *  chunks — then the handle references run to the 94 end marker, 95
 *  carries the packed version word (maintenance in the high word) and 70
 *  the from-DXF origin flag. The 2018 spelling the reference writes today
 *  says the same things under other numbers: 160 opens the graphics
 *  bytes, 161/162 the entity data (its size in bits and in bytes), and
 *  the version word is split into 71 (the drawing format) and 97 (the
 *  maintenance release). The walk starts collecting only once the
 *  proxy's own groups begin, so the common section's owner handle never
 *  masquerades as a reference. Forgiving throughout: whatever is
 *  malformed is simply left out. */
interface ProxyPayload {
  classId: number;
  graphics?: Uint8Array;
  data?: Uint8Array;
  dataBits?: number;
  refs?: { code: number; value: string }[];
  proxyVersion?: number;
  proxyMaint?: number;
  fromDxf?: boolean;
}
const parseProxyPayload = (g: Group[]): ProxyPayload => {
  const out: ProxyPayload = { classId: 0 };
  let inProxy = false;
  let refsDone = false;
  let target: 'graphics' | 'data' = 'graphics';
  let graphicsHex = '', dataHex = '';
  /* every size the record states for the entity data, in whichever
     spelling; the one that fits the bytes is the bit count (below) */
  const sizes: number[] = [];
  const refs: { code: number; value: string }[] = [];
  for (const [c, v] of g) {
    if (c === 100) { if (/AcDbProxy/i.test(v)) inProxy = true; continue; }
    if (c === 90 || c === 91 || c === 92 || c === 93) inProxy = true;
    if (!inProxy) continue;
    if (c === 91) out.classId = parseInt(v, 10) || 0;
    else if (c === 95) {
      const word = (parseInt(v, 10) || 0) >>> 0;
      out.proxyVersion = word & 0xffff;
      const maint = word >>> 16;
      if (maint) out.proxyMaint = maint;
    } else if (c === 71) out.proxyVersion = (parseInt(v, 10) || 0) & 0xffff;
    else if (c === 97) {
      const maint = parseInt(v, 10) || 0;
      if (maint) out.proxyMaint = maint;
    } else if (c === 70) out.fromDxf = parseInt(v, 10) !== 0;
    else if (refsDone) continue;
    else if (c === 92 || c === 160) target = 'graphics';
    else if (c === 93 || c === 161 || c === 162) {
      target = 'data';
      sizes.push(parseInt(v, 10) || 0);
    } else if (c === 310) {
      if (target === 'data') dataHex += v; else graphicsHex += v;
    }
    /* soft references (330/350) were code 4 in the source record, hard
       ones (340/360) code 3 */
    else if (c === 330 || c === 350) refs.push({ code: 4, value: v.trim().toUpperCase() });
    else if (c === 340 || c === 360) refs.push({ code: 3, value: v.trim().toUpperCase() });
    else if (c === 94) refsDone = true;
  }
  if (graphicsHex) out.graphics = hexToBytes(graphicsHex);
  if (dataHex) {
    const bytes = hexToBytes(dataHex);
    out.data = bytes;
    /* the stated bit length is whichever size lands inside the last
       byte (a byte count never does, past the first byte); a missing or
       impossible count falls back to whole bytes */
    const bits = sizes.find((n) => n > (bytes.length - 1) * 8 && n <= bytes.length * 8);
    out.dataBits = bits ?? bytes.length * 8;
  }
  if (refs.length) out.refs = refs;
  return out;
};

/* Clamped B-spline sampling (de Boor) — only for hatch SPLINE EDGES, where
   the boundary must become a polygonal loop. SPLINE entities themselves
   keep their control data exactly. */
const sampleBSpline = (
  ctrl: Point2[], degree: number, knots: number[] | null, samples: number
): Point2[] => {
  const n = ctrl.length;
  const p = Math.max(1, Math.min(degree || 3, n - 1));
  let U = knots && knots.length === n + p + 1 ? knots.slice() : null;
  if (!U) {
    U = [];
    for (let i = 0; i < n + p + 1; i++) U.push(i <= p ? 0 : (i >= n ? n - p : i - p));
  }
  const u0 = U[p], u1 = U[n];
  const out: Point2[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = u0 + (u1 - u0) * (s / samples);
    let k = p;
    for (let i = p; i < n; i++) { if (u >= U[i] && u <= U[i + 1] && U[i + 1] > U[i]) { k = i; break; } }
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
    out.push(d[p]);
  }
  return out;
};

/** Read an ASCII or binary DXF. Accepts text, or raw bytes (binary DXF is
 *  detected by its sentinel; anything else is decoded as text). */
export const readDxf = (text: string | Uint8Array): Drawing => {
  const drawing: Drawing = {
    header: {},
    layers: [],
    linetypes: [],
    textStyles: [],
    blocks: {},
    entities: [],
    warnings: []
  };
  const warnings = drawing.warnings;
  const layerByName: Record<string, Layer> = Object.create(null);
  const kept: Record<string, number> = Object.create(null);
  const paperSet = new Set<Entity>();
  /* IMAGE/WIPEOUT entities waiting for their IMAGEDEF path (OBJECTS section
     may come after ENTITIES; resolved at the end). */
  const pendingImages: { e: ImageEntity; defHandle: string }[] = [];
  const pendingUnderlays: { e: UnderlayEntity; defHandle: string }[] = [];
  const underlayDefs = new Map<string, { path: string; itemName: string }>();
  const imageDefPaths = new Map<string, string>();
  /* CLASSES records by class id — the first CLASS in the section is 500 —
     so a proxy's group 91 resolves back to the application's naming. */
  const proxyClassById =
    new Map<number, { dxfName: string; cppName: string; appName: string }>();
  /* Which name each DICTIONARY lists a handle under: how a proxy object
     gets its dictionary name back after the OBJECTS section is parsed. */
  const dictEntryName = new Map<string, string>();
  /* SORTENTSTABLE draw-order tables, applied once the entity runs are
     placed (OBJECTS may precede ENTITIES). */
  const sortTables: { ents: string[]; sorts: string[] }[] = [];
  /* BLOCK_RECORD and STYLE names by handle: what a table cell's 340, a
     multileader's 341/344 block and 340/343 text style resolve through. */
  const blockRecordName = new Map<string, string>();
  const styleNameByHandle = new Map<string, string>();
  /* The block each BLOCK_RECORD handle defines, in the model's naming
     (the numbered extra paper spaces included), and the LAYOUT objects
     waiting to be linked to theirs once every section is in. */
  const blockNameByRecord = new Map<string, string>();
  const pendingLayouts: { l: Layout; recH: string }[] = [];
  /* style names that resolve through a dictionary (TABLESTYLE and
     MLEADERSTYLE are listed by name under the NOD), settled at the end:
     an entity inside a BLOCK is converted before OBJECTS is read */
  const pendingDictNames: { h: string; set: (name: string) => void }[] = [];

  const ensureLayer = (name: string): Layer => {
    /* names travel as \U+XXXX escapes — decode so an Arabic layer name
       comes back as Arabic, not escape soup */
    const nm = name === '' ? '0' : decodeCadText(name);
    let ly = layerByName[nm];
    if (!ly) {
      ly = { name: nm, color: { kind: 'aci', index: 7 }, on: true, frozen: false, locked: false };
      layerByName[nm] = ly;
      drawing.layers.push(ly);
    }
    return ly;
  };

  try {
    /* ---- tokenize into (code, value) pairs ---- */
    let pairs: Group[];
    if (typeof text !== 'string' && text instanceof Uint8Array && isBinaryDxf(text)) {
      pairs = binaryDxfToPairs(text);
    } else {
      let src: string;
      if (typeof text === 'string') src = text;
      else {
        /* ASCII DXF transports non-ASCII as \U+ escapes, so a byte-wise
           decode loses nothing (and avoids a DOM/Node TextDecoder dep) */
        let s = '';
        for (let k = 0; k < text.length; k += 8192) {
          s += String.fromCharCode(...text.subarray(k, Math.min(k + 8192, text.length)));
        }
        src = s;
      }
      const lines = String(src ?? '').split(/\r\n|\r|\n/);
      pairs = [];
      for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = parseInt(lines[i], 10);
        if (!isFinite(code)) { i -= 1; continue; }   /* resync on stray line */
        pairs.push([code, lines[i + 1]]);
      }
    }

    const val = (i: number): string => pairs[i][1].trim();
    const findNext0 = (i: number, name: string | null, end: number): number => {
      for (let k = i; k < end; k++) {
        if (pairs[k][0] === 0 && (!name || val(k) === name)) return k;
      }
      return end;
    };
    const collectGroups = (i: number, end: number) => {
      const type = val(i).toUpperCase();
      const g: Group[] = [];
      let k = i + 1;
      while (k < end && pairs[k][0] !== 0) { g.push([pairs[k][0], pairs[k][1]]); k++; }
      return { type, g, next: k };
    };

    /* ---- HEADER ---- */
    const parseHeader = (start: number, end: number): void => {
      const hdr = drawing.header;
      /* the UCS triples arrive as three separate header variables, so they
         are collected here and assembled once the section is done */
      let ucsOrg: Point3 | undefined, ucsX: Point3 | undefined, ucsY: Point3 | undefined;
      let pucsOrg: Point3 | undefined, pucsX: Point3 | undefined, pucsY: Point3 | undefined;
      let k = start;
      while (k < end) {
        if (pairs[k][0] !== 9) { k++; continue; }
        const name = val(k);
        const g: Group[] = [];
        k++;
        while (k < end && pairs[k][0] !== 9 && pairs[k][0] !== 0) {
          g.push([pairs[k][0], pairs[k][1]]);
          k++;
        }
        const q = G(g);
        switch (name) {
          case '$ACADVER': {
            const v = VERSION_MAP[q.str(1, '')];
            if (v) hdr.version = v;
            break;
          }
          case '$DWGCODEPAGE': hdr.codepage = q.str(3, '') || undefined; break;
          case '$INSUNITS': hdr.insUnits = q.int(70, 0); break;
          case '$EXTMIN': hdr.extMin = pt3(q, 10, 20, 30); break;
          case '$EXTMAX': hdr.extMax = pt3(q, 10, 20, 30); break;
          case '$LIMMIN': hdr.limMin = { x: q.num(10, 0), y: q.num(20, 0) }; break;
          case '$LIMMAX': hdr.limMax = { x: q.num(10, 0), y: q.num(20, 0) }; break;
          case '$LTSCALE': {
            const v = q.numOr(40);
            if (v != null && v > 0) hdr.linetypeScale = v;
            break;
          }
          /* the current coordinate system: a drawing laid out at an angle
             carries its rotation here, so it has to survive the DXF trip */
          case '$UCSORG': ucsOrg = pt3(q, 10, 20, 30); break;
          case '$UCSXDIR': ucsX = pt3(q, 10, 20, 30); break;
          case '$UCSYDIR': ucsY = pt3(q, 10, 20, 30); break;
          case '$PUCSORG': pucsOrg = pt3(q, 10, 20, 30); break;
          case '$PUCSXDIR': pucsX = pt3(q, 10, 20, 30); break;
          case '$PUCSYDIR': pucsY = pt3(q, 10, 20, 30); break;
          case '$DIMSCALE': case '$DIMASZ': case '$DIMEXO': case '$DIMDLI':
          case '$DIMEXE': case '$DIMRND': case '$DIMDLE': case '$DIMTP':
          case '$DIMTM': case '$DIMTXT': case '$DIMCEN': case '$DIMTSZ':
          case '$DIMALTF': case '$DIMLFAC': case '$DIMTVP': case '$DIMTFAC':
          case '$DIMGAP': {
            /* plain numbers, matching the DWG reader's shape — consumers
               (explodeDimension) take them as a vars record directly */
            const v = q.numOr(40);
            if (v != null) (hdr.vars ??= {})[name.slice(1)] = v;
            break;
          }
          case '$DIMDEC': case '$PDMODE': {
            const v = q.numOr(70);
            if (v != null) (hdr.vars ??= {})[name.slice(1)] = v;
            break;
          }
          case '$PDSIZE': {
            const v = q.numOr(40);
            if (v != null) (hdr.vars ??= {})[name.slice(1)] = v;
            break;
          }
          default:
            /* unknown vars kept verbatim as [code, value] pairs so the
               writer can round-trip them */
            if (g.length) (hdr.vars ??= {})[name] = g.map(([c, v]) => [c, v.trim()]);
            break;
        }
      }
      /* only a UCS that is actually turned is worth carrying: the world
         default says nothing a consumer does not already assume */
      const turned = (o?: Point3, x?: Point3, y?: Point3): boolean =>
        !!o && !!x && !!y
        && !(x.x === 1 && x.y === 0 && x.z === 0
             && y.x === 0 && y.y === 1 && y.z === 0
             && o.x === 0 && o.y === 0 && o.z === 0);
      if (turned(ucsOrg, ucsX, ucsY)) hdr.ucs = { origin: ucsOrg!, xAxis: ucsX!, yAxis: ucsY! };
      if (turned(pucsOrg, pucsX, pucsY)) hdr.pUcs = { origin: pucsOrg!, xAxis: pucsX!, yAxis: pucsY! };
    };

    /* ---- CLASSES: retained by position — class ids start at 500 with
       the first CLASS record, and proxies point back through group 91 ---- */
    const parseClasses = (start: number, end: number): void => {
      let k = findNext0(start, 'CLASS', end);
      let id = 500;
      while (k < end) {
        const rec = collectGroups(k, end);
        const q = G(rec.g);
        proxyClassById.set(id++, {
          dxfName: q.str(1, ''), cppName: q.str(2, ''), appName: q.str(3, '')
        });
        k = findNext0(rec.next, 'CLASS', end);
      }
    };

    /* ---- common entity properties ---- */
    const entityColor = (q: Q): Color => {
      const tc = q.numOr(420);
      if (tc != null) return { kind: 'rgb', rgb: tc & 0xFFFFFF };
      const aci = q.int(62, 256);
      if (aci === 0) return { kind: 'byBlock' };
      if (aci >= 1 && aci <= 255) return { kind: 'aci', index: aci };
      return { kind: 'byLayer' };            /* 256 / absent / negative */
    };

    /* XDATA: 1001 opens a group; 1010/20/30-style triplets fold to points */
    const parseXdata = (g: Group[]): XdataGroup[] | undefined => {
      const groups: XdataGroup[] = [];
      let cur: XdataGroup | null = null;
      let pendingPt: { code: number; x: number; y: number; z: number; got: number } | null = null;
      const flushPt = (): void => {
        if (pendingPt && cur) {
          cur.values.push({
            code: pendingPt.code,
            point: { x: pendingPt.x, y: pendingPt.y, z: pendingPt.z }
          });
        }
        pendingPt = null;
      };
      for (const [c, v] of g) {
        if (c < 1000) continue;
        if (c === 1001) {
          flushPt();
          cur = { appName: v.trim(), values: [] };
          groups.push(cur);
          continue;
        }
        if (!cur) { cur = { appName: 'ACAD', values: [] }; groups.push(cur); }
        if (c >= 1010 && c <= 1013) {
          flushPt();
          pendingPt = { code: c, x: parseFloat(v) || 0, y: 0, z: 0, got: 1 };
        } else if (c >= 1020 && c <= 1023 && pendingPt) {
          pendingPt.y = parseFloat(v) || 0;
        } else if (c >= 1030 && c <= 1033 && pendingPt) {
          pendingPt.z = parseFloat(v) || 0;
          flushPt();
        } else {
          flushPt();
          const num = (c >= 1040 && c <= 1042) || c === 1070 || c === 1071;
          cur.values.push({ code: c, value: num ? (parseFloat(v) || 0) : v });
        }
      }
      flushPt();
      return groups.length ? groups : undefined;
    };

    const baseProps = (q: Q) => {
      const layer = ensureLayer(q.str(8, '0')).name;
      const p: { handle?: string; layer: string; color: Color; linetype?: string;
                 lineweight?: number; linetypeScale?: number; invisible?: boolean;
                 extrusion?: Point3; xdata?: XdataGroup[] } =
        { layer, color: entityColor(q) };
      /* the OCS normal: only kept when it is not the default (0,0,1) */
      if (q.numOr(210) != null) {
        const n = pt3(q, 210, 220, 230);
        if (Math.abs(n.x) > 1e-12 || Math.abs(n.y) > 1e-12
            || Math.abs(n.z - 1) > 1e-12) {
          if (n.x || n.y || n.z) p.extrusion = n;
        }
      }
      const xd = parseXdata(q.all());
      if (xd) p.xdata = xd;
      const h = q.str(5, '');
      if (h) p.handle = h.toUpperCase();
      const lt = q.str(6, '');
      if (lt && lt.toUpperCase() !== 'BYLAYER') p.linetype = lt;
      const lw = q.int(370, -1);
      if (lw > 0) p.lineweight = lw / 100;
      const lts = q.numOr(48);
      if (lts != null && lts > 0 && Math.abs(lts - 1) > 1e-12) p.linetypeScale = lts;
      if (q.int(60, 0) === 1) p.invisible = true;
      return p;
    };

    /* ------------- HATCH: full sequential parse -------------
     * Boundaries keep their EXACT form: polyline paths keep real bulges,
     * edge paths keep their line/arc/ellipse/spline edges unsampled (a lone
     * full circle/ellipse edge collapses to that boundary kind). Pattern
     * definition lines, seeds and gradient data are all retained. */
    const parseHatch = (g: Group[], q: Q): HatchEntity => {
      const n = g.length;
      const code = (k: number): number => g[k][0];
      const num = (k: number): number => { const v = parseFloat(g[k][1]); return isFinite(v) ? v : 0; };
      const int = (k: number): number => { const v = parseInt(g[k][1], 10); return isFinite(v) ? v : 0; };

      const loops: HatchBoundary[] = [];
      const definitionLines: HatchDefLine[] = [];
      const seeds: Point2[] = [];
      let gradient: HatchGradient | undefined;
      let doubled = false;
      let styleFlag = 0, patternType = 1;
      let angle = 0, scale = 1;
      let elevation = 0;

      const simplify = (edges: HatchEdge[]): HatchBoundary => {
        if (edges.length === 1) {
          const e = edges[0];
          const full = (a0: number, a1: number): boolean =>
            Math.abs(Math.abs(a1 - a0) - TAU) < 1e-9 || a0 === a1;
          if (e.kind === 'arc' && full(e.startAngle, e.endAngle)) {
            return { kind: 'circle', center: e.center, radius: e.radius };
          }
          if (e.kind === 'ellipticalArc' && full(e.startAngle, e.endAngle)) {
            return { kind: 'ellipse', center: e.center, majorAxis: e.majorAxis, ratio: e.ratio };
          }
        }
        return { kind: 'edges', edges };
      };

      let i = 0;
      while (i < n) {
        const c = code(i);
        if (c === 30) { elevation = num(i); i++; continue; }
        if (c === 75) { styleFlag = int(i); i++; continue; }
        if (c === 76) { patternType = int(i); i++; continue; }
        if (c === 52) { angle = num(i); i++; continue; }
        if (c === 41) { const s = num(i); if (s > 0) scale = s; i++; continue; }
        if (c === 77) { doubled = int(i) !== 0; i++; continue; }
        if (c === 78) {
          /* definition lines: per line 53, 43, 44, 45, 46, 79, 49* */
          const count = int(i); i++;
          for (let k = 0; k < count && i < n; k++) {
            const dl: HatchDefLine = { angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, dashes: [] };
            /* each line opens with its 53 — a second 53 is the NEXT
               line, not another angle. Folding it in collapsed every
               multi-line pattern into one line plus zero-offset husks,
               which AutoCAD's audit erases as unrepairable hatches. */
            let seen53 = false;
            for (; i < n; i++) {
              const cc = code(i);
              if (cc === 53) {
                if (seen53) break;
                seen53 = true;
                dl.angle = num(i);
              }
              else if (cc === 43) dl.base.x = num(i);
              else if (cc === 44) dl.base.y = num(i);
              else if (cc === 45) dl.offset.x = num(i);
              else if (cc === 46) dl.offset.y = num(i);
              else if (cc === 49) dl.dashes.push(num(i));
              else if (cc === 79) { /* dash count — implied by 49s */ }
              else break;
            }
            definitionLines.push(dl);
          }
          continue;
        }
        if (c === 98) {
          const count = int(i); i++;
          for (let k = 0; k < count && i + 1 < n; k++) {
            if (code(i) === 10 && code(i + 1) === 20) {
              seeds.push({ x: num(i), y: num(i + 1) });
              i += 2;
            } else break;
          }
          continue;
        }
        if (c === 450) {
          /* gradient block: 450/451/460/461/452/462/453 (463,63,421)* 470 */
          const isGradient = int(i) !== 0; i++;
          const gr: HatchGradient = {
            name: '', angle: 0, shift: 0, tint: 0, singleColor: false, colors: []
          };
          let curShift = 0;
          for (; i < n; i++) {
            const cc = code(i);
            if (cc === 451) { /* reserved */ }
            else if (cc === 460) gr.angle = num(i);
            else if (cc === 461) gr.shift = num(i);
            else if (cc === 452) gr.singleColor = int(i) !== 0;
            else if (cc === 462) gr.tint = num(i);
            else if (cc === 453) { /* color count — implied */ }
            else if (cc === 463) curShift = num(i);
            else if (cc === 63) gr.colors.push({ shift: curShift, color: { kind: 'aci', index: int(i) } });
            else if (cc === 421) {
              const last = gr.colors[gr.colors.length - 1];
              if (last) last.color = { kind: 'rgb', rgb: int(i) & 0xFFFFFF };
            } else if (cc === 470) { gr.name = g[i][1].trim(); i++; break; }
            else break;
          }
          if (isGradient) gradient = gr;
          continue;
        }
        if (c !== 92) { i++; continue; }

        /* ---- one boundary loop ---- */
        const flag = int(i); i++;
        const lf: HatchLoopFlags = {};
        if (flag & 1) lf.external = true;
        if (flag & 4) lf.derived = true;
        if (flag & 16) lf.outermost = true;
        if (flag & 2) {
          /* polyline path: 72 hasBulge, 73 closed, 93 n, 10/20 (+42) */
          const verts: PolylineVertex[] = [];
          let closed = true;
          let cur: PolylineVertex | null = null;
          for (; i < n; i++) {
            const cc = code(i);
            if (cc === 92 || cc === 75) break;
            if (cc === 73) closed = int(i) !== 0;
            else if (cc === 10) { cur = { x: num(i), y: 0 }; verts.push(cur); }
            else if (cc === 20 && cur) cur.y = num(i);
            else if (cc === 42 && cur) { const b = num(i); if (b) cur.bulge = b; }
            else if (cc === 97) { for (i++; i < n && code(i) === 330; i++); break; }
          }
          if (verts.length >= 2) loops.push({ kind: 'polyline', vertices: verts, closed, ...lf });
          continue;
        }
        /* edge path: 93 numEdges, per edge 72 type + positional data */
        const edges: HatchEdge[] = [];
        let done = false;
        while (i < n && !done) {
          const cc = code(i);
          if (cc === 92 || cc === 75) break;
          if (cc === 97) {                   /* source objects: 97 + 330s */
            for (i++; i < n && code(i) === 330; i++);
            break;
          }
          if (cc !== 72) { i++; continue; }
          const etype = int(i); i++;
          /* collect this edge's own groups positionally */
          const take = (want: number): number | null =>
            (i < n && code(i) === want) ? num(i++) : null;
          if (etype === 1) {
            const x0 = take(10) ?? 0, y0 = take(20) ?? 0;
            const x1 = take(11) ?? 0, y1 = take(21) ?? 0;
            edges.push({ kind: 'line', start: { x: x0, y: y0 }, end: { x: x1, y: y1 } });
          } else if (etype === 2) {
            const cx = take(10) ?? 0, cy = take(20) ?? 0;
            const r = take(40) ?? 0;
            const a0 = take(50) ?? 0, a1 = take(51) ?? 360;
            const ccwv = take(73);
            edges.push({
              kind: 'arc', center: { x: cx, y: cy }, radius: r,
              startAngle: a0 * RAD, endAngle: a1 * RAD, ccw: (ccwv ?? 1) !== 0
            });
          } else if (etype === 3) {
            const cx = take(10) ?? 0, cy = take(20) ?? 0;
            const mx = take(11) ?? 0, my = take(21) ?? 0;
            const ratio = take(40) ?? 1;
            const a0 = take(50) ?? 0, a1 = take(51) ?? 360;
            const ccwv = take(73);
            edges.push({
              kind: 'ellipticalArc', center: { x: cx, y: cy },
              majorAxis: { x: mx, y: my }, ratio: ratio > 0 ? ratio : 1,
              startAngle: a0 * RAD, endAngle: a1 * RAD, ccw: (ccwv ?? 1) !== 0
            });
          } else if (etype === 4) {
            const degree = take(94) ?? 3;
            const rational = (take(73) ?? 0) !== 0;
            const periodic = (take(74) ?? 0) !== 0;
            take(95); take(96);              /* counts — implied below */
            const knots: number[] = [];
            while (i < n && code(i) === 40) knots.push(num(i++));
            const controlPoints: Point2[] = [];
            const weights: number[] = [];
            while (i < n && code(i) === 10) {
              const px = num(i++);
              const py = (i < n && code(i) === 20) ? num(i++) : 0;
              controlPoints.push({ x: px, y: py });
              if (i < n && code(i) === 42) weights.push(num(i++));
            }
            const numFit = take(97) ?? 0;
            const fitPoints: Point2[] = [];
            for (let k = 0; k < numFit && i < n && code(i) === 11; k++) {
              const px = num(i++);
              const py = (i < n && code(i) === 21) ? num(i++) : 0;
              fitPoints.push({ x: px, y: py });
            }
            take(12); take(22); take(13); take(23);   /* tangents */
            edges.push({
              kind: 'spline', degree, periodic: periodic || undefined,
              knots, controlPoints,
              weights: rational && weights.length ? weights : undefined,
              fitPoints: fitPoints.length ? fitPoints : undefined
            });
          } else {
            done = true;
          }
        }
        if (edges.length) loops.push(Object.assign(simplify(edges), lf));
      }

      const rawName = q.str(2, '');
      const solid = q.int(70, 0) === 1 || rawName.toUpperCase() === 'SOLID';
      const e: HatchEntity = {
        ...baseProps(q), type: 'hatch',
        patternName: rawName || (solid ? 'SOLID' : 'ANSI31'),
        solid,
        angle: solid ? 0 : angle,
        scale: solid ? 1 : scale,
        loops
      };
      if (elevation) e.elevation = elevation;
      if (q.int(71, 0) === 1) e.associative = true;
      if (styleFlag) e.styleFlag = styleFlag;
      e.patternType = patternType;
      if (doubled) e.doubled = true;
      if (definitionLines.length) e.definitionLines = definitionLines;
      if (seeds.length) e.seeds = seeds;
      if (gradient) e.gradient = gradient;
      const ps = q.numOr(47);
      if (ps != null) e.pixelSize = ps;
      return e;
    };

    /* ---- entity conversion ---- */
    const textJust = (e: TextEntity, ha: number, va: number, q: Q): void => {
      if (ha >= 1 && ha <= 5) e.halign = H_ALIGNS[ha];
      if (va >= 1 && va <= 3) e.valign = V_ALIGNS[va];
      if (ha || va) e.alignmentPoint = pt3(q, 11, 21, 31);
      const wf = q.numOr(41);
      if (wf != null && wf > 0 && wf !== 1) e.widthFactor = wf;
      const ob = q.numOr(51);
      if (ob != null && ob !== 0) e.oblique = ob * RAD;
      const st = q.str(7, '');
      if (st) e.style = st;
    };

    const attribText = (
      g: Group[], kind: 'attrib' | 'attdef'
    ): TextEntity => {
      const q = G(g);
      const h = q.num(40, 5);
      const e: TextEntity = {
        ...baseProps(q),
        type: 'text',
        position: pt3(q, 10, 20, 30),
        text: decodeCadText(q.str(1, '')),
        height: h > 0 ? h : 5,
        rotation: q.num(50, 0) * RAD
      };
      /* ATTRIB vertical justification is group 74 (not 73) */
      textJust(e, q.int(72, 0), q.int(74, 0), q);
      e.attribute = kind;
      const flags = q.int(70, 0);
      if ((flags & 1) === 1) e.invisible = true;
      if ((flags & 2) === 2) e.constant = true;
      return e;
    };

    /* recognized but not modeled: kept, not lost. Beyond the common
       properties (which are read FROM the groups, never consumed), the
       record's raw tags are retained verbatim — group code and value
       string exactly as tokenized — so the DXF writer can re-emit the
       record untouched. This is the DXF-medium twin of the DWG side's
       bit-sealed retention. */
    const sealUnknown = (type: string, g: Group[], q: Q): UnknownEntity => {
      kept[type] = (kept[type] ?? 0) + 1;
      const u: UnknownEntity =
        { ...baseProps(q), type: 'unknown', sourceType: type };
      if (g.length) u.tags = g.map(([c, v]): Group => [c, v]);
      return u;
    };

    /* ------------- ACAD_TABLE, in the reference's spelling -------------
     * A block-reference prologue (2 names the geometry block, 10 the
     * insertion point), then AcDbTable: 342 the style, 11 the row
     * direction, 91 rows and 92 columns, one 141 per row height, one
     * 142 per column width, and the cells row by row, each opened by its
     * 171 type (1 text, 2 block). Inside a cell 175/176 are the merge
     * extents in columns/rows (a cell merged INTO another carries 173),
     * 170 the alignment, 140 a text height, 340 the block record, and
     * the text comes either as 3-chunked group 1 (older files) or inside
     * the 301 CELL_VALUE … 304 ACVALUE_END block (R2008 on) — 1 the raw
     * string, 302 its formatted form. Positional throughout: a 91 inside
     * a cell is an override flag, not the row count. */
    const parseTableEntity = (g: Group[], q: Q): TableEntity | null => {
      let inTable = false;
      let numRows = 0, numColumns = 0;
      const rowHeights: number[] = [], columnWidths: number[] = [];
      const cells: TableCell[] = [];
      let cell: TableCell | null = null;
      let inValue = false;
      let chunks = '';
      let styleHandle = '';
      let dir: Point3 | undefined;
      for (const [c, v] of g) {
        if (c === 100) { inTable = /^AcDbTable$/i.test(v.trim()); continue; }
        if (!inTable) continue;
        const nv = parseFloat(v);
        if (c === 171) {
          cell = {};
          const t = parseInt(v, 10);
          if (t === 1 || t === 2) cell.contentType = t;
          cells.push(cell);
          inValue = false;
          chunks = '';
          continue;
        }
        if (!cell) {
          if (c === 91 && !numRows) numRows = parseInt(v, 10) || 0;
          else if (c === 92 && !numColumns) numColumns = parseInt(v, 10) || 0;
          else if (c === 141) rowHeights.push(isFinite(nv) ? nv : 0);
          else if (c === 142) columnWidths.push(isFinite(nv) ? nv : 0);
          else if (c === 342) styleHandle = v.trim().toUpperCase();
          else if (c === 11) dir = { x: isFinite(nv) ? nv : 1, y: 0, z: 0 };
          else if (c === 21 && dir) dir.y = isFinite(nv) ? nv : 0;
          else if (c === 31 && dir) dir.z = isFinite(nv) ? nv : 0;
          continue;
        }
        if (c === 301) { inValue = /CELL_VALUE/i.test(v); continue; }
        if (c === 304 && /ACVALUE_END/i.test(v)) { inValue = false; continue; }
        if (c === 175) { const n = parseInt(v, 10); if (n > 1) cell.spanColumns = n; }
        else if (c === 176) { const n = parseInt(v, 10); if (n > 1) cell.spanRows = n; }
        else if (c === 170) { const n = parseInt(v, 10); if (isFinite(n)) cell.alignment = n; }
        else if (c === 140) { if (nv > 0) cell.textHeight = nv; }
        else if (c === 340) {
          const nm = blockRecordName.get(v.trim().toUpperCase());
          if (nm) cell.blockName = nm;
        } else if (c === 3) chunks += v;
        else if (c === 1) {
          const t = decodeCadText(chunks + v);
          chunks = '';
          if (t) cell.text = t;
        } else if (c === 302 && inValue && cell.text === undefined && v.trim()) {
          cell.text = decodeCadText(v);
        }
      }
      if (!(numRows > 0) || !(numColumns > 0) || numRows * numColumns > 1e6) return null;
      /* every cell and size exists, whatever the record spelled out */
      while (cells.length < numRows * numColumns) cells.push({});
      cells.length = numRows * numColumns;
      while (rowHeights.length < numRows) rowHeights.push(rowHeights[rowHeights.length - 1] ?? 1);
      while (columnWidths.length < numColumns) columnWidths.push(columnWidths[columnWidths.length - 1] ?? 1);
      const e: TableEntity = {
        ...baseProps(q), type: 'table',
        position: pt3(q, 10, 20, 30),
        numRows, numColumns, rowHeights, columnWidths, cells
      };
      if (dir) e.direction = dir;
      const bn = decodeCadText(q.str(2, ''));
      if (bn) e.blockName = bn;
      if (styleHandle) pendingDictNames.push({ h: styleHandle, set: (nm) => { e.styleName = nm; } });
      return e;
    };

    /* ------------- MULTILEADER, in the reference's spelling -------------
     * After AcDbMLeader the record is a tree of fenced blocks: 300
     * CONTEXT_DATA{ … 301 } holds the scale (40), text height (41),
     * arrow size (140), the text (290 flag, 304 contents, 340 style, 12
     * position, 42 rotation) or the block (296 flag, 341 record, 15
     * position, 16 scale, 46 rotation), and one 302 LEADER{ … 303 } per
     * leader — its landing point (10), dogleg vector (11) and length
     * (40) — with a 304 LEADER_LINE{ … 305 } per line whose points are
     * 10/20/30 runs. The groups after the context repeat the style-level
     * facts: 340 the MLEADERSTYLE, 290/291 the landing and dogleg
     * switches, 42 the arrow size, 343 the text style, 344 the block. */
    const parseMLeader = (g: Group[], q: Q): MLeaderEntity | null => {
      const e: MLeaderEntity = { ...baseProps(q), type: 'mleader', leaders: [] };
      let state: 'top' | 'ctx' | 'leader' | 'line' = 'top';
      let inBody = false;
      let leader: MLeaderLeader | null = null;
      let line: Point3[] | null = null;
      let pt: Point3 | null = null;
      let styleHandle = '', textStyleHandle = '', blockHandle = '';
      let hasText: boolean | undefined, hasBlock: boolean | undefined;
      let text: string | undefined;
      const num = (v: string): number => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
      for (const [c, v] of g) {
        if (c === 100) { inBody = /AcDbMLeader/i.test(v); continue; }
        if (!inBody) continue;
        const s = v.trim();
        if (c === 300 && /^CONTEXT_DATA\{/i.test(s)) { state = 'ctx'; continue; }
        if (c === 302 && /^LEADER\{/i.test(s)) {
          leader = { lines: [] };
          e.leaders.push(leader);
          state = 'leader';
          continue;
        }
        if (c === 304 && /^LEADER_LINE\{/i.test(s)) { line = []; pt = null; state = 'line'; continue; }
        if (s === '}') {
          if (c === 305 && state === 'line') {
            if (leader && line && line.length) leader.lines.push(line);
            line = null; state = 'leader'; continue;
          }
          if (c === 303 && state === 'leader') { leader = null; state = 'ctx'; continue; }
          if (c === 301 && state === 'ctx') { state = 'top'; continue; }
        }
        switch (state) {
          case 'line':
            if (c === 10) { pt = { x: num(v), y: 0, z: 0 }; line!.push(pt); }
            else if (c === 20 && pt) pt.y = num(v);
            else if (c === 30 && pt) pt.z = num(v);
            break;
          case 'leader':
            if (!leader) break;
            if (c === 10) leader.landing = { x: num(v), y: 0, z: 0 };
            else if (c === 20 && leader.landing) leader.landing.y = num(v);
            else if (c === 30 && leader.landing) leader.landing.z = num(v);
            else if (c === 11) leader.doglegVector = { x: num(v), y: 0, z: 0 };
            else if (c === 21 && leader.doglegVector) leader.doglegVector.y = num(v);
            else if (c === 31 && leader.doglegVector) leader.doglegVector.z = num(v);
            else if (c === 40) { const d = num(v); if (d) leader.doglegLength = d; }
            break;
          case 'ctx':
            if (c === 40) { const sc = num(v); if (sc > 0) e.scale = sc; }
            else if (c === 41) { const h = num(v); if (h > 0) e.textHeight = h; }
            else if (c === 140) { const a = num(v); if (a > 0) e.arrowSize = a; }
            else if (c === 290) hasText = parseInt(v, 10) === 1;
            else if (c === 304) text = (text ?? '') + v;
            else if (c === 340) textStyleHandle = s.toUpperCase();
            else if (c === 12) e.textPosition = { x: num(v), y: 0, z: 0 };
            else if (c === 22 && e.textPosition) e.textPosition.y = num(v);
            else if (c === 32 && e.textPosition) e.textPosition.z = num(v);
            else if (c === 42) { const r = num(v); if (r) e.textRotation = r; }
            else if (c === 296) hasBlock = parseInt(v, 10) === 1;
            else if (c === 341) blockHandle = s.toUpperCase();
            else if (c === 15) e.blockPosition = { x: num(v), y: 0, z: 0 };
            else if (c === 25 && e.blockPosition) e.blockPosition.y = num(v);
            else if (c === 35 && e.blockPosition) e.blockPosition.z = num(v);
            else if (c === 16) e.blockScale = { x: num(v), y: 1, z: 1 };
            else if (c === 26 && e.blockScale) e.blockScale.y = num(v);
            else if (c === 36 && e.blockScale) e.blockScale.z = num(v);
            else if (c === 46) { const r = num(v); if (r) e.blockRotation = r; }
            break;
          default:
            if (c === 340) styleHandle = s.toUpperCase();
            else if (c === 290) { if (parseInt(v, 10) === 1) e.hasLanding = true; }
            else if (c === 291) { if (parseInt(v, 10) === 1) e.hasDogleg = true; }
            else if (c === 42 && e.arrowSize === undefined) {
              const a = num(v);
              if (a > 0) e.arrowSize = a;
            } else if (c === 343 && !textStyleHandle) textStyleHandle = s.toUpperCase();
            else if (c === 344 && !blockHandle) blockHandle = s.toUpperCase();
            break;
        }
      }
      if (text !== undefined && hasText !== false) e.text = decodeCadText(text);
      if (blockHandle && hasBlock !== false) {
        const nm = blockRecordName.get(blockHandle);
        if (nm) e.blockName = nm;
      }
      if (textStyleHandle) {
        const nm = styleNameByHandle.get(textStyleHandle);
        if (nm) e.textStyle = nm;
      }
      if (styleHandle) pendingDictNames.push({ h: styleHandle, set: (nm) => { e.styleName = nm; } });
      if (!e.leaders.length && e.text === undefined && !e.blockName) return null;
      return e;
    };

    const convertEntity = (type: string, g: Group[]): Entity | null => {
      const q = G(g);
      switch (type) {
        case 'LINE':
        case '3DLINE':                     /* the pre-R13 spelling */
          return { ...baseProps(q), type: 'line', start: pt3(q, 10, 20, 30), end: pt3(q, 11, 21, 31) };

        case 'POINT':
          return { ...baseProps(q), type: 'point', position: pt3(q, 10, 20, 30) };

        case 'RAY': case 'XLINE':
          return {
            ...baseProps(q), type: type === 'RAY' ? 'ray' : 'xline',
            basePoint: pt3(q, 10, 20, 30), direction: pt3(q, 11, 21, 31)
          };

        case 'LWPOLYLINE': {
          /* positional walk: 40/41/42/91 belong to the vertex opened by
             the preceding 10 */
          const vertices: PolylineVertex[] = [];
          let cur: PolylineVertex | null = null;
          for (const [c, v] of g) {
            const nv = parseFloat(v);
            if (c === 10) { cur = { x: isFinite(nv) ? nv : 0, y: 0 }; vertices.push(cur); }
            else if (c === 20 && cur) cur.y = isFinite(nv) ? nv : 0;
            else if (c === 40 && cur && isFinite(nv)) cur.startWidth = nv;
            else if (c === 41 && cur && isFinite(nv)) cur.endWidth = nv;
            else if (c === 42 && cur && isFinite(nv) && nv !== 0) cur.bulge = nv;
            else if (c === 91 && cur && isFinite(nv) && nv !== 0) cur.id = nv;
          }
          if (vertices.length < 2) return null;
          const lwFlag = q.int(70, 0);
          const e: PolylineEntity = {
            ...baseProps(q), type: 'polyline', vertices,
            closed: (lwFlag & 1) === 1
          };
          if (lwFlag & 128) e.plineGen = true;
          const cw = q.numOr(43);
          if (cw != null && cw > 0) e.constantWidth = cw;
          const el = q.numOr(38);
          if (el != null && el !== 0) e.elevation = el;
          return e;
        }

        case 'CIRCLE': {
          /* a degenerate radius is kept as the file states it: dropping
             the entity loses data, and clamping it invents geometry */
          const r = q.num(40, 0);
          if (!isFinite(r)) return null;
          return {
            ...baseProps(q), type: 'circle',
            center: pt3(q, 10, 20, 30), radius: Math.abs(r)
          };
        }

        case 'ARC': {
          const r = q.num(40, 0);
          if (!isFinite(r)) return null;
          return {
            ...baseProps(q), type: 'arc', center: pt3(q, 10, 20, 30),
            radius: Math.abs(r),
            startAngle: q.num(50, 0) * RAD, endAngle: q.num(51, 360) * RAD
          };
        }

        case 'ELLIPSE': {
          /* kept exactly as stored: center / major axis / ratio / params —
             partial ellipses are NOT sampled into polylines */
          const majorAxis = pt3(q, 11, 21, 31);
          if (!(Math.hypot(majorAxis.x, majorAxis.y, majorAxis.z) > 0)) return null;
          const ratio = q.num(40, 1);
          return {
            ...baseProps(q), type: 'ellipse', center: pt3(q, 10, 20, 30),
            majorAxis, ratio: ratio > 0 ? ratio : 1,
            startParam: q.num(41, 0), endParam: q.num(42, TAU)
          };
        }

        case 'SPLINE': {
          /* degree/knots/control points/weights/fit points kept exactly —
             no sampling on read */
          const flags = q.int(70, 0);
          const controlPoints = zip3(q.nums(10), q.nums(20), q.nums(30));
          const fitPoints = zip3(q.nums(11), q.nums(21), q.nums(31));
          if (controlPoints.length < 2 && fitPoints.length < 2) return null;
          const weights = q.nums(41);
          const e: SplineEntity = {
            ...baseProps(q), type: 'spline',
            degree: q.int(71, 3),
            closed: (flags & 1) === 1,
            controlPoints,
            knots: q.nums(40)
          };
          if (weights.length) e.weights = weights;
          if (fitPoints.length) e.fitPoints = fitPoints;
          return e;
        }

        case 'TEXT': {
          const h = q.num(40, 5);
          const e: TextEntity = {
            ...baseProps(q), type: 'text',
            position: pt3(q, 10, 20, 30),
            text: decodeCadText(q.str(1, '')),
            height: h > 0 ? h : 5,
            rotation: q.num(50, 0) * RAD
          };
          textJust(e, q.int(72, 0), q.int(73, 0), q);
          return e;
        }

        case 'MTEXT': {
          /* MTEXT stays MTEXT — no collapsing to single-line text */
          const raw = q.rawAll(3).concat(q.rawAll(1)).join('');
          const h = q.num(40, 5);
          const e: MTextEntity = {
            ...baseProps(q), type: 'mtext',
            position: pt3(q, 10, 20, 30),
            text: decodeCadText(stripMtextCodes(raw)),
            height: h > 0 ? h : 5,
            rotation: q.num(50, 0) * RAD
          };
          if (/[\\{}]/.test(raw)) e.raw = raw;
          const wd = q.numOr(41);              /* reference column width */
          if (wd != null && wd > 0) e.width = wd;
          const ap = q.int(71, 0);
          if (ap >= 1 && ap <= 9) e.attachment = ap;
          const st = q.str(7, '');
          if (st) e.style = st;
          return e;
        }

        case 'SOLID':
        case 'TRACE': {                    /* a TRACE is a four-corner solid */
          const c3 = pt3(q, 12, 22, 32);
          const c4: Point3 = {
            x: q.num(13, c3.x), y: q.num(23, c3.y), z: q.num(33, c3.z)
          };
          return {
            ...baseProps(q), type: 'solid',
            corners: [pt3(q, 10, 20, 30), pt3(q, 11, 21, 31), c3, c4]
          };
        }

        case 'HATCH': {
          /* ALL loops are kept exactly — islands, edges, gradient, pattern */
          const e = parseHatch(g, q);
          if (!e.loops.length) {
            warnings.push('HATCH with unsupported boundary skipped.');
            return null;
          }
          return e;
        }

        case '3DFACE': {
          const c3 = pt3(q, 12, 22, 32);
          const c4: Point3 = {
            x: q.num(13, c3.x), y: q.num(23, c3.y), z: q.num(33, c3.z)
          };
          const e: Face3DEntity = {
            ...baseProps(q), type: 'face3d',
            corners: [pt3(q, 10, 20, 30), pt3(q, 11, 21, 31), c3, c4]
          };
          const inv = q.int(70, 0);
          if (inv) e.invisibleEdges = inv;
          return e;
        }

        case 'SHAPE': {
          const e: ShapeEntity = {
            ...baseProps(q), type: 'shape',
            position: pt3(q, 10, 20, 30),
            size: q.num(40, 1),
            rotation: q.num(50, 0) * RAD
          };
          const nm = q.str(2, '');
          if (nm) e.name = nm;
          const wf = q.numOr(41);
          if (wf != null && wf > 0 && wf !== 1) e.widthFactor = wf;
          const ob = q.numOr(51);
          if (ob != null && ob !== 0) e.oblique = ob * RAD;
          return e;
        }

        case 'TOLERANCE':
          /* ^J is DXF's caret encoding for an embedded newline in FCF text */
          return {
            ...baseProps(q), type: 'tolerance',
            position: pt3(q, 10, 20, 30),
            xDirection: pt3(q, 11, 21, 31),
            text: decodeCadText(q.str(1, '').replace(/\^J/g, '\n'))
          } as ToleranceEntity;

        case 'MLINE': {
          /* positional walk: 11 opens a vertex, 74/75 open param runs */
          const vertices: MLineVertex[] = [];
          let cur: MLineVertex | null = null;
          let curLine: { segparms: number[]; areaFillParms?: number[] } | null = null;
          let fillRun = false;
          for (const [c, v] of g) {
            const nv = parseFloat(v);
            if (c === 11) {
              cur = {
                position: { x: isFinite(nv) ? nv : 0, y: 0, z: 0 },
                direction: { x: 1, y: 0, z: 0 },
                miterDirection: { x: 0, y: 1, z: 0 },
                lines: []
              };
              vertices.push(cur);
              curLine = null;
            } else if (!cur) continue;
            else if (c === 21) cur.position.y = nv || 0;
            else if (c === 31) cur.position.z = nv || 0;
            else if (c === 12) cur.direction.x = nv || 0;
            else if (c === 22) cur.direction.y = nv || 0;
            else if (c === 32) cur.direction.z = nv || 0;
            else if (c === 13) cur.miterDirection.x = nv || 0;
            else if (c === 23) cur.miterDirection.y = nv || 0;
            else if (c === 33) cur.miterDirection.z = nv || 0;
            else if (c === 74) { curLine = { segparms: [] }; cur.lines.push(curLine); fillRun = false; }
            else if (c === 75) fillRun = true;
            else if (c === 41 && curLine) curLine.segparms.push(nv || 0);
            else if (c === 42 && curLine) {
              (curLine.areaFillParms ??= []).push(nv || 0);
              void fillRun;
            }
          }
          if (vertices.length < 2) return null;
          const e: MLineEntity = {
            ...baseProps(q), type: 'mline',
            styleName: q.str(2, '') || undefined,
            scale: q.num(40, 1),
            justification: q.int(70, 0),
            basePoint: pt3(q, 10, 20, 30),
            vertices
          };
          if ((q.int(71, 0) & 2) !== 0) e.closed = true;
          return e;
        }

        case 'MESH': {
          /* AcDbSubDMesh: control points, then a flat (count, index...) run */
          const numVertex = q.int(92, 0);
          const xs = q.nums(10), ys = q.nums(20), zs = q.nums(30);
          const vertices: Point3[] = [];
          for (let i = 0; i < Math.min(numVertex, xs.length); i++) {
            vertices.push({ x: xs[i], y: ys[i] ?? 0, z: zs[i] ?? 0 });
          }
          if (!vertices.length) return null;
          const flat = q.nums(90);
          const faces: number[][] = [];
          for (let i = 0; i < flat.length;) {
            const n = flat[i++];
            if (n <= 0 || i + n > flat.length) break;
            faces.push(flat.slice(i, i + n).map((idx) => idx + 1));
            i += n;
          }
          const mesh: MeshEntity = {
            ...baseProps(q), type: 'mesh', meshKind: 'subd', vertices
          };
          if (faces.length) mesh.faces = faces;
          const level = q.int(91, 0);
          if (level) mesh.subdivisionLevel = level;
          return mesh;
        }

        case 'REGION':
        case '3DSOLID':
        case 'BODY':
        case 'PLANESURFACE':
        case 'EXTRUDEDSURFACE':
        case 'LOFTEDSURFACE':
        case 'REVOLVEDSURFACE':
        case 'SWEPTSURFACE':
        case 'NURBSURFACE': {
          /* SAT text: group 1 opens a line, group 3 continues it. DXF
             stores it with the same (159 - c) cipher as DWG; plain text
             from other producers (starts with a digit) passes through. */
          const lines: string[] = [];
          for (const [c, v] of g) {
            if (c === 1) lines.push(v);
            else if (c === 3 && lines.length) lines[lines.length - 1] += v;
          }
          let sat = lines.length ? lines.join('\n') : undefined;
          if (sat && !/^\d/.test(sat)) {
            let plain = '';
            for (let k = 0; k < sat.length; k++) {
              const ch = sat.charCodeAt(k);
              plain += String.fromCharCode(ch <= 32 || ch > 126 ? ch : 159 - ch);
            }
            sat = plain;
          }
          const SURFACES: Record<string, AcisEntity['surfaceKind']> = {
            PLANESURFACE: 'plane', EXTRUDEDSURFACE: 'extruded',
            LOFTEDSURFACE: 'lofted', REVOLVEDSURFACE: 'revolved',
            SWEPTSURFACE: 'swept', NURBSURFACE: 'nurb'
          };
          const surfaceKind = SURFACES[type];
          /* R2007+ writes the kernel data as binary chunks instead */
          const hex = q.rawAll(310).join('').replace(/[^0-9A-Fa-f]/g, '');
          let sab: string | undefined;
          if (hex.length > 1) {
            let bin = '';
            for (let i = 0; i + 1 < hex.length; i += 2) {
              bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
            }
            sab = btoa(bin);
          }
          const e: AcisEntity = {
            ...baseProps(q), type: 'acis',
            kind: surfaceKind ? 'surface'
              : type === 'REGION' ? 'region'
              : type === '3DSOLID' ? 'solid3d' : 'body',
            sat, sab
          };
          if (surfaceKind) e.surfaceKind = surfaceKind;
          const u = q.numOr(71), vIso = q.numOr(72);
          if (surfaceKind && u != null && vIso != null) {
            e.isolines = { u, v: vIso };
          }
          return e;
        }

        case 'OLE2FRAME':
        case 'OLEFRAME': {
          /* the placement points bound the frame; the 310 chunks are the
             embedded document, kept byte for byte */
          const ul = pt3(q, 10, 20, 30);
          const lr = pt3(q, 11, 21, 31);
          const hex = q.rawAll(310).join('').replace(/[^0-9A-Fa-f]/g, '');
          const data = new Uint8Array(hex.length >> 1);
          for (let i = 0; i < data.length; i++) {
            data[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          }
          return {
            ...baseProps(q), type: 'ole',
            oleType: q.int(71, 2),
            tileMode: q.numOr(72) ?? undefined,
            lockAspect: q.int(73, 0) === 1 || undefined,
            corners: [
              ul, { x: lr.x, y: ul.y, z: ul.z },
              lr, { x: ul.x, y: lr.y, z: lr.z }
            ],
            data: data.length ? data : undefined
          };
        }

        case 'IMAGE':
        case 'WIPEOUT': {
          const e: ImageEntity = {
            ...baseProps(q), type: 'image',
            wipeout: type === 'WIPEOUT' || undefined,
            position: pt3(q, 10, 20, 30),
            uVector: pt3(q, 11, 21, 31),
            vVector: pt3(q, 12, 22, 32),
            widthPx: q.num(13, 0),
            heightPx: q.num(23, 0)
          };
          const defRef = q.str(340, '');
          if (defRef) pendingImages.push({ e, defHandle: defRef.toUpperCase() });
          const br = q.numOr(281), co = q.numOr(282), fa = q.numOr(283);
          if (br != null && br !== 50) e.brightness = br;
          if (co != null && co !== 50) e.contrast = co;
          if (fa != null && fa !== 0) e.fade = fa;
          const cx = q.nums(14), cy = q.nums(24);
          if (cx.length >= 2 && cx.length === cy.length) {
            const clip = cx.map((x, k) => ({ x, y: cy[k] }));
            /* DXF closes a polygonal boundary by repeating the first
               vertex; the DWG record stores the ring open. Drop the
               duplicate so both readers hand back the same ring (the
               DXF writer re-closes on output). */
            const a = clip[0], b = clip[clip.length - 1];
            if (clip.length > 2 && a.x === b.x && a.y === b.y) clip.pop();
            e.clip = clip;
          }
          if (q.int(290, 0) === 1) e.clipInverted = true;
          return e;
        }

        case 'PDFUNDERLAY':
        case 'DGNUNDERLAY':
        case 'DWFUNDERLAY': {
          const e: UnderlayEntity = {
            ...baseProps(q), type: 'underlay',
            underlayKind: type === 'PDFUNDERLAY' ? 'pdf'
              : type === 'DGNUNDERLAY' ? 'dgn' : 'dwf',
            position: pt3(q, 10, 20, 30),
            scale: { x: q.num(41, 1), y: q.num(42, 1), z: q.num(43, 1) },
            rotation: q.num(50, 0) * RAD
          };
          const fl = q.numOr(280), co = q.numOr(281), fa = q.numOr(282);
          if (fl != null) e.flags = fl;
          if (co != null) e.contrast = co;
          if (fa != null) e.fade = fa;
          const cx = q.nums(11), cy = q.nums(21);
          if (cx.length >= 2 && cx.length === cy.length) {
            e.clip = cx.map((x, k) => ({ x, y: cy[k] }));
          }
          const defRef = q.str(340, '');
          if (defRef) {
            pendingUnderlays.push({ e, defHandle: defRef.toUpperCase() });
          }
          return e;
        }

        case 'INSERT': {
          const nm = decodeCadText(q.str(2, ''));
          if (!nm) return null;
          return {
            ...baseProps(q), type: 'insert', blockName: nm,
            position: pt3(q, 10, 20, 30),
            scale: { x: q.num(41, 1), y: q.num(42, 1), z: q.num(43, 1) },
            rotation: q.num(50, 0) * RAD
          };
        }

        case 'ARC_DIMENSION':
        case 'DIMENSION': {
          /* the dimension survives as itself, carrying full geometry and
             the name of the anonymous block with its rendered form */
          const dimType = q.int(70, 0);
          const subclasses = g.filter(([c]) => c === 100).map(([, v]) => v.trim());
          const KIND_BY_BASE: DimensionKind[] = [
            'linear', 'aligned', 'angular2ln', 'diameter',
            'radius', 'angular3pt', 'ordinate'
          ];
          let kind: DimensionKind | undefined = KIND_BY_BASE[dimType & 7];
          if (type === 'ARC_DIMENSION' || subclasses.includes('AcDbArcDimension')) kind = 'arc';
          const e: DimensionEntity = {
            ...baseProps(q), type: 'dimension',
            kind,
            dimensionType: dimType,
            definitionPoint: pt3(q, 10, 20, 30)
          };
          const nm = decodeCadText(q.str(2, ''));
          if (nm) e.blockName = nm;
          if (q.numOr(11) != null) e.textMidpoint = pt3(q, 11, 21, 31);
          if (q.numOr(12) != null) e.insertionPoint = pt3(q, 12, 22, 32);
          if (q.numOr(13) != null) e.point13 = pt3(q, 13, 23, 33);
          if (q.numOr(14) != null) e.point14 = pt3(q, 14, 24, 34);
          if (q.numOr(15) != null) e.point15 = pt3(q, 15, 25, 35);
          if (q.numOr(16) != null) e.point16 = pt3(q, 16, 26, 36);
          const m = q.numOr(42);
          if (m != null) e.measurement = m;
          const t = q.str(1, '');
          if (t) e.text = decodeCadText(t);
          const rot = q.numOr(50);
          if (rot != null && rot !== 0) e.rotation = rot * RAD;
          const obl = q.numOr(52);
          if (obl != null && obl !== 0) e.obliqueAngle = obl * RAD;
          const trot = q.numOr(53);
          if (trot != null && trot !== 0) e.textRotation = trot * RAD;
          const hd = q.numOr(51);
          if (hd != null && hd !== 0) e.horizDirection = hd * RAD;
          const att = q.int(71, 0);
          if (att) e.attachment = att;
          const lss = q.int(72, 0);
          if (lss) e.lineSpacingStyle = lss;
          const lsf = q.numOr(41);
          if (lsf != null && lsf > 0 && lsf !== 1) e.lineSpacingFactor = lsf;
          const ll = q.numOr(40);
          if (ll != null && ll !== 0) e.leaderLength = ll;
          const st = q.str(3, '');
          if (st && st !== 'Standard') e.style = st;
          return e;
        }

        case 'LEADER': {
          const vertices = zip3(q.nums(10), q.nums(20), q.nums(30));
          if (vertices.length < 2) return null;
          const e: LeaderEntity = { ...baseProps(q), type: 'leader', vertices };
          if (q.int(71, 1) === 0) e.hasArrowhead = false;
          const annType = q.int(73, 3);
          const ann = q.str(340, '');
          if (annType !== 3 && ann && ann !== '0') {
            e.annotationType = annType;
            e.annotation = ann.toUpperCase();
          }
          return e;
        }

        case 'VIEWPORT':
          return {
            ...baseProps(q), type: 'viewport',
            center: pt3(q, 10, 20, 30),
            width: q.num(40, 0), height: q.num(41, 0),
            viewCenter: { x: q.num(12, 0), y: q.num(22, 0) },
            viewHeight: q.num(45, 0) || undefined
          };

        case 'ACAD_PROXY_ENTITY': {
          /* The sealed proxy, back from DXF: the class id resolves through
             CLASSES to the application's naming, the display list decodes
             to drawable primitives, and the opaque payload and references
             ride along untouched — so a rewrite (DXF or DWG) reproduces
             the record and the owning application still recognizes it. */
          const p = parseProxyPayload(g);
          const cls = proxyClassById.get(p.classId);
          const e: ProxyEntity = {
            ...baseProps(q), type: 'proxy',
            sourceType: cls?.dxfName || 'ACAD_PROXY_ENTITY',
            graphics: []
          };
          if (cls) e.appClass = { ...cls };
          if (p.graphics?.length) {
            e.graphicsData = bytesToB64(p.graphics);
            const shapes = decodeProxyGraphics(p.graphics, e.layer, e.color);
            if (shapes.length) e.graphics = shapes;
          }
          if (p.data?.length) {
            e.data = bytesToB64(p.data);
            e.dataBits = p.dataBits;
          }
          if (p.refs) e.refs = p.refs;
          if (p.proxyVersion !== undefined) e.proxyVersion = p.proxyVersion;
          if (p.proxyMaint !== undefined) e.proxyMaint = p.proxyMaint;
          if (p.fromDxf !== undefined) e.fromDxf = p.fromDxf;
          return e;
        }

        case 'ATTRIB':
        case 'ATTDEF':
          /* stray ATTRIB / ATTDEF template — still a text, marked */
          return attribText(g, type === 'ATTDEF' ? 'attdef' : 'attrib');

        case 'SEQEND':
          return null;                       /* skip silently */

        case 'ACAD_TABLE':
          /* a record that does not state its grid is kept sealed instead */
          return parseTableEntity(g, q) ?? sealUnknown(type, g, q);

        case 'MULTILEADER':
          return parseMLeader(g, q) ?? sealUnknown(type, g, q);

        default:
          return sealUnknown(type, g, q);
      }
    };

    /* parse a run of entities in pairs[start..end) */
    const parseEntities = (start: number, end: number): Entity[] => {
      const out: Entity[] = [];
      let i = findNext0(start, null, end);
      while (i < end) {
        const v0 = val(i);
        if (v0 === 'ENDSEC' || v0 === 'ENDBLK' || v0 === 'EOF') break;
        const rec = collectGroups(i, end);
        let entOut: Entity | null = null;
        const isPaper = G(rec.g).int(67, 0) === 1;
        if (rec.type === 'POLYLINE') {
          /* heavyweight polyline: POLYLINE + VERTEX* + SEQEND. Flag 70
             selects the flavor: 16 = polygon mesh, 64 = polyface mesh,
             otherwise a 2D/3D polyline (widths per VERTEX w/ defaults). */
          const q = G(rec.g);
          const flag = q.int(70, 0);
          const isGrid = (flag & 16) !== 0 && (flag & 64) === 0;
          const isPface = (flag & 64) !== 0;
          const closed = (flag & 1) === 1;
          const is3d = (flag & 8) !== 0 && !isGrid && !isPface;
          const splineFit = (flag & 4) !== 0;
          const dsw = q.num(40, 0), dew = q.num(41, 0);
          const vertices: PolylineVertex[] = [];
          /* a spline-fit polyline's frame (VERTEX 70 = 16) is kept apart
             from the fitted curve (8) it draws */
          const frame: PolylineVertex[] = [];
          const meshVerts: Point3[] = [];
          const faces: number[][] = [];
          let k = rec.next;
          while (k < end && pairs[k][0] === 0 && val(k) === 'VERTEX') {
            const vr = collectGroups(k, end);
            const vq = G(vr.g);
            const vflag = vq.int(70, 0);
            if (isPface && (vflag & 128) !== 0 && (vflag & 64) === 0) {
              /* face record: 71..74 are 1-based indices, negative=invisible */
              const f = [vq.int(71, 0), vq.int(72, 0), vq.int(73, 0), vq.int(74, 0)]
                .filter((ix) => ix !== 0);
              if (f.length) faces.push(f);   /* 1-2 index faces are legal */
            } else if (isGrid || isPface) {
              meshVerts.push({ x: vq.num(10, 0), y: vq.num(20, 0), z: vq.num(30, 0) });
            } else {
              const p: PolylineVertex = { x: vq.num(10, 0), y: vq.num(20, 0) };
              if (is3d) p.z = vq.num(30, 0);
              const b = vq.num(42, 0);
              if (isFinite(b) && b !== 0) p.bulge = b;
              const sw = vq.num(40, dsw), ew = vq.num(41, dew);
              if (sw > 0) p.startWidth = sw;
              if (ew > 0) p.endWidth = ew;
              const id = vq.int(91, 0);
              if (id) p.id = id;
              if (vflag & 1) p.curveFit = true;
              if (vflag & 2) p.tangent = vq.num(50, 0) * Math.PI / 180;
              if (splineFit && (vflag & 16)) frame.push(p); else vertices.push(p);
            }
            k = vr.next;
          }
          if (k < end && pairs[k][0] === 0 && val(k) === 'SEQEND') {
            k = collectGroups(k, end).next;
          }
          if ((isGrid || isPface) && meshVerts.length) {
            const me: MeshEntity = {
              ...baseProps(q), type: 'mesh',
              meshKind: isGrid ? 'grid' : 'faces',
              vertices: meshVerts
            };
            if (isGrid) {
              me.mSize = q.int(71, 0) || undefined;
              me.nSize = q.int(72, 0) || undefined;
              if (flag & 1) me.closedM = true;
              if (flag & 32) me.closedN = true;
            } else if (faces.length) {
              me.faces = faces;
            }
            entOut = me;
          } else if (vertices.length + frame.length >= 2) {
            const drawn = vertices.length >= 2 ? vertices : [...frame, ...vertices];
            const pe: PolylineEntity = {
              ...baseProps(q), type: 'polyline', vertices: drawn, closed,
              heavy: is3d ? '3d' : '2d'
            };
            if (vertices.length >= 2 && frame.length) pe.frame = frame;
            if (splineFit) pe.fit = q.int(75, 0) === 6 ? 'cubic' : 'quadratic';
            else if (flag & 2) pe.fit = 'curve';
            if (flag & 128) pe.plineGen = true;
            const el = q.num(30, 0);
            if (!is3d && el !== 0) pe.elevation = el;
            entOut = pe;
          }
          i = k;
        } else if (rec.type === 'INSERT') {
          /* INSERT [+ ATTRIB* + SEQEND]: attributes carry world coordinates
             and ride on the insert as text entities */
          entOut = convertEntity(rec.type, rec.g);
          const attrs: TextEntity[] = [];
          let k = rec.next;
          while (k < end && pairs[k][0] === 0 && val(k) === 'ATTRIB') {
            const ar = collectGroups(k, end);
            attrs.push(attribText(ar.g, 'attrib'));
            k = ar.next;
          }
          if (k < end && pairs[k][0] === 0 && val(k) === 'SEQEND') {
            k = collectGroups(k, end).next;
          }
          if (entOut && entOut.type === 'insert' && attrs.length) {
            entOut.attributes = attrs;
          }
          i = k;
        } else {
          entOut = convertEntity(rec.type, rec.g);
          i = rec.next;
        }
        if (entOut) {
          if (isPaper) paperSet.add(entOut);
          out.push(entOut);
        }
        i = findNext0(i, null, end);
      }
      return out;
    };

    /* ---- TABLES ---- */
    const parseTables = (start: number, end: number): void => {
      let i = findNext0(start, 'TABLE', end);
      while (i < end) {
        const tName = (pairs[i + 1] && pairs[i + 1][0] === 2) ? val(i + 1) : '';
        const tEnd = findNext0(i + 1, 'ENDTAB', end);
        let k = findNext0(i + 1, tName, tEnd);
        while (k < tEnd) {
          const rec = collectGroups(k, tEnd);
          const q = G(rec.g);
          const nm = q.str(2, '');
          if (nm !== '') {
            if (tName === 'LAYER') {
              const c62 = q.int(62, 7);
              const flags = q.int(70, 0);
              const tc = q.numOr(420);
              const aci = Math.abs(c62);
              const ly = ensureLayer(nm);
              ly.color = tc != null ? { kind: 'rgb', rgb: tc & 0xFFFFFF }
                : { kind: 'aci', index: aci >= 1 && aci <= 255 ? aci : 7 };
              ly.on = c62 >= 0;                /* negative 62 = layer off */
              ly.frozen = (flags & 1) === 1;
              ly.locked = (flags & 4) === 4;
              if (flags & 16) ly.xrefDependent = true;
              const lt = q.str(6, '');
              if (lt) ly.linetype = lt;
              const lw = q.int(370, -1);
              if (lw > 0) ly.lineweight = lw / 100;
              if (q.int(290, 1) === 0) ly.plottable = false;
            } else if (tName === 'LTYPE') {
              const rec2: Linetype = { name: nm, pattern: q.nums(49) };
              if (q.int(70, 0) & 16) rec2.xrefDependent = true;
              const d = q.str(3, '');
              if (d) rec2.description = d;
              drawing.linetypes.push(rec2);
            } else if (tName === 'BLOCK_RECORD') {
              const h = q.str(5, '');
              if (h) blockRecordName.set(h.toUpperCase(), decodeCadText(nm));
            } else if (tName === 'APPID') {
              (drawing.appIds ??= []).push(decodeCadText(nm));
            } else if (tName === 'DIMSTYLE') {
              (drawing.dimStyles ??= []).push({ name: decodeCadText(nm) });
            } else if (tName === 'UCS') {
              (drawing.ucs ??= []).push({
                name: decodeCadText(nm),
                origin: pt3(q, 10, 20, 30),
                xAxis: pt3(q, 11, 21, 31),
                yAxis: pt3(q, 12, 22, 32)
              });
            } else if (tName === 'VIEW') {
              const v: View = {
                name: decodeCadText(nm),
                center: { x: q.num(10, 0), y: q.num(20, 0) },
                height: q.num(40, 0), width: q.num(41, 0)
              };
              if (q.numOr(11) != null) v.direction = pt3(q, 11, 21, 31);
              if (q.numOr(12) != null) v.target = pt3(q, 12, 22, 32);
              const ll = q.numOr(42);
              if (ll != null) v.lensLength = ll;
              (drawing.views ??= []).push(v);
            } else if (tName === 'VPORT') {
              const vp: VPort = {
                name: decodeCadText(nm),
                lowerLeft: { x: q.num(10, 0), y: q.num(20, 0) },
                upperRight: { x: q.num(11, 1), y: q.num(21, 1) },
                center: { x: q.num(12, 0), y: q.num(22, 0) },
                height: q.num(40, 0)
              };
              const ar = q.numOr(41);
              if (ar != null) vp.aspectRatio = ar;
              if (q.numOr(16) != null) vp.direction = pt3(q, 16, 26, 36);
              if (q.numOr(17) != null) vp.target = pt3(q, 17, 27, 37);
              if (q.numOr(13) != null) vp.snapBase = { x: q.num(13, 0), y: q.num(23, 0) };
              if (q.numOr(14) != null) vp.snapSpacing = { x: q.num(14, 0), y: q.num(24, 0) };
              if (q.numOr(15) != null) vp.gridSpacing = { x: q.num(15, 0), y: q.num(25, 0) };
              /* group 51 is the view twist in degrees; the model keeps
                 angles in radians, as every other angle in it does */
              const tw = q.numOr(51);
              if (tw != null) vp.twist = tw * RAD;
              const sa = q.numOr(50);
              if (sa != null) vp.snapAngle = sa * RAD;
              const lens = q.numOr(42);
              if (lens != null) vp.lensLength = lens;
              const fc = q.numOr(43);
              if (fc != null) vp.frontClip = fc;
              const bc = q.numOr(44);
              if (bc != null) vp.backClip = bc;
              const vm = q.numOr(71);
              if (vm != null) {
                /* AutoCAD folds UCSFOLLOW into 71 as bit 8 */
                vp.viewMode = vm & ~8;
                vp.ucsFollow = (vm & 8) !== 0;
              }
              const cs = q.numOr(72);
              if (cs != null) vp.circleSides = cs;
              const fz = q.numOr(73);
              if (fz != null) vp.fastZoom = fz !== 0;
              const ic = q.numOr(74);
              if (ic != null) vp.ucsIcon = ic;
              const sn = q.numOr(75);
              if (sn != null) vp.snapOn = sn !== 0;
              const gr = q.numOr(76);
              if (gr != null) vp.gridOn = gr !== 0;
              const ss = q.numOr(77);
              if (ss != null) vp.snapStyle = ss;
              const si = q.numOr(78);
              if (si != null) vp.snapIsoPair = si;
              const rm = q.numOr(281);
              if (rm != null) vp.renderMode = rm;
              const uvp = q.numOr(65);
              if (uvp != null) vp.ucsPerViewport = uvp !== 0;
              if (q.numOr(110) != null) vp.ucsOrigin = pt3(q, 110, 120, 130);
              if (q.numOr(111) != null) vp.ucsXAxis = pt3(q, 111, 121, 131);
              if (q.numOr(112) != null) vp.ucsYAxis = pt3(q, 112, 122, 132);
              const uot = q.numOr(79);
              if (uot != null) vp.ucsOrthoType = uot;
              const uel = q.numOr(146);
              if (uel != null) vp.ucsElevation = uel;
              (drawing.vports ??= []).push(vp);
            } else if (tName === 'STYLE') {
              const st: TextStyle = { name: decodeCadText(nm) };
              const sh = q.str(5, '');
              if (sh) styleNameByHandle.set(sh.toUpperCase(), st.name);
              const stFlags = q.int(70, 0);
              if (stFlags & 1) st.shapeFile = true;
              if (stFlags & 16) st.xrefDependent = true;
              const font = q.str(3, '');
              if (font) st.font = font;
              const big = q.str(4, '');
              if (big) st.bigFont = big;
              const fh = q.num(40, 0);
              if (fh > 0) st.fixedHeight = fh;
              const wf = q.num(41, 0);
              if (wf > 0) st.widthFactor = wf;
              const ob = q.num(50, 0);
              if (ob) st.oblique = ob;
              /* the TrueType typeface lives in the record's ACAD xdata */
              for (const g of parseXdata(rec.g) ?? []) {
                if (g.appName !== 'ACAD') continue;
                for (const val of g.values) {
                  if ('value' in val && val.code === 1000 &&
                      typeof val.value === 'string' && !st.typeface) st.typeface = val.value;
                  if ('value' in val && val.code === 1071 && typeof val.value === 'number') {
                    if (val.value & 0x1000000) st.italic = true;
                    if (val.value & 0x2000000) st.bold = true;
                  }
                }
              }
              drawing.textStyles.push(st);
            }
          }
          k = findNext0(rec.next, tName, tEnd);
        }
        i = findNext0(tEnd + 1, 'TABLE', end);
      }
    };

    /* ---- BLOCKS ---- */
    const parseBlocks = (start: number, end: number): void => {
      let i = findNext0(start, 'BLOCK', end);
      while (i < end) {
        const rec = collectGroups(i, end);
        const q = G(rec.g);
        const rawName = decodeCadText(q.str(2, ''));
        const blkEnd = findNext0(rec.next, 'ENDBLK', end);
        /* the BLOCK_RECORD behind the definition is its owner (330) */
        const recH = q.str(330, '').toUpperCase();
        /* The two CURRENT-space blocks are the writer's own: their
           entities are in ENTITIES (the paper ones flagged 67). Every
           other paper-space block is a whole non-current layout — the
           reference's DXF spells them *Paper_Space0, *Paper_Space29, …
           with their entities inside — and is kept as a block named
           *Paper_Space2, *Paper_Space3, … in file order, exactly as the
           DWG reader numbers the layouts it finds, so the LAYOUT objects
           link to them and a rewrite carries every tab. */
        const isModel = /^\*model_space$/i.test(rawName);
        const isPaper = /^\*paper_space$/i.test(rawName);
        const isExtraPaper = !isPaper && /^\*paper_space/i.test(rawName);
        let nm = rawName;
        if (isModel) nm = '*Model_Space';
        else if (isPaper) nm = '*Paper_Space';
        else if (isExtraPaper) {
          let n = 2;
          while (('*Paper_Space' + n) in drawing.blocks) n++;
          nm = '*Paper_Space' + n;
        }
        if (recH && nm) blockNameByRecord.set(recH, nm);
        if (nm && !isModel && !isPaper && !(nm in drawing.blocks)) {
          /* nested inserts stay nested: blocks keep their inserts (the old
             flattening was an app-schema constraint, not a library concern) */
          const def: BlockDefinition = {
            name: nm,
            basePoint: pt3(q, 10, 20, 30),
            entities: parseEntities(rec.next, blkEnd)
          };
          /* the record handle, as the DWG reader keeps a block header's */
          if (isExtraPaper && recH) def.handle = recH;
          drawing.blocks[nm] = def;
        }
        i = findNext0(blkEnd + 1, 'BLOCK', end);
      }
    };

    /* ---- OBJECTS: layouts, groups, mline styles, image definitions ---- */
    const parseObjects = (start: number, end: number): void => {
      let k = findNext0(start, null, end);
      while (k < end) {
        const type = val(k);
        if (type === 'ENDSEC' || type === 'EOF') break;
        const rec = collectGroups(k, end);
        const q = G(rec.g);
        if (type === 'DICTIONARY' || type === 'ACDBDICTIONARYWDFLT') {
          /* remember which name each entry handle is listed under; a
             group 3 binds to the next 350/360 that follows it */
          let entryName: string | null = null;
          for (const [c, v] of rec.g) {
            if (c === 3) entryName = decodeCadText(v.trim());
            else if ((c === 350 || c === 360) && entryName) {
              dictEntryName.set(v.trim().toUpperCase(), entryName);
              entryName = null;
            }
          }
        } else if (type === 'ACDBPLACEHOLDER') {
          /* plot-style plumbing. The writer synthesizes the canonical
             ACAD_PLOTSTYLENAME dictionary and placeholder on every
             write, so the incoming pair is consumed here — sealing it
             would stack a duplicate on every round trip. */
        } else if (type === 'ACAD_PROXY_OBJECT') {
          /* the dictionary-owned twin of the proxy entity: same payload
             discipline, named afterwards through its owning dictionary */
          const p = parseProxyPayload(rec.g);
          const cls = proxyClassById.get(p.classId);
          const po: ProxyObject = {};
          const h = q.str(5, '');
          if (h) po.handle = h.toUpperCase();
          if (cls) { po.sourceType = cls.dxfName; po.appClass = { ...cls }; }
          if (p.data?.length) {
            po.data = bytesToB64(p.data);
            po.dataBits = p.dataBits;
          }
          if (p.refs) po.refs = p.refs;
          if (p.proxyVersion !== undefined) po.proxyVersion = p.proxyVersion;
          if (p.proxyMaint !== undefined) po.proxyMaint = p.proxyMaint;
          if (p.fromDxf !== undefined) po.fromDxf = p.fromDxf;
          /* some applications keep the whole object here: the reference's
             dbConnect records are nothing but their DCO15 xdata */
          const xd = parseXdata(rec.g);
          if (xd) po.xdata = xd;
          (drawing.proxyObjects ??= []).push(po);
        } else if (type === 'IMAGEDEF') {
          const h = q.str(5, '').toUpperCase();
          const path = q.str(1, '');
          if (h && path) imageDefPaths.set(h, decodeCadText(path));
        } else if (type === 'PDFDEFINITION' || type === 'DGNDEFINITION'
            || type === 'DWFDEFINITION') {
          const h = q.str(5, '').toUpperCase();
          if (h) {
            underlayDefs.set(h, {
              path: decodeCadText(q.str(1, '')),
              itemName: decodeCadText(q.str(2, ''))
            });
          }
        } else if (type === 'LAYOUT') {
          /* group 1 appears twice: printer config (plot settings) then the
             layout name — the last one is the name */
          const ones = q.rawAll(1).map((s) => s.trim()).filter(Boolean);
          const name = decodeCadText(ones[ones.length - 1] ?? '');
          if (name) {
            const l: Layout = { name, tabOrder: q.int(71, 0) };
            if (q.numOr(10) != null) l.limMin = { x: q.num(10, 0), y: q.num(20, 0) };
            if (q.numOr(11) != null) l.limMax = { x: q.num(11, 0), y: q.num(21, 0) };
            if (q.numOr(12) != null) l.insBase = pt3(q, 12, 22, 32);
            if (q.numOr(14) != null) l.extMin = pt3(q, 14, 24, 34);
            if (q.numOr(15) != null) l.extMax = pt3(q, 15, 25, 35);
            const ps = q.str(2, '');
            if (ps) l.paperSize = ps;
            const ss = q.str(7, '');
            if (ss) l.plotStyleSheet = ss;
            /* the block record it lays out is the 330 past the AcDbLayout
               marker (the one before it is the owning dictionary);
               resolved once every section is in */
            let inLayout = false;
            for (const [c, v] of rec.g) {
              if (c === 100) { inLayout = /AcDbLayout/i.test(v); continue; }
              if (inLayout && c === 330) {
                const h = v.trim().toUpperCase();
                if (h && h !== '0') pendingLayouts.push({ l, recH: h });
                break;
              }
            }
            (drawing.layouts ??= []).push(l);
          }
        } else if (type === 'GROUP') {
          const g2: EntityGroup = {
            name: q.str(3, '') || ('*A' + ((drawing.groups?.length ?? 0) + 1)),
            entityHandles: q.rawAll(340).map((s) => s.trim().toUpperCase())
          };
          const desc = q.str(300, '');
          if (desc) g2.description = desc;
          if (q.int(71, 1) === 0) g2.selectable = false;
          (drawing.groups ??= []).push(g2);
        } else if (type === 'XRECORD') {
          /* everything after the AcDbXrecord marker (minus the cloning
             flag) is the application's own payload */
          const values: XdataValue[] = [];
          let inBody = false;
          let pendingPt: { code: number; x: number; y: number; z: number } | null = null;
          const flushPt = (): void => {
            if (pendingPt) {
              values.push({
                code: pendingPt.code,
                point: { x: pendingPt.x, y: pendingPt.y, z: pendingPt.z }
              });
            }
            pendingPt = null;
          };
          for (const [c, v] of rec.g) {
            if (c === 100) { inBody = /AcDbXrecord/i.test(v); continue; }
            if (!inBody || c === 280 || c === 5 || c === 330 || c === 102) continue;
            const nv = parseFloat(v);
            if ((c >= 10 && c <= 19) || (c >= 210 && c <= 219)) {
              flushPt();
              pendingPt = { code: c, x: nv || 0, y: 0, z: 0 };
            } else if (pendingPt && c === pendingPt.code + 10) {
              pendingPt.y = nv || 0;
            } else if (pendingPt && c === pendingPt.code + 20) {
              pendingPt.z = nv || 0;
              flushPt();
            } else {
              flushPt();
              const numeric = (c >= 20 && c <= 59) || (c >= 60 && c <= 99)
                || (c >= 140 && c <= 179) || (c >= 270 && c <= 299)
                || (c >= 370 && c <= 389) || (c >= 420 && c <= 429)
                || (c >= 440 && c <= 469) || (c >= 1040 && c <= 1042)
                || c === 1070 || c === 1071;
              values.push({ code: c, value: numeric ? (nv || 0) : v.trim() });
            }
          }
          flushPt();
          if (values.length) {
            const xr: XRecord = { values };
            const h = q.str(5, '');
            if (h) xr.handle = h.toUpperCase();
            (drawing.xrecords ??= []).push(xr);
          }
        } else if (type === 'GEODATA') {
          const geo: GeoData = {
            version: q.int(90, 3),
            coordinatesType: q.int(70, 0),
            designPoint: pt3(q, 10, 20, 30),
            referencePoint: pt3(q, 11, 21, 31)
          };
          if (q.numOr(12) != null) {
            geo.northDirection = { x: q.num(12, 0), y: q.num(22, 1) };
          }
          if (q.numOr(40) != null) geo.horizontalUnitScale = q.num(40, 1);
          if (q.numOr(41) != null) geo.verticalUnitScale = q.num(41, 1);
          if (q.numOr(91) != null) geo.horizontalUnits = q.int(91, 0);
          if (q.numOr(92) != null) geo.verticalUnits = q.int(92, 0);
          if (q.numOr(210) != null) geo.upDirection = pt3(q, 210, 220, 230);
          if (q.numOr(95) != null) geo.scaleEstimation = q.int(95, 0);
          if (q.numOr(141) != null) geo.userScaleFactor = q.num(141, 1);
          if (q.numOr(294) != null) geo.seaLevelCorrection = q.int(294, 0) !== 0;
          if (q.numOr(142) != null) geo.seaLevelElevation = q.num(142, 0);
          if (q.numOr(143) != null) geo.projectionRadius = q.num(143, 0);
          /* the coordinate system definition arrives chunked: 303* then a
             final 301 */
          const chunks = [...q.rawAll(303), ...q.rawAll(301)];
          if (chunks.length) {
            geo.coordinateSystem =
              decodeCadText(chunks.join('')).replace(/\^J/g, '\n');
          }
          const rss = q.str(302, '');
          if (rss) {
            geo.geoRssTag = rss;
            const m = /<georss:point>\s*([-\d.eE+]+)\s+([-\d.eE+]+)/.exec(rss);
            if (m) {
              geo.latitude = parseFloat(m[1]);
              geo.longitude = parseFloat(m[2]);
            }
          }
          drawing.geoData ??= geo;
        } else if (type === 'MLINESTYLE') {
          const elements: MLineStyleElement[] = [];
          let cur: MLineStyleElement | null = null;
          for (const [c, v] of rec.g) {
            const nv = parseFloat(v);
            if (c === 49) {
              cur = { offset: isFinite(nv) ? nv : 0, color: { kind: 'byLayer' } };
              elements.push(cur);
            } else if (c === 62 && cur) {
              const aci = parseInt(v, 10);
              cur.color = aci >= 1 && aci <= 255
                ? { kind: 'aci', index: aci } : { kind: 'byBlock' };
            } else if (c === 6 && cur) {
              const lt = v.trim();
              if (lt && !/^bylayer$/i.test(lt)) cur.linetype = lt;
            }
          }
          const m: MLineStyle = {
            name: decodeCadText(q.str(2, '')) || 'Standard',
            elements
          };
          const desc = q.str(3, '');
          if (desc) m.description = desc;
          const fl = q.int(70, 0);
          if (fl) m.flags = fl;
          const sa = q.numOr(51), ea = q.numOr(52);
          if (sa != null) m.startAngle = sa * RAD;
          if (ea != null) m.endAngle = ea * RAD;
          (drawing.mlineStyles ??= []).push(m);
        } else if (type === 'SORTENTSTABLE') {
          /* Draw order: 331 names an entity, the 5 that follows it the
             sort key. THE TRAP: the object's own handle is a group 5 too,
             and it sits BEFORE the 100 AcDbSortentsTable marker — only
             pairs after the marker are entries. Consumed here (the array
             order the sort produces IS the model), never sealed. */
          let inBody = false;
          let pendingEnt: string | null = null;
          const ents: string[] = [];
          const sorts: string[] = [];
          for (const [c, v] of rec.g) {
            if (c === 100) { inBody = /AcDbSortentsTable/i.test(v); continue; }
            if (!inBody) continue;
            if (c === 331) pendingEnt = v.trim().toUpperCase();
            else if (c === 5 && pendingEnt) {
              ents.push(pendingEnt);
              sorts.push(v.trim().toUpperCase());
              pendingEnt = null;
            }
          }
          if (ents.length) sortTables.push({ ents, sorts });
        } else {
          /* an object record the semantic layer does not model: retained
             sealed as raw tags, exactly as tokenized, and named later
             through its owning dictionary — the same passthrough the DWG
             side gives unmodeled objects, in DXF's medium */
          const uo: UnknownObject = { sourceType: type };
          const h = q.str(5, '');
          if (h) uo.handle = h.toUpperCase();
          /* the owner is the first 330 outside a 102-fenced run — a fence
             holds reactor members and the extension dictionary, never the
             parent — and it stops mattering past the first subclass */
          let fenced = false;
          for (const [c, v] of rec.g) {
            if (c === 102) { fenced = !fenced; continue; }
            if (c === 100) break;
            if (c === 330 && !fenced) {
              const ov = v.trim();
              if (ov) uo.ownerHandle = ov.toUpperCase();
              break;
            }
          }
          if (rec.g.length) uo.tags = rec.g.map(([c, v]): Group => [c, v]);
          const xd = parseXdata(rec.g);
          if (xd) uo.xdata = xd;
          (drawing.unknownObjects ??= []).push(uo);
        }
        k = findNext0(rec.next, null, end);
      }
    };

    /* ---- walk sections ---- */
    let i = 0;
    let sawSection = false;
    const entityRuns: [number, number][] = [];
    while (i < pairs.length) {
      if (pairs[i][0] === 0 && val(i) === 'SECTION') {
        sawSection = true;
        /* the name is group 2, but a producer may slip comments (999) in
           between — skipping them is what keeps the section visible */
        let at = i + 1;
        while (pairs[at] && pairs[at][0] === 999) at++;
        const secName = (pairs[at] && pairs[at][0] === 2) ? val(at) : '';
        const body = secName ? at + 1 : i + 1;
        const secEnd = findNext0(body, 'ENDSEC', pairs.length);
        if (secEnd >= pairs.length) {
          warnings.push('SECTION' + (secName ? ' ' + secName : '') +
            ' has no ENDSEC (file truncated?).');
        }
        if (secName === 'HEADER') parseHeader(body, secEnd);
        else if (secName === 'CLASSES') parseClasses(body, secEnd);
        else if (secName === 'TABLES') parseTables(body, secEnd);
        else if (secName === 'BLOCKS') parseBlocks(body, secEnd);
        else if (secName === 'ENTITIES') entityRuns.push([body, secEnd]);
        else if (secName === 'OBJECTS') parseObjects(body, secEnd);
        i = secEnd + 1;
      } else {
        i++;
      }
    }
    if (!sawSection) warnings.push('Not a DXF file: no sections found.');

    for (const [s, e] of entityRuns) {
      for (const ent of parseEntities(s, e)) {
        if (ent.type === 'insert' && !(ent.blockName in drawing.blocks)) {
          /* kept anyway — a library should not lose data over a missing def */
          warnings.push('INSERT references missing block "' + ent.blockName + '".');
        }
        if (paperSet.has(ent)) (drawing.paperSpace ??= []).push(ent);
        else drawing.entities.push(ent);
      }
    }

    /* ---- draw order: each SORTENTSTABLE governs exactly one entity
       list, found through any entity it names; the list reorders in
       place by ascending sort key, an entity no entry names sorting
       under its own handle — the same rule the DWG reader applies. */
    if (sortTables.length) {
      const listOf = new Map<string, Entity[]>();
      const lists = [
        drawing.entities, drawing.paperSpace ?? [],
        ...Object.values(drawing.blocks).map((b) => b.entities)
      ];
      for (const list of lists) {
        for (const e of list) if (e.handle) listOf.set(e.handle, list);
      }
      for (const t of sortTables) {
        let list: Entity[] | undefined;
        for (const h of t.ents) { list = listOf.get(h); if (list) break; }
        if (!list || list.length < 2) continue;
        const key = new Map<number, number>();
        t.ents.forEach((h, i) => key.set(parseInt(h, 16), parseInt(t.sorts[i], 16)));
        const keyed = list.map((e, i) => {
          const h = e.handle ? parseInt(e.handle, 16) : NaN;
          return { e, i, k: key.get(h) ?? (Number.isFinite(h) ? h : i) };
        });
        keyed.sort((a, b) => (a.k - b.k) || (a.i - b.i));
        for (let i = 0; i < keyed.length; i++) list[i] = keyed[i].e;
      }
    }

    /* layouts name their blocks the way the DWG reader does: the two
       current spaces by their canonical names, the others *Paper_Space<n> */
    for (const { l, recH } of pendingLayouts) {
      const nm = blockNameByRecord.get(recH);
      if (nm) l.blockName = nm;
    }
    for (const { h, set } of pendingDictNames) {
      const nm = dictEntryName.get(h);
      if (nm) set(nm);
    }

    for (const { e, defHandle } of pendingImages) {
      const path = imageDefPaths.get(defHandle);
      if (path) e.path = path;
    }
    for (const { e, defHandle } of pendingUnderlays) {
      const def = underlayDefs.get(defHandle);
      if (def?.path) e.path = def.path;
      if (def?.itemName) e.itemName = def.itemName;
    }

    /* proxy objects get their dictionary names back — the dictionaries
       may sit before or after the records, so this resolves at the end */
    for (const po of drawing.proxyObjects ?? []) {
      if (po.name === undefined && po.handle) {
        const nm = dictEntryName.get(po.handle);
        if (nm) po.name = nm;
      }
    }
    /* sealed unknown objects ride the same plumbing */
    for (const uo of drawing.unknownObjects ?? []) {
      if (uo.name === undefined && uo.handle) {
        const nm = dictEntryName.get(uo.handle);
        if (nm) uo.name = nm;
      }
    }

    for (const type of Object.keys(kept)) {
      const n = kept[type];
      warnings.push(n + ' ' + type + ' entit' + (n === 1 ? 'y' : 'ies') +
        ' kept as unknown (not modeled).');
    }
  } catch (err) {
    warnings.push('DXF read error: ' + (err instanceof Error ? err.message : String(err)));
  }

  /* warnings hygiene: aggregate repeated messages into one line each */
  if (warnings.length > 1) {
    const counts = new Map<string, number>();
    for (const m of warnings) counts.set(m, (counts.get(m) ?? 0) + 1);
    if (counts.size < warnings.length) {
      warnings.length = 0;
      counts.forEach((n, m) => { warnings.push(n > 1 ? m + ' (x' + n + ')' : m); });
    }
  }

  if (!drawing.layers.length) ensureLayer('0');
  if (!drawing.linetypes.length) {
    drawing.linetypes.push({ name: 'Continuous', description: 'Solid line', pattern: [] });
  }
  if (!drawing.textStyles.length) drawing.textStyles.push({ name: 'Standard' });
  return drawing;
};
