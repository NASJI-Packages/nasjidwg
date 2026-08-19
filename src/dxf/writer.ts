/* nasjidwg — ASCII DXF R2000 (AC1015) writer.
 *
 * Ported from nasjicad's battle-tested dxf.js against the richer nasjidwg
 * document model. The model keeps exact geometry (ellipse params, spline
 * knots, hatch loops with bulges), so this writer emits it exactly instead
 * of the app-era approximations.
 */

import type {
  Color, Drawing, Entity, HatchBoundary, Layer, MTextEntity, Point3,
  ProxyEntity, TextEntity
} from '../core/model.js';
import { sabToSat } from '../acis/sab.js';
import { nearestAci } from '../core/color.js';
import { hasComplexScript, mirrorBrackets, shapeArabic } from '../text/arabic.js';
import { encodeCadSymbols, escapeUnicode } from '../text/escapes.js';
import { pairsToBinaryDxf } from './binary.js';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
/** Radians to degrees, folded into 0..360 the way AutoCAD stores an angle
 *  in a table record (a -45 degree twist goes out as 315). */
const twistDeg = (rad: number): number => {
  const d = ((rad * DEG) % 360 + 360) % 360;
  return Object.is(d, -0) ? 0 : d;
};
const RAD = Math.PI / 180;

const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);

/** The 24 lineweights AutoCAD accepts, in hundredths of a millimetre.
 *  A value off this list makes a file invalid, so a millimetre width is
 *  snapped to the nearest legal step. */
const LINEWEIGHTS: readonly number[] = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35,
  40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

const lineweightCode = (mm: number): number => {
  if (mm < 0) return mm >= -3 ? Math.round(mm) : -1;   /* -1/-2/-3 flags */
  const target = mm * 100;
  let best = LINEWEIGHTS[0];
  for (const w of LINEWEIGHTS) {
    if (Math.abs(w - target) < Math.abs(best - target)) best = w;
  }
  return best;
};

/* Decode the base64 the readers produce for sealed proxy payloads. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let at = 0, acc = 0, bits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, at);
};

const fmt = (v: number): string => {
  if (!isFinite(v)) return '0';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  let s = String(v);
  if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1) {
    s = v.toFixed(12).replace(/0+$/, '');
    if (s.endsWith('.')) s += '0';
  }
  return s;
};

/* *Model_Space / *Paper_Space are written unconditionally — never emit
   drawing.blocks entries with those names (some importers stash them). */
const isSystemBlock = (nm: string): boolean =>
  /^\*(model_space|paper_space)/i.test(nm);

const H_IDX: Record<string, number> =
  { left: 0, center: 1, right: 2, aligned: 3, middle: 4, fit: 5 };
const V_IDX: Record<string, number> =
  { baseline: 0, bottom: 1, middle: 2, top: 3 };

export const writeDxf = (drawing: Drawing): string => {
  const out: string[] = [];
  /* THE ETERNAL ARABIC FIX. An R2000 ASCII DXF is codepage text, not UTF-8:
     raw Arabic (or any non-ASCII) bytes turn into mojibake the moment a CAD
     opens the file under its own codepage. So every character above ASCII
     travels as AutoCAD's own \U+XXXX escape — text, layer names, block
     names, everything — and every reader rebuilds the exact character. */
  const w = (code: number, val: string | number): void => {
    let v = String(val);
    if (/[^\x00-\x7E]/.test(v)) v = escapeUnicode(v);
    out.push(String(code), v);
  };
  let handleCounter = 0x100;
  const handle = (): string => (handleCounter++).toString(16).toUpperCase();

  const layers: Layer[] = drawing.layers.length ? drawing.layers : [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];

  const blocks = drawing.blocks;
  const blockNames = Object.keys(blocks).filter((nm) =>
    blocks[nm] && !isSystemBlock(nm) && !blocks[nm].isLayout);
  /* '*'-prefixed names are RESERVED anonymous blocks (owned by dimensions
     etc.) — real CAD rejects files where a foreign writer defines them as
     ordinary blocks. Rename on export; INSERT/DIMENSION refs follow. */
  const blockRename: Record<string, string> = {};
  for (const nm of blockNames) {
    blockRename[nm] = nm
      .replace(/^\*/, 'ND_')
      .replace(/[<>\/\\":;?*|=`,]/g, '_');
  }
  const outBlockName = (nm: string): string => blockRename[nm] ?? nm;

  /* Ownership handles: entities must reference their owner BLOCK_RECORD
     (330) or strict readers drop them from model space.
     *Model_Space / *Paper_Space use AutoCAD's CANONICAL handles (1F/1B) so
     DWG converters merge into their template records instead of creating a
     duplicate, empty model space. */
  const msRecHandle = '1F';
  const psRecHandle = '1B';
  /* ACAD_PLOTSTYLENAME and the placeholder its "Normal" entry points at.
     Every LAYER record must name its plot style through group 390 — DXFIN
     discards the whole drawing when the group is missing. */
  const plotStyleDictHandle = 'E';
  const plotStyleHolderHandle = 'F';
  const blockRecHandle: Record<string, string> = {};
  for (const nm of blockNames) blockRecHandle[nm] = handle();

  /* IMAGE entities reference IMAGEDEF objects; collected while writing
     entities, emitted into the OBJECTS section at the end. */
  const imageDefs = new Map<string, { handle: string; w: number; h: number }>();
  const imageDefFor = (path: string, wPx: number, hPx: number): string => {
    const key = path + '|' + wPx + 'x' + hPx;
    let def = imageDefs.get(key);
    if (!def) imageDefs.set(key, def = { handle: handle(), w: wPx, h: hPx });
    return def.handle;
  };
  const allEntities = (): Entity[] => {
    const out = [...drawing.entities, ...(drawing.paperSpace ?? [])];
    for (const nm of blockNames) out.push(...blocks[nm].entities);
    return out;
  };
  const usesImages = allEntities().some((e) => e.type === 'image');
  /* MLINE entities must name their style through a hard 340 — DXFIN
     discards the whole drawing without it. The styles land in OBJECTS,
     but their handles are fixed here so entities can point at them; a
     drawing that has MLINEs and no styles gets a Standard to point at. */
  const mlStyles = drawing.mlineStyles?.length
    ? drawing.mlineStyles
    : allEntities().some((e) => e.type === 'mline')
      ? [{
        name: 'Standard', elements: [
          { offset: 0.5, color: { kind: 'byLayer' } as Color },
          { offset: -0.5, color: { kind: 'byLayer' } as Color }]
      }]
      : [];
  const mlStyleHandles = mlStyles.map(() => handle());
  const mlStyleIndex = new Map<string, number>();
  mlStyles.forEach((m, i) => mlStyleIndex.set(m.name.toLowerCase(), i));
  /** Underlay kinds present, each needing its class + definition pair. */
  const underlayKinds = [...new Set(allEntities()
    .filter((e): e is Extract<Entity, { type: 'underlay' }> => e.type === 'underlay')
    .map((e) => e.underlayKind))].sort();
  /* UNDERLAY entities reference shared definition objects */
  const underlayDefs = new Map<string, { handle: string; kind: string; path: string; itemName: string }>();
  const underlayDefFor = (
    kind: string, path: string, itemName: string
  ): string => {
    const key = kind + '|' + path + '|' + itemName;
    let def = underlayDefs.get(key);
    if (!def) {
      underlayDefs.set(key, def = { handle: handle(), kind, path, itemName });
    }
    return def.handle;
  };

  /* ---- proxy passthrough --------------------------------------------------
     A proxy that still carries its sealed payload (the opaque application
     data and/or the cached display list) leaves as a real ACAD_PROXY_ENTITY
     record instead of exploding into its picture. Each distinct application
     class behind one gets its own CLASSES record, and group 91 in the proxy
     points at it by position: the first CLASS in the section is class id
     500, so the proxy ids are assigned after the fixed image/underlay
     classes. A bare {sourceType, graphics} proxy keeps the old explode
     behavior — with nothing sealed, the picture is all there is to say. */
  const isSealedProxy = (e: Entity): e is ProxyEntity =>
    e.type === 'proxy' && !!(e.data || e.graphicsData);
  const proxyObjs = drawing.proxyObjects ?? [];
  /* Unknown objects that arrived through DXF carry their raw tags; those
     go back out verbatim under the named objects dictionary. Ones sealed
     by the DWG readers carry bits instead of tags — a different medium —
     and stay out of a DXF, exactly as before. */
  const sealedObjs = (drawing.unknownObjects ?? [])
    .filter((o) => o.tags && o.tags.length);
  const proxyClasses = new Map<string, { cpp: string; app: string; ent: boolean }>();
  const proxyClassKey = (
    appClass: { dxfName: string } | undefined, sourceType: string | undefined,
    fallback: string
  ): string => appClass?.dxfName ?? sourceType ?? fallback;
  const addProxyClass = (
    appClass: { dxfName: string; cppName: string; appName: string } | undefined,
    sourceType: string | undefined, fallback: string, ent: boolean
  ): void => {
    const key = proxyClassKey(appClass, sourceType, fallback);
    const cur = proxyClasses.get(key);
    if (cur) { if (ent) cur.ent = true; return; }
    proxyClasses.set(key, {
      cpp: appClass?.cppName ?? key,
      app: appClass?.appName ?? 'ObjectDBX Classes',
      ent
    });
  };
  for (const e of allEntities()) {
    if (isSealedProxy(e)) {
      addProxyClass(e.appClass, e.sourceType, 'ACAD_PROXY_ENTITY', true);
    }
  }
  for (const p of proxyObjs) {
    addProxyClass(p.appClass, p.sourceType, 'ACAD_PROXY_OBJECT', false);
  }
  const proxyClassId = new Map<string, number>();
  {
    /* class numbers are positional (first CLASS record = 500); the two
       always-present plot-style classes come before everything else */
    let id = 502 + (usesImages ? 4 : 0) + underlayKinds.length * 2;
    for (const key of proxyClasses.keys()) proxyClassId.set(key, id++);
  }

  /* ---- THE SAVED VIEW ---------------------------------------------------
     A DXF that declares no extents and no viewport opens wherever the
     reading CAD's default template happens to look — for AutoCAD a small
     window at the origin, so a 2000-unit drawing needs ZOOM ALL before
     anything shows. Three things fix it, and all three are needed:
       $EXTMIN/$EXTMAX  what ZOOM EXTENTS uses, and what a viewer reads to
                        frame a preview
       $LIMMIN/$LIMMAX  what ZOOM ALL uses — it frames LIMITS union the
                        extents, so stale default limits (an A3 sheet at the
                        origin) are exactly what parks the drawing in a
                        corner of a zoomed-out view
       VPORT *Active    the view actually restored on open: centre + height.
                        Without the record there is nothing to restore and
                        the template's own view wins.
     Computed from the entities because the header is written first. ----- */
  const ext = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  const grow = (x: number, y: number): void => {
    if (!isNum(x) || !isNum(y)) return;
    if (x < ext.minx) ext.minx = x;
    if (x > ext.maxx) ext.maxx = x;
    if (y < ext.miny) ext.miny = y;
    if (y > ext.maxy) ext.maxy = y;
  };
  const growLoop = (b: HatchBoundary): void => {
    if (b.kind === 'polyline') { for (const p of b.vertices) grow(p.x, p.y); }
    else if (b.kind === 'circle') {
      grow(b.center.x - b.radius, b.center.y - b.radius);
      grow(b.center.x + b.radius, b.center.y + b.radius);
    } else if (b.kind === 'ellipse') {
      const rr = Math.hypot(b.majorAxis.x, b.majorAxis.y);
      grow(b.center.x - rr, b.center.y - rr);
      grow(b.center.x + rr, b.center.y + rr);
    } else {
      for (const e of b.edges) {
        if (e.kind === 'line') { grow(e.start.x, e.start.y); grow(e.end.x, e.end.y); }
        else if (e.kind === 'arc') {
          grow(e.center.x - e.radius, e.center.y - e.radius);
          grow(e.center.x + e.radius, e.center.y + e.radius);
        } else if (e.kind === 'ellipticalArc') {
          const rr = Math.hypot(e.majorAxis.x, e.majorAxis.y);
          grow(e.center.x - rr, e.center.y - rr);
          grow(e.center.x + rr, e.center.y + rr);
        } else {
          for (const p of e.controlPoints) grow(p.x, p.y);
        }
      }
    }
  };
  /* A radius bound is the circumscribed box: never smaller than the true
     arc/ellipse bbox, so the view can be generous but never clip. */
  const growEnt = (ent: Entity): void => {
    switch (ent.type) {
      case 'line': grow(ent.start.x, ent.start.y); grow(ent.end.x, ent.end.y); break;
      case 'point': grow(ent.position.x, ent.position.y); break;
      case 'polyline': for (const p of ent.vertices) grow(p.x, p.y); break;
      case 'circle': case 'arc':
        grow(ent.center.x - ent.radius, ent.center.y - ent.radius);
        grow(ent.center.x + ent.radius, ent.center.y + ent.radius);
        break;
      case 'ellipse': {
        const rr = Math.hypot(ent.majorAxis.x, ent.majorAxis.y);
        grow(ent.center.x - rr, ent.center.y - rr);
        grow(ent.center.x + rr, ent.center.y + rr);
        break;
      }
      case 'spline':
        for (const p of ent.controlPoints) grow(p.x, p.y);
        for (const p of ent.fitPoints ?? []) grow(p.x, p.y);
        break;
      case 'text': case 'mtext': {
        const h = isNum(ent.height) && ent.height > 0 ? ent.height : 5;
        const wide = ent.text.length * h * 0.8;
        grow(ent.position.x, ent.position.y - h);
        grow(ent.position.x + wide, ent.position.y + h);
        break;
      }
      case 'insert': grow(ent.position.x, ent.position.y); break;
      case 'hatch': for (const b of ent.loops) growLoop(b); break;
      case 'solid': for (const p of ent.corners) grow(p.x, p.y); break;
      case 'leader': for (const p of ent.vertices) grow(p.x, p.y); break;
      case 'dimension':
        grow(ent.definitionPoint.x, ent.definitionPoint.y);
        if (ent.textMidpoint) grow(ent.textMidpoint.x, ent.textMidpoint.y);
        break;
      case 'face3d': for (const p of ent.corners) grow(p.x, p.y); break;
      case 'shape': grow(ent.position.x, ent.position.y); break;
      case 'tolerance': grow(ent.position.x, ent.position.y); break;
      case 'mline': for (const v of ent.vertices) grow(v.position.x, v.position.y); break;
      case 'mesh': for (const p of ent.vertices) grow(p.x, p.y); break;
      case 'image': {
        const px = ent.position.x, py = ent.position.y;
        const ex = px + ent.uVector.x * ent.widthPx + ent.vVector.x * ent.heightPx;
        const ey = py + ent.uVector.y * ent.widthPx + ent.vVector.y * ent.heightPx;
        grow(px, py); grow(ex, ey);
        break;
      }
      /* XLINE and RAY are infinite: AutoCAD leaves them out of the extents
         and so must we, or one construction line blows the view up to the
         whole coordinate space. */
      case 'ray': case 'xline': break;
      default: break;
    }
  };
  for (const ent of drawing.entities) growEnt(ent);

  /* The extents the drawing itself carries beat the sweep. Production
     files keep invisible strays far outside the real content — a 438-unit
     drawing whose sweep came back 1,030,277 wide — and AutoCAD 2027 itself
     reports the stored pair even after a regen, so stating the sweep here
     framed 99.96% blank paper. The sweep stays as the fallback for
     drawings built from scratch, which carry no header extents at all. */
  const hdr = drawing.header;
  const box = (mn?: Point3, mx?: Point3, ordered = true)
    : { min: { x: number; y: number }; max: { x: number; y: number } } | null => {
    if (!mn || !mx) return null;
    if (![mn.x, mn.y, mx.x, mx.y].every((q) => isNum(q) && Math.abs(q) < 1e19)) return null;
    if (ordered && (mx.x < mn.x || mx.y < mn.y)) return null;
    return { min: { x: mn.x, y: mn.y }, max: { x: mx.x, y: mx.y } };
  };
  const stored = box(hdr.extMin, hdr.extMax);
  /* An empty drawing has no extents to state; AutoCAD's own "nothing here"
     sentinel is a min above a max, and every reader knows to ignore it. */
  const hasExt = !!stored || (ext.maxx >= ext.minx && ext.maxy >= ext.miny);
  const exMin = stored?.min ?? (hasExt ? { x: ext.minx, y: ext.miny } : { x: 1e20, y: 1e20 });
  const exMax = stored?.max ?? (hasExt ? { x: ext.maxx, y: ext.maxy } : { x: -1e20, y: -1e20 });
  const spanX = hasExt ? Math.max(exMax.x - exMin.x, 1e-6) : 100;
  const spanY = hasExt ? Math.max(exMax.y - exMin.y, 1e-6) : 100;
  const ctrX = hasExt ? (exMin.x + exMax.x) / 2 : 0;
  const ctrY = hasExt ? (exMin.y + exMax.y) / 2 : 0;
  /* VIEW_ASPECT is the shape of a plausible CAD window: the saved height
     must cover the drawing once that aspect has had its say, or a wide
     drawing in a tall window is cropped left and right on open. */
  const VIEW_ASPECT = 1.6;
  const VIEW_MARGIN = 1.06;
  const viewH = Math.max(spanY, spanX / VIEW_ASPECT) * VIEW_MARGIN;

  /* ---- HEADER ---- */
  const activeVp = (drawing.vports ?? []).find((p) => /^\*active$/i.test(p.name));
  w(0, 'SECTION'); w(2, 'HEADER');
  w(9, '$ACADVER'); w(1, 'AC1015');
  w(9, '$DWGCODEPAGE'); w(3, hdr.codepage ?? 'ANSI_1252');
  w(9, '$INSUNITS'); w(70, hdr.insUnits ?? 4);
  if (isNum(hdr.linetypeScale) && hdr.linetypeScale > 0) {
    w(9, '$LTSCALE'); w(40, fmt(hdr.linetypeScale));
  }
  /* current dimensioning sizes, when the source carried them */
  for (const k of ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE',
    'DIMRND', 'DIMDLE', 'DIMTP', 'DIMTM', 'DIMTXT', 'DIMCEN', 'DIMTSZ',
    'DIMALTF', 'DIMLFAC', 'DIMTVP', 'DIMTFAC', 'DIMGAP']) {
    const v = hdr.vars?.[k];
    if (isNum(v)) { w(9, '$' + k); w(40, fmt(v as number)); }
  }
  if (isNum(hdr.vars?.DIMDEC)) { w(9, '$DIMDEC'); w(70, hdr.vars!.DIMDEC as number); }
  /* the point glyph and its size (PDMODE 1 = a POINT draws nothing) */
  if (isNum(hdr.vars?.PDMODE)) { w(9, '$PDMODE'); w(70, hdr.vars!.PDMODE as number); }
  if (isNum(hdr.vars?.PDSIZE)) { w(9, '$PDSIZE'); w(40, fmt(hdr.vars!.PDSIZE as number)); }
  /* unknown vars the reader preserved travel back as [code, value] pairs */
  for (const [name, v] of Object.entries(hdr.vars ?? {})) {
    if (!Array.isArray(v)) continue;
    const groups = v as unknown[];
    if (!groups.every((g) => Array.isArray(g) && g.length === 2 && isNum(g[0]))) continue;
    w(9, name);
    for (const g of groups as [number, string | number][]) w(g[0], g[1]);
  }
  w(9, '$EXTMIN'); w(10, fmt(exMin.x)); w(20, fmt(exMin.y)); w(30, 0);
  w(9, '$EXTMAX'); w(10, fmt(exMax.x)); w(20, fmt(exMax.y)); w(30, 0);
  /* Stored limits travel as stored, the way AutoCAD's own DXFOUT writes
     them (ZOOM ALL frames limits union extents, so content stays framed
     either way). A drawing without any gets limits = the extents, so
     ZOOM ALL and ZOOM EXTENTS agree. */
  const lim = box(hdr.limMin && { ...hdr.limMin, z: 0 },
    hdr.limMax && { ...hdr.limMax, z: 0 }, false);
  w(9, '$LIMMIN'); w(10, fmt(lim ? lim.min.x : hasExt ? exMin.x : 0));
  w(20, fmt(lim ? lim.min.y : hasExt ? exMin.y : 0));
  w(9, '$LIMMAX'); w(10, fmt(lim ? lim.max.x : hasExt ? exMax.x : 100));
  w(20, fmt(lim ? lim.max.y : hasExt ? exMax.y : 100));
  w(9, '$LIMCHECK'); w(70, 0);      /* limits frame the view, never gate input */
  /* The view on open is the one the drawing was saved with, when it has
     one — $VIEWCTR/$VIEWSIZE mirror the *Active VPORT the way AutoCAD
     writes them. The frame-everything view stays for drawings built from
     scratch, which have no saved view to restore. */
  w(9, '$VIEWCTR'); w(10, fmt(activeVp ? activeVp.center.x : ctrX));
  w(20, fmt(activeVp ? activeVp.center.y : ctrY));
  w(9, '$VIEWSIZE');
  w(40, fmt(activeVp && isNum(activeVp.height) && activeVp.height > 0 ? activeVp.height : viewH));
  /* The current UCS. A drawing laid out at an angle carries its rotation
     here, and writing the world default instead does not read as missing
     data — it reads as "this drawing is not rotated", which is worse. */
  if (hdr.ucs) {
    w(9, '$UCSORG'); w(10, fmt(hdr.ucs.origin.x)); w(20, fmt(hdr.ucs.origin.y)); w(30, fmt(hdr.ucs.origin.z));
    w(9, '$UCSXDIR'); w(10, fmt(hdr.ucs.xAxis.x)); w(20, fmt(hdr.ucs.xAxis.y)); w(30, fmt(hdr.ucs.xAxis.z));
    w(9, '$UCSYDIR'); w(10, fmt(hdr.ucs.yAxis.x)); w(20, fmt(hdr.ucs.yAxis.y)); w(30, fmt(hdr.ucs.yAxis.z));
  }
  if (hdr.pUcs) {
    w(9, '$PUCSORG'); w(10, fmt(hdr.pUcs.origin.x)); w(20, fmt(hdr.pUcs.origin.y)); w(30, fmt(hdr.pUcs.origin.z));
    w(9, '$PUCSXDIR'); w(10, fmt(hdr.pUcs.xAxis.x)); w(20, fmt(hdr.pUcs.xAxis.y)); w(30, fmt(hdr.pUcs.xAxis.z));
    w(9, '$PUCSYDIR'); w(10, fmt(hdr.pUcs.yAxis.x)); w(20, fmt(hdr.pUcs.yAxis.y)); w(30, fmt(hdr.pUcs.yAxis.z));
  }
  /* HANDSEED must clear every handle in the file: DXFIN treats a handle
     at or above the seed as invalid and reseats it, and the reseated
     value then collides with the record that legitimately holds it
     ("Bad handle FFFF: already in use"). The counter is not done yet,
     so a placeholder goes out here and the real top lands at the end. */
  w(9, '$HANDSEED');
  const handseedAt = out.length + 1;
  w(5, 'FFFF');
  w(0, 'ENDSEC');

  /* ---- CLASSES ---- */
  {
    w(0, 'SECTION'); w(2, 'CLASSES');
    const cls = (dxf: string, cpp: string, isEntity: boolean): void => {
      w(0, 'CLASS'); w(1, dxf); w(2, cpp);
      w(3, 'ISM'); w(90, 127); w(280, 0); w(281, isEntity ? 1 : 0);
    };
    /* The plot-style machinery below is spelled the way AutoCAD spells
       it — these two classes exist in every R2000+ file it writes. */
    for (const [dxfName, cpp] of [
      ['ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault'],
      ['ACDBPLACEHOLDER', 'AcDbPlaceholder']
    ]) {
      w(0, 'CLASS'); w(1, dxfName); w(2, cpp);
      w(3, 'ObjectDBX Classes'); w(90, 0); w(280, 0); w(281, 0);
    }
    if (usesImages) {
      cls('IMAGE', 'AcDbRasterImage', true);
      cls('WIPEOUT', 'AcDbWipeout', true);
      cls('IMAGEDEF', 'AcDbRasterImageDef', false);
      cls('RASTERVARIABLES', 'AcDbRasterVariables', false);
    }
    for (const kind of underlayKinds) {
      const cap = kind.charAt(0).toUpperCase() + kind.slice(1);
      cls(kind.toUpperCase() + 'UNDERLAY', `AcDb${cap}Reference`, true);
      cls(kind.toUpperCase() + 'DEFINITION', `AcDb${cap}Definition`, false);
    }
    /* proxy classes re-state the original application's naming, with the
       was-a-proxy flag (280) set — what the class stood for in the source */
    for (const [key, pc] of proxyClasses) {
      w(0, 'CLASS'); w(1, key); w(2, pc.cpp); w(3, pc.app);
      w(90, pc.ent ? 4095 : 0); w(280, 1); w(281, pc.ent ? 1 : 0);
    }
    w(0, 'ENDSEC');
  }

  /* ---- TABLES ---- */
  w(0, 'SECTION'); w(2, 'TABLES');

  /* VPORT — the *Active record IS the view a CAD restores on open. 12/22 is
     the view centre in DCS and 40 the view HEIGHT (width follows from 41,
     the window aspect); 16/26/36 looks straight down at the XY plane.
     Named *Active rather than *ACTIVE because that is the spelling AutoCAD
     writes and some readers match it verbatim. */
  w(0, 'TABLE'); w(2, 'VPORT'); w(5, handle()); w(100, 'AcDbSymbolTable'); w(70, 1);
  w(0, 'VPORT'); w(5, handle());
  w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbViewportTableRecord');
  w(2, '*Active'); w(70, 0);
  /* When the drawing carries the view it was saved with, that view goes
     out — twist included. Only a drawing that has none gets the synthetic
     frame below, which is what the exporter has always written. */
  const src = activeVp;
  if (src) {
    w(10, fmt(src.lowerLeft.x)); w(20, fmt(src.lowerLeft.y));
    w(11, fmt(src.upperRight.x)); w(21, fmt(src.upperRight.y));
    w(12, fmt(src.center.x)); w(22, fmt(src.center.y));
    w(13, fmt(src.snapBase?.x ?? 0)); w(23, fmt(src.snapBase?.y ?? 0));
    w(14, fmt(src.snapSpacing?.x ?? 10)); w(24, fmt(src.snapSpacing?.y ?? 10));
    w(15, fmt(src.gridSpacing?.x ?? 10)); w(25, fmt(src.gridSpacing?.y ?? 10));
    const dir = src.direction ?? { x: 0, y: 0, z: 1 };
    const tgt = src.target ?? { x: 0, y: 0, z: 0 };
    w(16, fmt(dir.x)); w(26, fmt(dir.y)); w(36, fmt(dir.z));
    w(17, fmt(tgt.x)); w(27, fmt(tgt.y)); w(37, fmt(tgt.z));
    w(40, fmt(src.height));
    w(41, fmt(src.aspectRatio && src.aspectRatio > 0 ? src.aspectRatio : VIEW_ASPECT));
    w(42, fmt(src.lensLength ?? 50));
    w(43, fmt(src.frontClip ?? 0)); w(44, fmt(src.backClip ?? 0));
    w(50, fmt(twistDeg(src.snapAngle ?? 0)));
    /* group 51: the view twist, in degrees. AutoCAD normalizes it into
       0..360, and a consumer that ignores it draws the model turned. */
    w(51, fmt(twistDeg(src.twist ?? 0)));
    /* AutoCAD folds UCSFOLLOW into the view-mode flags as bit 8 */
    w(71, (src.viewMode ?? 0) | (src.ucsFollow ? 8 : 0));
    w(72, src.circleSides ?? 100);
    w(73, src.fastZoom === false ? 0 : 1);
    w(74, src.ucsIcon ?? 3);
    w(75, src.snapOn ? 1 : 0);
    w(76, src.gridOn ? 1 : 0);
    w(77, src.snapStyle ?? 0);
    w(78, src.snapIsoPair ?? 0);
    if (src.renderMode !== undefined) w(281, src.renderMode);
    if (src.ucsPerViewport !== undefined) w(65, src.ucsPerViewport ? 1 : 0);
    const ucs = src.ucsOrigin
      ? { origin: src.ucsOrigin, xAxis: src.ucsXAxis, yAxis: src.ucsYAxis }
      : hdr.ucs;
    if (ucs?.xAxis && ucs.yAxis) {
      w(110, fmt(ucs.origin.x)); w(120, fmt(ucs.origin.y)); w(130, fmt(ucs.origin.z));
      w(111, fmt(ucs.xAxis.x)); w(121, fmt(ucs.xAxis.y)); w(131, fmt(ucs.xAxis.z));
      w(112, fmt(ucs.yAxis.x)); w(122, fmt(ucs.yAxis.y)); w(132, fmt(ucs.yAxis.z));
    }
    if (src.ucsOrthoType !== undefined) w(79, src.ucsOrthoType);
    if (src.ucsElevation !== undefined) w(146, fmt(src.ucsElevation));
  } else {
    w(10, 0); w(20, 0);
    w(11, 1); w(21, 1);
    w(12, fmt(ctrX)); w(22, fmt(ctrY));
    w(13, 0); w(23, 0);
    w(14, 10); w(24, 10);
    w(15, 10); w(25, 10);
    w(16, 0); w(26, 0); w(36, 1);
    w(17, 0); w(27, 0); w(37, 0);
    w(40, fmt(viewH));
    w(41, fmt(VIEW_ASPECT));
    w(42, 50); w(43, 0); w(44, 0);
    w(50, 0); w(51, 0);
    w(71, 0); w(72, 100); w(73, 1); w(74, 3); w(75, 0);
    w(76, 0); w(77, 0); w(78, 0);
    if (hdr.ucs) {
      w(110, fmt(hdr.ucs.origin.x)); w(120, fmt(hdr.ucs.origin.y)); w(130, fmt(hdr.ucs.origin.z));
      w(111, fmt(hdr.ucs.xAxis.x)); w(121, fmt(hdr.ucs.xAxis.y)); w(131, fmt(hdr.ucs.xAxis.z));
      w(112, fmt(hdr.ucs.yAxis.x)); w(122, fmt(hdr.ucs.yAxis.y)); w(132, fmt(hdr.ucs.yAxis.z));
    }
  }
  w(0, 'ENDTAB');

  /* ByBlock and ByLayer are not decoration: DXFIN discards the whole
     drawing over a "Missing Default entry ByLayer in SymbolTable:LTYPE" */
  const missingLt = (nm: string): boolean =>
    !drawing.linetypes.some((lt) => lt.name.toLowerCase() === nm);
  const linetypes = [
    ...missingLt('byblock') ? [{ name: 'ByBlock', pattern: [] as number[] }] : [],
    ...missingLt('bylayer') ? [{ name: 'ByLayer', pattern: [] as number[] }] : [],
    ...missingLt('continuous')
      ? [{ name: 'Continuous', description: 'Solid line', pattern: [] as number[] }] : [],
    ...drawing.linetypes
  ];
  w(0, 'TABLE'); w(2, 'LTYPE'); w(5, handle()); w(100, 'AcDbSymbolTable');
  w(70, linetypes.length);
  for (const lt of linetypes) {
    w(0, 'LTYPE'); w(5, handle());
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbLinetypeTableRecord');
    w(2, lt.name); w(70, 0); w(3, lt.description ?? '');
    w(72, 65); w(73, lt.pattern.length);
    w(40, fmt(lt.pattern.reduce((s, e) => s + Math.abs(e), 0)));
    for (const e of lt.pattern) { w(49, fmt(e)); w(74, 0); }
  }
  w(0, 'ENDTAB');

  const layerAci = (c: Color): number =>
    c.kind === 'aci' ? Math.max(1, Math.min(255, Math.round(c.index)))
      : c.kind === 'rgb' ? nearestAci(c.rgb) : 7;
  w(0, 'TABLE'); w(2, 'LAYER'); w(5, handle()); w(100, 'AcDbSymbolTable');
  w(70, layers.length);
  for (const ly of layers) {
    const aci = layerAci(ly.color);
    w(0, 'LAYER'); w(5, handle());
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbLayerTableRecord');
    w(2, ly.name);
    w(70, (ly.frozen ? 1 : 0) | (ly.locked ? 4 : 0));
    w(62, ly.on ? aci : -aci);         /* negative 62 = layer off */
    if (ly.color.kind === 'rgb') w(420, ly.color.rgb);
    w(6, ly.linetype ?? 'Continuous');
    if (isNum(ly.lineweight)) w(370, lineweightCode(ly.lineweight));
    if (ly.plottable === false) w(290, 0);
    w(390, plotStyleHolderHandle);
  }
  w(0, 'ENDTAB');

  const styles = drawing.textStyles.length ? drawing.textStyles
    : [{ name: 'Standard' }];
  w(0, 'TABLE'); w(2, 'STYLE'); w(5, handle()); w(100, 'AcDbSymbolTable');
  w(70, styles.length);
  for (const st of styles) {
    w(0, 'STYLE'); w(5, handle());
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbTextStyleTableRecord');
    w(2, st.name); w(70, 0);
    w(40, fmt(st.fixedHeight ?? 0));
    w(41, fmt(st.widthFactor ?? 1));
    w(50, 0); w(71, 0); w(42, 2.5);
    w(3, st.font ?? 'txt');
    w(4, st.bigFont ?? '');
  }
  w(0, 'ENDTAB');

  /* named tables the model carries: VPORT/VIEW/UCS/APPID/DIMSTYLE.
     Every one goes out even when empty — DXFIN discards the whole
     drawing over a missing symbol table ("Missing SymbolTable:VIEW"),
     exactly as it does over a LAYER without its plot style. */
  {
    w(0, 'TABLE'); w(2, 'VIEW'); w(5, handle()); w(100, 'AcDbSymbolTable');
    w(70, drawing.views?.length ?? 0);
    for (const v of drawing.views ?? []) {
      w(0, 'VIEW'); w(5, handle());
      w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbViewTableRecord');
      w(2, v.name); w(70, 0);
      w(40, fmt(v.height)); w(41, fmt(v.width));
      w(10, fmt(v.center.x)); w(20, fmt(v.center.y));
      if (v.direction) { w(11, fmt(v.direction.x)); w(21, fmt(v.direction.y)); w(31, fmt(v.direction.z ?? 1)); }
      if (v.target) { w(12, fmt(v.target.x)); w(22, fmt(v.target.y)); w(32, fmt(v.target.z ?? 0)); }
      if (isNum(v.lensLength)) w(42, fmt(v.lensLength));
    }
    w(0, 'ENDTAB');
  }
  {
    w(0, 'TABLE'); w(2, 'UCS'); w(5, handle()); w(100, 'AcDbSymbolTable');
    w(70, drawing.ucs?.length ?? 0);
    for (const u of drawing.ucs ?? []) {
      w(0, 'UCS'); w(5, handle());
      w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbUCSTableRecord');
      w(2, u.name); w(70, 0);
      w(10, fmt(u.origin.x)); w(20, fmt(u.origin.y)); w(30, fmt(u.origin.z ?? 0));
      w(11, fmt(u.xAxis.x)); w(21, fmt(u.xAxis.y)); w(31, fmt(u.xAxis.z ?? 0));
      w(12, fmt(u.yAxis.x)); w(22, fmt(u.yAxis.y)); w(32, fmt(u.yAxis.z ?? 0));
    }
    w(0, 'ENDTAB');
  }
  {
    const apps = drawing.appIds?.length ? drawing.appIds : ['ACAD'];
    w(0, 'TABLE'); w(2, 'APPID'); w(5, handle()); w(100, 'AcDbSymbolTable');
    w(70, apps.length);
    for (const a of apps) {
      w(0, 'APPID'); w(5, handle());
      w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbRegAppTableRecord');
      w(2, a); w(70, 0);
    }
    w(0, 'ENDTAB');
  }
  {
    /* Standard is always in the table, whatever else the source carried:
       every DIMENSION/LEADER/TOLERANCE goes out naming it, and a group 3
       that names a style the table does not list is fatal to DXFIN
       ("Invalid dimension style name" — the whole file is discarded). */
    const srcDimStyles = drawing.dimStyles ?? [];
    const dimStyles = srcDimStyles.some((s) => /^standard$/i.test(s.name))
      ? srcDimStyles : [{ name: 'Standard' }, ...srcDimStyles];
    w(0, 'TABLE'); w(2, 'DIMSTYLE'); w(5, handle()); w(100, 'AcDbSymbolTable');
    w(70, dimStyles.length);
    w(100, 'AcDbDimStyleTable'); w(71, 0);
    for (const ds of dimStyles) {
      w(0, 'DIMSTYLE'); w(105, handle());
      w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbDimStyleTableRecord');
      w(2, ds.name); w(70, 0);
    }
    w(0, 'ENDTAB');
  }

  /* BLOCK_RECORD entries improve interop with strict R2000 readers */
  w(0, 'TABLE'); w(2, 'BLOCK_RECORD'); w(5, handle()); w(100, 'AcDbSymbolTable');
  w(70, 2 + blockNames.length);
  const brHandleOf = (nm: string): string => nm === '*Model_Space' ? msRecHandle
    : nm === '*Paper_Space' ? psRecHandle : blockRecHandle[nm];
  /* Layouts and their block records must point at each other — 330 down
     from the LAYOUT object, 340 back from the BLOCK_RECORD — or AUDIT
     deletes the dictionary entry. Handles are fixed here so the table
     can state the back-pointers; a layout whose block never lands in
     the table (an extra paper space this writer does not emit) stays
     out of the dictionary rather than being listed dangling. */
  const outLayouts: { l: NonNullable<Drawing['layouts']>[number]; h: string; brh: string }[] = [];
  for (const l of drawing.layouts ?? []) {
    const brh = l.blockName ? brHandleOf(l.blockName)
      : /model/i.test(l.name) ? msRecHandle : psRecHandle;
    if (brh) outLayouts.push({ l, h: handle(), brh });
  }
  const layoutOfBr = new Map(outLayouts.map((o) => [o.brh, o.h]));
  for (const nm of ['*Model_Space', '*Paper_Space'].concat(blockNames)) {
    w(0, 'BLOCK_RECORD'); w(5, brHandleOf(nm));
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbBlockTableRecord');
    w(2, isSystemBlock(nm) ? nm : outBlockName(nm));
    const lh = layoutOfBr.get(brHandleOf(nm));
    if (lh) w(340, lh);
  }
  w(0, 'ENDTAB');
  w(0, 'ENDSEC');

  /* ---- entity writers ---- */
  let currentOwner = msRecHandle;    /* BLOCK_RECORD owning what we write */
  let inPaperSpace = false;

  const writeColor = (c: Color): void => {
    if (c.kind === 'byBlock') w(62, 0);
    else if (c.kind === 'aci') w(62, c.index);
    else if (c.kind === 'rgb') { w(62, nearestAci(c.rgb)); w(420, c.rgb); }
    /* byLayer: nothing — absence of 62 means ByLayer */
  };

  /* Source handle -> the handle this file gave the entity. GROUP members
     are spelled with source handles in the model; written verbatim they
     point at nothing (every object here is renumbered) and AUDIT strips
     each one as "not an entity". */
  const newHandleOf = new Map<string, string>();
  const entStart = (dxfName: string, ent: Entity, subclass?: string): void => {
    const h = handle();
    w(0, dxfName); w(5, h);
    if (ent.handle) newHandleOf.set(ent.handle.toUpperCase(), h);
    w(330, currentOwner);
    w(100, 'AcDbEntity');
    if (inPaperSpace) w(67, 1);
    w(8, ent.layer || '0');
    writeColor(ent.color);
    if (ent.linetype) w(6, ent.linetype);
    if (isNum(ent.lineweight)) w(370, lineweightCode(ent.lineweight));
    if (isNum(ent.linetypeScale) && ent.linetypeScale > 0 &&
        Math.abs(ent.linetypeScale - 1) > 1e-12) w(48, fmt(ent.linetypeScale));
    if (ent.invisible) w(60, 1);
    if (subclass) w(100, subclass);
  };

  /** The OCS normal, written after an entity's own groups. Only the
   *  entities whose points are stored in object coordinates carry one. */
  const writeExtrusion = (ent: Entity): void => {
    const n = ent.extrusion;
    if (!n) return;
    w(210, fmt(n.x)); w(220, fmt(n.y)); w(230, fmt(n.z ?? 1));
  };

  /** A binary payload as 310 hex chunks: at most 127 bytes per line,
   *  uppercase — the widest chunk both ASCII and binary DXF accept. */
  const emit310Chunks = (bytes: Uint8Array): void => {
    for (let i = 0; i < bytes.length; i += 127) {
      let hex = '';
      for (let k = i; k < Math.min(i + 127, bytes.length); k++) {
        hex += bytes[k].toString(16).padStart(2, '0').toUpperCase();
      }
      w(310, hex);
    }
  };

  /** The shared tail of both proxy record forms: payload blocks, handle
   *  references, end marker, version word and origin flag. 92 counts the
   *  graphics bytes; 93 counts the entity data in BITS (the DXF reference
   *  measure), so a non-byte-aligned payload keeps its exact length. */
  const writeProxyBody = (p: {
    data?: string; dataBits?: number; graphicsData?: string;
    refs?: { code: number; value: string }[];
    proxyVersion?: number; proxyMaint?: number; fromDxf?: boolean;
  }): void => {
    if (p.graphicsData) {
      const bytes = fromBase64(p.graphicsData);
      w(92, bytes.length);
      emit310Chunks(bytes);
    }
    if (p.data) {
      const bytes = fromBase64(p.data);
      w(93, p.dataBits ?? bytes.length * 8);
      emit310Chunks(bytes);
    }
    /* references: soft codes travel as 330, hard ones (3/5) as 340 */
    for (const ref of p.refs ?? []) {
      w(ref.code === 3 || ref.code === 5 ? 340 : 330, ref.value);
    }
    w(94, 0);                            /* end of the reference run */
    /* 95 is the documented packed word: version low, maintenance high */
    w(95, (p.proxyMaint ?? 0) * 0x10000 + (p.proxyVersion ?? 0));
    w(70, p.fromDxf ? 1 : 0);
  };

  /* MTEXT body: symbols encoded, brackets mirrored for CAD's non-mirroring
     bidi, then shaped to Presentation Forms-B. Measured in AutoCAD 2027:
     a TEXT entity carrying \U+ escapes breaks Arabic joining (letters draw
     disconnected) while the MTEXT engine keeps them connected — so complex
     scripts always travel through MTEXT. */
  const mtextBody = (text: string): string =>
    shapeArabic(
      mirrorBrackets(encodeCadSymbols(text).replace(/\r\n?/g, '\n'), false))
      .replace(/\n/g, '\\P');

  const emitMtextValue = (body: string): void => {
    let rest = body;
    while (rest.length > 250) {              /* DXF chunking contract */
      w(3, rest.slice(0, 250));
      rest = rest.slice(250);
    }
    w(1, rest);
  };

  const writeAsMtext = (ent: TextEntity | MTextEntity): void => {
    let attach: number;
    let anchor: Point3;
    if (ent.type === 'mtext') {
      attach = isNum(ent.attachment) && ent.attachment >= 1 && ent.attachment <= 9
        ? ent.attachment : 1;
      anchor = ent.position;
    } else {
      /* attachment 1-9 from the TEXT justification; plain baseline-left
         text lands bottom-left (7) */
      const ha = ent.halign ?? 'left';
      const va = ent.valign ?? 'baseline';
      const col = (ha === 'center' || ha === 'middle') ? 2 : ha === 'right' ? 3 : 1;
      const row = va === 'top' ? 0 : (va === 'middle' || ha === 'middle') ? 1 : 2;
      attach = row * 3 + col;
      anchor = ((ha !== 'left' || va !== 'baseline') && ent.alignmentPoint)
        ? ent.alignmentPoint : ent.position;
    }
    entStart('MTEXT', ent, 'AcDbMText');
    w(10, fmt(anchor.x)); w(20, fmt(anchor.y)); w(30, fmt(anchor.z ?? 0));
    w(40, fmt(isNum(ent.height) && ent.height > 0 ? ent.height : 5));
    if (ent.type === 'mtext' && isNum(ent.width) && ent.width > 0) w(41, fmt(ent.width));
    w(71, attach);
    emitMtextValue(mtextBody(ent.text));
    w(50, fmt((ent.rotation || 0) * DEG));
    if (ent.style) w(7, ent.style);
  };

  const writeHatchLoop = (b: HatchBoundary, first: boolean): void => {
    if (b.kind === 'polyline') {
      const hasBulge = b.vertices.some((p) => isNum(p.bulge) && p.bulge !== 0);
      w(92, 2 | (first ? 1 : 0));            /* polyline (+external) */
      w(72, hasBulge ? 1 : 0);
      w(73, b.closed ? 1 : 0);
      w(93, b.vertices.length);
      for (const p of b.vertices) {
        w(10, fmt(p.x)); w(20, fmt(p.y));
        if (hasBulge) w(42, fmt(p.bulge ?? 0));
      }
      w(97, 0);
    } else if (b.kind === 'circle') {
      w(92, first ? 1 : 0); w(93, 1);
      w(72, 2);                              /* circular arc edge */
      w(10, fmt(b.center.x)); w(20, fmt(b.center.y));
      w(40, fmt(b.radius));
      w(50, 0); w(51, 360); w(73, 1);
      w(97, 0);
    } else if (b.kind === 'ellipse') {
      w(92, first ? 1 : 0); w(93, 1);
      w(72, 3);                              /* ellipse edge */
      w(10, fmt(b.center.x)); w(20, fmt(b.center.y));
      w(11, fmt(b.majorAxis.x)); w(21, fmt(b.majorAxis.y));
      w(40, fmt(b.ratio));
      w(50, 0); w(51, 360); w(73, 1);
      w(97, 0);
    } else {
      /* exact edge list — angles are radians in the model, degrees in DXF */
      w(92, first ? 1 : 0);
      w(93, b.edges.length);
      for (const e of b.edges) {
        if (e.kind === 'line') {
          w(72, 1);
          w(10, fmt(e.start.x)); w(20, fmt(e.start.y));
          w(11, fmt(e.end.x)); w(21, fmt(e.end.y));
        } else if (e.kind === 'arc') {
          w(72, 2);
          w(10, fmt(e.center.x)); w(20, fmt(e.center.y));
          w(40, fmt(e.radius));
          w(50, fmt(e.startAngle * DEG)); w(51, fmt(e.endAngle * DEG));
          w(73, e.ccw ? 1 : 0);
        } else if (e.kind === 'ellipticalArc') {
          w(72, 3);
          w(10, fmt(e.center.x)); w(20, fmt(e.center.y));
          w(11, fmt(e.majorAxis.x)); w(21, fmt(e.majorAxis.y));
          w(40, fmt(e.ratio));
          w(50, fmt(e.startAngle * DEG)); w(51, fmt(e.endAngle * DEG));
          w(73, e.ccw ? 1 : 0);
        } else {
          w(72, 4);
          w(94, e.degree > 0 ? e.degree : 3);
          w(73, e.weights?.length ? 1 : 0);   /* rational */
          w(74, e.periodic ? 1 : 0);
          w(95, e.knots.length);
          w(96, e.controlPoints.length);
          for (const k of e.knots) w(40, fmt(k));
          for (let i = 0; i < e.controlPoints.length; i++) {
            const p = e.controlPoints[i];
            w(10, fmt(p.x)); w(20, fmt(p.y));
            if (e.weights?.length) w(42, fmt(e.weights[i] ?? 1));
          }
          /* No fit-point block, and no 97 here at all: the R2000 spline
             edge ends at its control points. AutoCAD's own DXFOUT writes
             none, and its reader takes an edge-level 97 for the LOOP's
             source-boundary count — the loop's real 97 then reads as a
             stray group and DXFIN discards the file ("expected 75"). */
        }
      }
      w(97, 0);                              /* source boundary objects */
    }
  };

  const writeAttrib = (a: TextEntity, index: number): void => {
    entStart('ATTRIB', a, 'AcDbText');
    w(10, fmt(a.position.x)); w(20, fmt(a.position.y)); w(30, fmt(a.position.z ?? 0));
    w(40, fmt(isNum(a.height) && a.height > 0 ? a.height : 5));
    w(1, encodeCadSymbols(a.text).replace(/[\r\n]+/g, ' '));
    w(50, fmt((a.rotation || 0) * DEG));
    const ha = H_IDX[a.halign ?? 'left'] ?? 0;
    const va = V_IDX[a.valign ?? 'baseline'] ?? 0;
    if (ha) w(72, ha);
    if (ha || va) {
      const ap = a.alignmentPoint ?? a.position;
      w(11, fmt(ap.x)); w(21, fmt(ap.y)); w(31, fmt(ap.z ?? 0));
    }
    w(100, 'AcDbAttribute');
    w(2, 'ATTR' + (index + 1));              /* model keeps no tag — invent one */
    w(70, a.invisible ? 1 : 0);
    if (va) w(74, va);
  };

  /* XDATA rides at the very end of its entity's record */
  const writeXdata = (ent: Entity): void => {
    for (const g of ent.xdata ?? []) {
      w(1001, g.appName ?? 'ACAD');
      for (const v of g.values) {
        if ('point' in v) {
          w(v.code, fmt(v.point.x));
          w(v.code + 10, fmt(v.point.y));
          w(v.code + 20, fmt(v.point.z ?? 0));
        } else if (v.code === 1005) {
          /* the source drawing's handle space is gone — every object was
             renumbered — so a carried 1005 can only dangle. AUDIT flags
             each one ("XData Handle Unknown") and nulls it; null it here
             instead, which is the same end state without the noise. */
          w(1005, 0);
        } else {
          w(v.code, typeof v.value === 'number' ? fmt(v.value) : v.value);
        }
      }
    }
  };

  /** Re-emit a sealed record's raw tags. Everything travels verbatim —
   *  values bypass the escaping writer on purpose, byte-for-byte survival
   *  being the whole point — except the two identity groups that must be
   *  ours for the output file to cohere: the record's own handle (group 5,
   *  or 105 for the DIMVAR-style records, ahead of the first subclass
   *  marker) becomes the freshly allocated one, and a bare owner group 330
   *  in that same region is repointed at the real owner. A 330 inside a
   *  102-fenced run (reactors, extension dictionary) is application data
   *  and passes untouched; so does everything past the first 100. */
  const writeSealedTags = (
    tags: readonly [number, string][], newHandle: string, owner: string
  ): void => {
    let firstSubclass = tags.length;
    for (let i = 0; i < tags.length; i++) {
      if (tags[i][0] === 100) { firstSubclass = i; break; }
    }
    /* a record that arrived without a handle still leaves with one */
    let hasHandle = false;
    for (let i = 0; i < firstSubclass; i++) {
      const c = tags[i][0];
      if (c === 5 || c === 105) hasHandle = true;
    }
    if (!hasHandle) w(5, newHandle);
    let fenced = false;
    let handleDone = false, ownerDone = false;
    for (let i = 0; i < tags.length; i++) {
      const [c, v] = tags[i];
      if (c === 102) {
        fenced = !fenced;
      } else if (i < firstSubclass && !fenced) {
        if ((c === 5 || c === 105) && !handleDone) {
          handleDone = true;
          w(c, newHandle);
          continue;
        }
        if (c === 330 && !ownerDone) {
          ownerDone = true;
          w(330, owner);
          continue;
        }
      }
      out.push(String(c), v);
    }
  };

  const writeEntity = (ent: Entity): void => {
    writeEntityBody(ent);
    /* insert-with-attribs emits its xdata inline, before the ATTRIB run;
       a sealed unknown's tags already carry any xdata verbatim */
    if (ent.type === 'insert' && ent.attributes?.length) return;
    if (ent.type === 'unknown' && ent.tags?.length) return;
    writeXdata(ent);
  };

  const writeEntityBody = (ent: Entity): void => {
    switch (ent.type) {
      case 'line':
        entStart('LINE', ent, 'AcDbLine');
        w(10, fmt(ent.start.x)); w(20, fmt(ent.start.y)); w(30, fmt(ent.start.z ?? 0));
        w(11, fmt(ent.end.x)); w(21, fmt(ent.end.y)); w(31, fmt(ent.end.z ?? 0));
        return;

      case 'point':
        entStart('POINT', ent, 'AcDbPoint');
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        return;

      case 'ray': case 'xline':
        entStart(ent.type === 'ray' ? 'RAY' : 'XLINE', ent,
          ent.type === 'ray' ? 'AcDbRay' : 'AcDbXline');
        w(10, fmt(ent.basePoint.x)); w(20, fmt(ent.basePoint.y)); w(30, fmt(ent.basePoint.z ?? 0));
        w(11, fmt(ent.direction.x)); w(21, fmt(ent.direction.y)); w(31, fmt(ent.direction.z ?? 0));
        return;

      case 'polyline': {
        if (ent.vertices.length < 2) return;
        entStart('LWPOLYLINE', ent, 'AcDbPolyline');
        w(90, ent.vertices.length);
        w(70, ent.closed ? 1 : 0);
        if (isNum(ent.constantWidth) && ent.constantWidth > 0) w(43, fmt(ent.constantWidth));
        if (isNum(ent.elevation) && ent.elevation !== 0) w(38, fmt(ent.elevation));
        writeExtrusion(ent);
        for (const p of ent.vertices) {
          w(10, fmt(p.x)); w(20, fmt(p.y));
          /* 40/41/42 are positional: they belong to the vertex opened by
             the preceding 10 */
          if (isNum(p.startWidth)) w(40, fmt(p.startWidth));
          if (isNum(p.endWidth)) w(41, fmt(p.endWidth));
          if (isNum(p.bulge) && p.bulge !== 0) w(42, fmt(p.bulge));
        }
        return;
      }

      case 'circle':
        entStart('CIRCLE', ent, 'AcDbCircle');
        w(10, fmt(ent.center.x)); w(20, fmt(ent.center.y)); w(30, fmt(ent.center.z ?? 0));
        w(40, fmt(ent.radius));
        writeExtrusion(ent);
        return;

      case 'arc':
        entStart('ARC', ent, 'AcDbCircle');
        w(10, fmt(ent.center.x)); w(20, fmt(ent.center.y)); w(30, fmt(ent.center.z ?? 0));
        w(40, fmt(ent.radius));
        writeExtrusion(ent);
        w(100, 'AcDbArc');
        w(50, fmt(ent.startAngle * DEG));
        w(51, fmt(ent.endAngle * DEG));
        return;

      case 'ellipse':
        /* the model already speaks DXF's language here: center, major axis
           endpoint, ratio, parametric range — no sampling, no juggling */
        entStart('ELLIPSE', ent, 'AcDbEllipse');
        w(10, fmt(ent.center.x)); w(20, fmt(ent.center.y)); w(30, fmt(ent.center.z ?? 0));
        w(11, fmt(ent.majorAxis.x)); w(21, fmt(ent.majorAxis.y)); w(31, fmt(ent.majorAxis.z ?? 0));
        w(40, fmt(ent.ratio));
        w(41, fmt(ent.startParam));
        w(42, fmt(ent.endParam));
        writeExtrusion(ent);
        return;

      case 'spline': {
        const ctrl = ent.controlPoints;
        const fit = ent.fitPoints ?? [];
        if (ctrl.length < 2 && fit.length < 2) return;
        entStart('SPLINE', ent, 'AcDbSpline');
        w(210, 0); w(220, 0); w(230, 1);
        w(70, 8 | (ent.closed ? 1 : 0));     /* planar (+closed) */
        w(71, ent.degree > 0 ? ent.degree : 3);
        if (ctrl.length >= 2) {
          w(72, ent.knots.length);
          w(73, ctrl.length);
          w(74, fit.length);
          for (const k of ent.knots) w(40, fmt(k));
          if (ent.weights) for (const wt of ent.weights) w(41, fmt(wt));
          for (const p of ctrl) { w(10, fmt(p.x)); w(20, fmt(p.y)); w(30, fmt(p.z ?? 0)); }
          for (const p of fit) { w(11, fmt(p.x)); w(21, fmt(p.y)); w(31, fmt(p.z ?? 0)); }
        } else {
          w(72, 0); w(73, 0);
          w(74, fit.length);
          for (const p of fit) { w(11, fmt(p.x)); w(21, fmt(p.y)); w(31, fmt(p.z ?? 0)); }
        }
        return;
      }

      case 'mtext':
        writeAsMtext(ent);
        return;

      case 'text': {
        /* ANY complex-script text exports as a real MTEXT (see mtextBody) */
        if (hasComplexScript(ent.text)) { writeAsMtext(ent); return; }
        const ha = H_IDX[ent.halign ?? 'left'] ?? 0;
        const va = V_IDX[ent.valign ?? 'baseline'] ?? 0;
        entStart('TEXT', ent, 'AcDbText');
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        w(40, fmt(isNum(ent.height) && ent.height > 0 ? ent.height : 5));
        w(1, encodeCadSymbols(ent.text).replace(/[\r\n]+/g, ' '));
        w(50, fmt((ent.rotation || 0) * DEG));
        if (isNum(ent.widthFactor) && ent.widthFactor > 0 && ent.widthFactor !== 1) {
          w(41, fmt(ent.widthFactor));
        }
        if (isNum(ent.oblique) && ent.oblique !== 0) w(51, fmt(ent.oblique * DEG));
        if (ent.style) w(7, ent.style);
        if (ha) w(72, ha);
        if (ha || va) {
          const ap = ent.alignmentPoint ?? ent.position;
          w(11, fmt(ap.x)); w(21, fmt(ap.y)); w(31, fmt(ap.z ?? 0));
        }
        writeExtrusion(ent);
        w(100, 'AcDbText');
        if (va) w(73, va);
        return;
      }

      case 'solid':
        entStart('SOLID', ent, 'AcDbTrace');
        for (let i = 0; i < 4; i++) {
          const p = ent.corners[i];
          w(10 + i, fmt(p.x)); w(20 + i, fmt(p.y)); w(30 + i, fmt(p.z ?? 0));
        }
        writeExtrusion(ent);
        return;

      case 'hatch': {
        if (!ent.loops.length) return;
        entStart('HATCH', ent, 'AcDbHatch');
        w(10, 0); w(20, 0); w(30, fmt(ent.elevation ?? 0));
        const hn = ent.extrusion ?? { x: 0, y: 0, z: 1 };
        w(210, fmt(hn.x)); w(220, fmt(hn.y)); w(230, fmt(hn.z ?? 1));
        w(2, ent.solid ? 'SOLID' : (ent.patternName || 'ANSI31'));
        w(70, ent.solid ? 1 : 0);
        /* Always non-associative on the way out: associativity is a live
           link to source boundary objects (97 n + 330 ...), and no such
           links are written — a hatch that CLAIMS the link without them
           is an AUDIT error ("Boundary Undefined") on every single one. */
        w(71, 0);
        w(91, ent.loops.length);
        ent.loops.forEach((b, i) => writeHatchLoop(b, i === 0));
        w(75, ent.styleFlag ?? 0);           /* island style */
        w(76, ent.patternType ?? 1);         /* pattern type */
        if (!ent.solid) {
          const angDeg = isNum(ent.angle) ? ent.angle : 0;
          const scale = isNum(ent.scale) && ent.scale > 0 ? ent.scale : 1;
          w(52, fmt(angDeg));
          w(41, fmt(scale));
          w(77, ent.doubled ? 1 : 0);
          if (ent.definitionLines?.length) {
            /* exact pattern definition from the source */
            w(78, ent.definitionLines.length);
            for (const dl of ent.definitionLines) {
              w(53, fmt(dl.angle));
              w(43, fmt(dl.base.x)); w(44, fmt(dl.base.y));
              w(45, fmt(dl.offset.x)); w(46, fmt(dl.offset.y));
              w(79, dl.dashes.length);
              for (const d of dl.dashes) w(49, fmt(d));
            }
          } else {
            /* synthesized 45° family for well-known pattern names */
            const off = 6 * scale;
            const patU = (ent.patternName || 'ANSI31').toUpperCase();
            const cross = patU.indexOf('CROSS') >= 0 ||
              patU === 'ANSI37' || patU === 'NET' || patU === 'GRID' || patU === 'SQUARE';
            const lineAngs = cross ? [45 + angDeg, 135 + angDeg] : [45 + angDeg];
            w(78, lineAngs.length);
            for (const la of lineAngs) {
              const lineAng = la * RAD;
              w(53, fmt(la));
              w(43, 0); w(44, 0);
              w(45, fmt(-off * Math.sin(lineAng)));
              w(46, fmt(off * Math.cos(lineAng)));
              w(79, 0);
            }
          }
        }
        w(98, ent.seeds?.length ?? 0);
        for (const s of ent.seeds ?? []) { w(10, fmt(s.x)); w(20, fmt(s.y)); }
        /* No gradient block: groups 450-470 are R2004+, and the AC1015
           hatch parser stops dead on 450 ("Premature end of object" —
           the whole file is then discarded). AutoCAD's own R2000 DXFOUT
           omits them exactly the same way, gradient hatches included. */
        return;
      }

      case 'face3d': {
        entStart('3DFACE', ent, 'AcDbFace');
        for (let i = 0; i < 4; i++) {
          const p = ent.corners[i];
          w(10 + i, fmt(p.x)); w(20 + i, fmt(p.y)); w(30 + i, fmt(p.z ?? 0));
        }
        if (ent.invisibleEdges) w(70, ent.invisibleEdges);
        return;
      }

      case 'shape':
        entStart('SHAPE', ent, 'AcDbShape');
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        w(40, fmt(ent.size > 0 ? ent.size : 1));
        w(2, ent.name || ('SHAPE_' + (ent.styleId ?? 0)));
        if (ent.rotation) w(50, fmt(ent.rotation * DEG));
        if (isNum(ent.widthFactor) && ent.widthFactor !== 1) w(41, fmt(ent.widthFactor));
        if (isNum(ent.oblique) && ent.oblique !== 0) w(51, fmt(ent.oblique * DEG));
        return;

      case 'tolerance':
        entStart('TOLERANCE', ent, 'AcDbFcf');
        w(3, 'Standard');
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        /* embedded newlines travel as the ^J caret encoding */
        w(1, encodeCadSymbols(ent.text).replace(/\n/g, '^J'));
        w(11, fmt(ent.xDirection.x)); w(21, fmt(ent.xDirection.y)); w(31, fmt(ent.xDirection.z ?? 0));
        return;

      case 'mline': {
        if (ent.vertices.length < 2) return;
        entStart('MLINE', ent, 'AcDbMline');
        /* name AND hard pointer must agree; an unmatched name falls back
           to the first style so 340 never dangles */
        const msi = mlStyleIndex.get((ent.styleName ?? '').toLowerCase()) ?? 0;
        w(2, mlStyles[msi]?.name ?? 'Standard');
        w(340, mlStyleHandles[msi] ?? '0');
        w(40, fmt(isNum(ent.scale) && ent.scale !== 0 ? ent.scale : 1));
        w(70, ent.justification);
        w(71, 1 | (ent.closed ? 2 : 0));
        w(72, ent.vertices.length);
        w(73, ent.vertices[0]?.lines.length ?? 0);
        w(10, fmt(ent.basePoint.x)); w(20, fmt(ent.basePoint.y)); w(30, fmt(ent.basePoint.z ?? 0));
        for (const v of ent.vertices) {
          w(11, fmt(v.position.x)); w(21, fmt(v.position.y)); w(31, fmt(v.position.z ?? 0));
          w(12, fmt(v.direction.x)); w(22, fmt(v.direction.y)); w(32, fmt(v.direction.z ?? 0));
          w(13, fmt(v.miterDirection.x)); w(23, fmt(v.miterDirection.y)); w(33, fmt(v.miterDirection.z ?? 0));
          for (const ln of v.lines) {
            w(74, ln.segparms.length);
            for (const s of ln.segparms) w(41, fmt(s));
            w(75, ln.areaFillParms?.length ?? 0);
            for (const s of ln.areaFillParms ?? []) w(42, fmt(s));
          }
        }
        return;
      }

      case 'mesh': {
        /* heavyweight POLYLINE flavors: 70=16 polygon mesh, 70=64 polyface */
        if (!ent.vertices.length) return;
        const isGrid = ent.meshKind === 'grid';
        entStart('POLYLINE', ent,
          isGrid ? 'AcDbPolygonMesh' : 'AcDbPolyFaceMesh');
        w(66, 1);
        w(10, 0); w(20, 0); w(30, 0);
        /* a subdivision mesh has no R2000 record, so it is written as the
           polyface mesh it refines to — the same downgrade a CAD save-as
           performs */
        if (isGrid) {
          w(70, 16 | (ent.closedM ? 1 : 0) | (ent.closedN ? 32 : 0));
          w(71, ent.mSize ?? ent.vertices.length);
          w(72, ent.nSize ?? 1);
        } else {
          w(70, 64);
          w(71, ent.vertices.length);
          w(72, ent.faces?.length ?? 0);
        }
        /* sub-records repeat the owner's layer AND linetype — a vertex
           left at ByLayer under an owner with its own linetype is an
           AUDIT error on every single vertex ("linetype != owner's") */
        const subEnt = (): void => {
          w(100, 'AcDbEntity'); w(8, ent.layer || '0');
          if (ent.linetype) w(6, ent.linetype);
        };
        for (const p of ent.vertices) {
          w(0, 'VERTEX'); w(5, handle()); w(330, currentOwner);
          subEnt();
          w(100, 'AcDbVertex');
          w(100, isGrid ? 'AcDbPolygonMeshVertex' : 'AcDbPolyFaceMeshVertex');
          w(10, fmt(p.x)); w(20, fmt(p.y)); w(30, fmt(p.z ?? 0));
          w(70, isGrid ? 64 : 192);
        }
        if (!isGrid) {
          for (const f of ent.faces ?? []) {
            w(0, 'VERTEX'); w(5, handle()); w(330, currentOwner);
            subEnt();
            w(100, 'AcDbFaceRecord');
            w(10, 0); w(20, 0); w(30, 0);
            w(70, 128);
            f.slice(0, 4).forEach((idx, i) => w(71 + i, idx));
          }
        }
        w(0, 'SEQEND'); w(5, handle()); w(330, currentOwner);
        subEnt();
        return;
      }

      case 'image': {
        /* IMAGE needs an IMAGEDEF object; both are collected and written
           into the OBJECTS section after the entities. A WIPEOUT gets a
           NULL def instead — it has no raster file, and AutoCAD's own
           DXFOUT writes 340 0 there. */
        const defHandle = ent.wipeout ? '0'
          : imageDefFor(ent.path ?? '', ent.widthPx, ent.heightPx);
        /* same field layout, but the separator must name the class:
           DXFIN refuses a WIPEOUT spelled "100 AcDbRasterImage" */
        entStart(ent.wipeout ? 'WIPEOUT' : 'IMAGE', ent,
          ent.wipeout ? 'AcDbWipeout' : 'AcDbRasterImage');
        w(90, 0);
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        w(11, fmt(ent.uVector.x)); w(21, fmt(ent.uVector.y)); w(31, fmt(ent.uVector.z ?? 0));
        w(12, fmt(ent.vVector.x)); w(22, fmt(ent.vVector.y)); w(32, fmt(ent.vVector.z ?? 0));
        w(13, fmt(ent.widthPx)); w(23, fmt(ent.heightPx));
        w(340, defHandle);
        const hasClip = !!(ent.clip && ent.clip.length);
        /* 1 show, 2 show unaligned, 4 clip in use — AutoCAD writes 7 for
           a clipped record and its reader wants the flags to say so */
        w(70, 3 | (hasClip ? 4 : 0));
        w(280, hasClip ? 1 : 0);
        w(281, fmt(ent.brightness ?? 50));
        w(282, fmt(ent.contrast ?? 50));
        w(283, fmt(ent.fade ?? 0));
        w(360, 0);                           /* imagedef reactor (null) */
        const clip = ent.clip && ent.clip.length
          ? ent.clip
          : [{ x: -0.5, y: -0.5 }, { x: ent.widthPx - 0.5, y: ent.heightPx - 0.5 }];
        /* a polygonal boundary must CLOSE — AutoCAD repeats the first
           vertex as the last and its reader counts on it; an open ring
           leaves the record half-read ("Xdata wasn't read") */
        const first = clip[0], last = clip[clip.length - 1];
        const ring = clip.length > 2 && (first.x !== last.x || first.y !== last.y)
          ? [...clip, first] : clip;
        w(71, clip.length === 2 ? 1 : 2);
        w(91, ring.length);
        for (const p of ring) { w(14, fmt(p.x)); w(24, fmt(p.y)); }
        return;
      }

      case 'underlay': {
        const defHandle = underlayDefFor(
          ent.underlayKind, ent.path ?? '', ent.itemName ?? '');
        entStart(ent.underlayKind.toUpperCase() + 'UNDERLAY', ent,
          'AcDbUnderlayReference');
        w(340, defHandle);
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        w(41, fmt(ent.scale.x || 1)); w(42, fmt(ent.scale.y || 1)); w(43, fmt(ent.scale.z || 1));
        w(50, fmt((ent.rotation || 0) * DEG));
        w(280, ent.flags ?? 2);
        w(281, fmt(ent.contrast ?? 100));
        w(282, fmt(ent.fade ?? 0));
        for (const p of ent.clip ?? []) { w(11, fmt(p.x)); w(21, fmt(p.y)); }
        return;
      }

      case 'insert': {
        if (!ent.blockName) return;
        const attrs = ent.attributes ?? [];
        entStart('INSERT', ent, 'AcDbBlockReference');
        if (attrs.length) w(66, 1);          /* attributes follow */
        w(2, outBlockName(ent.blockName));
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        w(41, fmt(isNum(ent.scale.x) ? ent.scale.x : 1));
        w(42, fmt(isNum(ent.scale.y) ? ent.scale.y : 1));
        w(43, fmt(isNum(ent.scale.z) && ent.scale.z !== 0 ? ent.scale.z : 1));
        w(50, fmt((ent.rotation || 0) * DEG));
        if (isNum(ent.columnCount) && ent.columnCount > 1) w(70, ent.columnCount);
        if (isNum(ent.rowCount) && ent.rowCount > 1) w(71, ent.rowCount);
        if (isNum(ent.columnSpacing)) w(44, fmt(ent.columnSpacing));
        if (isNum(ent.rowSpacing)) w(45, fmt(ent.rowSpacing));
        writeExtrusion(ent);
        if (attrs.length) {
          writeXdata(ent);
          attrs.forEach(writeAttrib);
          w(0, 'SEQEND'); w(5, handle()); w(330, currentOwner);
          w(100, 'AcDbEntity'); w(8, ent.layer || '0');
        }
        return;
      }

      case 'leader':
        if (ent.vertices.length < 2) return;
        entStart('LEADER', ent, 'AcDbLeader');
        w(3, 'Standard');
        w(71, ent.hasArrowhead === false ? 0 : 1);
        w(72, 0);                            /* straight segments */
        w(73, 3);                            /* no annotation */
        w(76, ent.vertices.length);
        for (const p of ent.vertices) {
          w(10, fmt(p.x)); w(20, fmt(p.y)); w(30, fmt(p.z ?? 0));
        }
        return;

      case 'dimension': {
        entStart('DIMENSION', ent, 'AcDbDimension');
        if (ent.blockName) w(2, outBlockName(ent.blockName));
        w(10, fmt(ent.definitionPoint.x)); w(20, fmt(ent.definitionPoint.y));
        w(30, fmt(ent.definitionPoint.z ?? 0));
        const mid = ent.textMidpoint ?? ent.definitionPoint;
        w(11, fmt(mid.x)); w(21, fmt(mid.y)); w(31, fmt(mid.z ?? 0));
        w(70, ent.dimensionType);
        if (isNum(ent.attachment)) w(71, ent.attachment);
        if (isNum(ent.lineSpacingStyle) && ent.lineSpacingStyle !== 1) {
          w(72, ent.lineSpacingStyle);
        }
        if (isNum(ent.lineSpacingFactor) && ent.lineSpacingFactor !== 1) {
          w(41, fmt(ent.lineSpacingFactor));
        }
        if (isNum(ent.measurement)) w(42, fmt(ent.measurement));
        if (ent.text != null) w(1, encodeCadSymbols(ent.text));
        if (isNum(ent.textRotation) && ent.textRotation !== 0) {
          w(53, fmt(ent.textRotation * DEG));
        }
        if (isNum(ent.horizDirection) && ent.horizDirection !== 0) {
          w(51, fmt(ent.horizDirection * DEG));
        }
        w(3, 'Standard');                    /* dimension style */
        const p = (code: number, pt?: Point3): void => {
          if (!pt) return;
          w(code, fmt(pt.x)); w(code + 10, fmt(pt.y)); w(code + 20, fmt(pt.z ?? 0));
        };
        switch (ent.kind) {
          case 'linear':
            w(100, 'AcDbAlignedDimension');
            p(13, ent.point13); p(14, ent.point14);
            if (isNum(ent.rotation) && ent.rotation !== 0) w(50, fmt(ent.rotation * DEG));
            if (isNum(ent.obliqueAngle) && ent.obliqueAngle !== 0) w(52, fmt(ent.obliqueAngle * DEG));
            w(100, 'AcDbRotatedDimension');
            break;
          case 'aligned':
            w(100, 'AcDbAlignedDimension');
            p(13, ent.point13); p(14, ent.point14);
            if (isNum(ent.obliqueAngle) && ent.obliqueAngle !== 0) w(52, fmt(ent.obliqueAngle * DEG));
            break;
          case 'ordinate':
            w(100, 'AcDbOrdinateDimension');
            p(13, ent.point13); p(14, ent.point14);
            break;
          case 'radius':
            w(100, 'AcDbRadialDimension');
            p(15, ent.point15);
            if (isNum(ent.leaderLength)) w(40, fmt(ent.leaderLength));
            break;
          case 'diameter':
            w(100, 'AcDbDiametricDimension');
            p(15, ent.point15);
            if (isNum(ent.leaderLength)) w(40, fmt(ent.leaderLength));
            break;
          case 'angular3pt':
            w(100, 'AcDb3PointAngularDimension');
            p(13, ent.point13); p(14, ent.point14); p(15, ent.point15);
            break;
          case 'angular2ln':
            w(100, 'AcDb2LineAngularDimension');
            p(13, ent.point13); p(14, ent.point14);
            p(15, ent.point15); p(16, ent.point16);
            break;
          case 'arc':
            w(100, 'AcDbArcDimension');
            p(13, ent.point13); p(14, ent.point14); p(15, ent.point15);
            break;
          default:
            break;                           /* generic: AcDbDimension only */
        }
        return;
      }

      case 'acis': {
        /* a binary kernel payload (SAB) leaves as its SAT text form */
        const sat = ent.sat ?? (ent.sab ? sabToSat(ent.sab) : null);
        if (!sat) return;
        const name = ent.kind === 'region' ? 'REGION'
          : ent.kind === 'solid3d' ? '3DSOLID' : 'BODY';
        /* An ASM-dialect stream (21800 and up) cannot be spelled in an
           AC1015 DXF. AutoCAD's own R2000 DXFOUT downgrades the kernel
           data to the ACIS-400 text dialect — no record ids, reshaped
           fields — and its DXF reader refuses the modern spelling with
           "Premature end of object", discarding the ENTIRE file over one
           such entity. Until a downgrade translator exists, the entity
           stays out and the drawing says so. */
        const satVersion = parseInt(sat, 10);
        if (isFinite(satVersion) && satVersion >= 21800) {
          drawing.warnings.push(name + ' skipped in DXF: its ' +
            (sat.includes('asmheader') ? 'ASM' : 'kernel') + ' stream (v' +
            satVersion + ') has no AC1015 spelling AutoCAD accepts.');
          return;
        }
        entStart(name, ent, 'AcDbModelerGeometry');
        w(70, 1);
        for (const line of sat.split('\n')) {
          /* group 1 opens a SAT line; group 3 carries continuations.
             The text travels ciphered (159 - c), as CAD writes it. */
          let rest = '';
          const src2 = line.replace(/\r$/, '');
          for (let k = 0; k < src2.length; k++) {
            const ch = src2.charCodeAt(k);
            rest += String.fromCharCode(ch <= 32 || ch > 126 ? ch : 159 - ch);
          }
          w(1, rest.slice(0, 255));
          rest = rest.slice(255);
          while (rest.length) {
            w(3, rest.slice(0, 255));
            rest = rest.slice(255);
          }
        }
        if (ent.kind === 'solid3d') w(100, 'AcDb3dSolid');
        else if (ent.kind === 'region') w(100, 'AcDbRegion');
        return;
      }

      case 'viewport':
        entStart('VIEWPORT', ent, 'AcDbViewport');
        w(10, fmt(ent.center.x)); w(20, fmt(ent.center.y)); w(30, fmt(ent.center.z ?? 0));
        w(40, fmt(ent.width)); w(41, fmt(ent.height));
        w(68, 1); w(69, 1);
        w(12, fmt(ent.viewCenter?.x ?? 0)); w(22, fmt(ent.viewCenter?.y ?? 0));
        if (ent.viewTarget) {
          w(17, fmt(ent.viewTarget.x)); w(27, fmt(ent.viewTarget.y)); w(37, fmt(ent.viewTarget.z ?? 0));
        }
        if (ent.viewDirection) {
          w(16, fmt(ent.viewDirection.x)); w(26, fmt(ent.viewDirection.y)); w(36, fmt(ent.viewDirection.z ?? 0));
        }
        if (isNum(ent.twistAngle) && ent.twistAngle !== 0) w(51, fmt(ent.twistAngle * DEG));
        if (isNum(ent.lensLength)) w(42, fmt(ent.lensLength));
        w(45, fmt(ent.viewHeight ?? ent.height));
        w(90, ent.statusFlag ?? 0);
        return;

      case 'light':
        /* LIGHT is a class entity; its glyph is a point plus its name */
        entStart('POINT', ent, 'AcDbPoint');
        w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
        return;

      case 'pointcloud': {
        /* an external scan has no R2000 record; its extents are written as
           a box so the placement survives */
        const a = ent.extentsMin, c2 = ent.extentsMax;
        entStart('LWPOLYLINE', ent, 'AcDbPolyline');
        w(90, 4); w(70, 1);
        w(10, fmt(a.x)); w(20, fmt(a.y));
        w(10, fmt(c2.x)); w(20, fmt(a.y));
        w(10, fmt(c2.x)); w(20, fmt(c2.y));
        w(10, fmt(a.x)); w(20, fmt(c2.y));
        return;
      }

      case 'ole': {
        /* OLE2FRAME carries its document in 310 chunks; the frame corners
           are the two documented placement points */
        entStart('OLE2FRAME', ent, 'AcDbOle2Frame');
        w(70, 2);                          /* OLE version */
        w(3, 'OLE');
        const [ul, , lr] = ent.corners;
        w(10, fmt(ul.x)); w(20, fmt(ul.y)); w(30, fmt(ul.z ?? 0));
        w(11, fmt(lr.x)); w(21, fmt(lr.y)); w(31, fmt(lr.z ?? 0));
        w(71, ent.oleType);
        w(72, ent.tileMode ?? 0);
        w(73, ent.lockAspect ? 1 : 0);
        const bytes = ent.data ?? new Uint8Array(0);
        w(90, bytes.length);
        for (let i = 0; i < bytes.length; i += 127) {
          let hex = '';
          for (let k = i; k < Math.min(i + 127, bytes.length); k++) {
            hex += bytes[k].toString(16).padStart(2, '0').toUpperCase();
          }
          w(310, hex);
        }
        w(1, 'OLE');
        return;
      }

      case 'mleader': {
        /* written as its leader lines plus the annotation text, which is
           what every reader can draw without the MLEADER class */
        for (const leader of ent.leaders) {
          for (const line of leader.lines) {
            if (line.length < 2) continue;
            entStart('LWPOLYLINE', ent, 'AcDbPolyline');
            w(90, line.length);
            w(70, 0);
            for (const p of line) { w(10, fmt(p.x)); w(20, fmt(p.y)); }
          }
        }
        if (ent.text && ent.textPosition) {
          const t: Entity = {
            type: 'mtext', layer: ent.layer, color: ent.color,
            position: ent.textPosition, text: ent.text,
            height: ent.textHeight ?? 2.5, rotation: ent.textRotation ?? 0
          };
          writeEntityBody(t);
        }
        return;
      }

      case 'table': {
        /* the grid as polylines and the cell text, so the table is visible
           even where the ACAD_TABLE class is unavailable */
        const xs: number[] = [ent.position.x];
        for (const wdt of ent.columnWidths) xs.push(xs[xs.length - 1] + wdt);
        const ys: number[] = [ent.position.y];
        for (const h of ent.rowHeights) ys.push(ys[ys.length - 1] - h);
        const box = (x1: number, y1: number, x2: number, y2: number): void => {
          entStart('LWPOLYLINE', ent, 'AcDbPolyline');
          w(90, 4); w(70, 1);
          w(10, fmt(x1)); w(20, fmt(y1));
          w(10, fmt(x2)); w(20, fmt(y1));
          w(10, fmt(x2)); w(20, fmt(y2));
          w(10, fmt(x1)); w(20, fmt(y2));
        };
        for (let rIdx = 0; rIdx < ent.numRows; rIdx++) {
          for (let cIdx = 0; cIdx < ent.numColumns; cIdx++) {
            box(xs[cIdx], ys[rIdx], xs[cIdx + 1], ys[rIdx + 1]);
            const cell = ent.cells[rIdx * ent.numColumns + cIdx];
            if (!cell?.text) continue;
            const h = cell.textHeight && cell.textHeight > 0 ? cell.textHeight
              : Math.max(0.1, Math.abs(ys[rIdx + 1] - ys[rIdx]) * 0.6);
            writeEntityBody({
              type: 'text', layer: ent.layer, color: ent.color,
              position: { x: xs[cIdx] + h * 0.2, y: ys[rIdx + 1] + h * 0.2, z: 0 },
              text: cell.text, height: h, rotation: 0
            });
          }
        }
        return;
      }

      case 'proxy': {
        /* A bare proxy (no sealed payload) explodes into its decoded
           picture, as before. One that still carries the payload leaves
           as a real ACAD_PROXY_ENTITY record — class id into CLASSES,
           display list and application data as 310 chunks, references,
           version word and origin flag — so the owning application still
           recognizes its object after a round trip through DXF. */
        if (!ent.data && !ent.graphicsData) {
          for (const g of ent.graphics) writeEntityBody(g);
          return;
        }
        entStart('ACAD_PROXY_ENTITY', ent, 'AcDbProxyEntity');
        w(90, 498);                        /* the proxy entity class itself */
        w(91, proxyClassId.get(
          proxyClassKey(ent.appClass, ent.sourceType, 'ACAD_PROXY_ENTITY')) ?? 0);
        writeProxyBody(ent);
        return;
      }

      /* unknown: one that arrived through DXF still holds its raw tags and
         leaves as the original record, verbatim, under a fresh handle and
         the real owner. Without tags (DWG-sealed or synthetic) it is
         written through its cached display list when there is one — the
         old behavior, unchanged. */
      case 'unknown':
        if (ent.tags?.length) {
          w(0, ent.sourceType);
          writeSealedTags(ent.tags, handle(), currentOwner);
          return;
        }
        for (const g of ent.graphics ?? []) writeEntityBody(g);
        return;
    }
  };

  /* ---- BLOCKS ---- */
  w(0, 'SECTION'); w(2, 'BLOCKS');
  for (const nm of ['*Model_Space', '*Paper_Space']) {
    const owner = brHandleOf(nm);
    w(0, 'BLOCK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(8, '0'); w(100, 'AcDbBlockBegin');
    w(2, nm); w(70, 0); w(10, 0); w(20, 0); w(30, 0); w(3, nm); w(1, '');
    w(0, 'ENDBLK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(8, '0'); w(100, 'AcDbBlockEnd');
  }
  for (const nm of blockNames) {
    const def = blocks[nm];
    const base = def.basePoint ?? { x: 0, y: 0, z: 0 };
    const owner = blockRecHandle[nm];
    w(0, 'BLOCK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(8, '0'); w(100, 'AcDbBlockBegin');
    w(2, outBlockName(nm)); w(70, 0);
    w(10, fmt(base.x)); w(20, fmt(base.y)); w(30, fmt(base.z ?? 0));
    w(3, outBlockName(nm)); w(1, '');
    currentOwner = owner;
    def.entities.forEach(writeEntity);
    currentOwner = msRecHandle;
    w(0, 'ENDBLK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(8, '0'); w(100, 'AcDbBlockEnd');
  }
  w(0, 'ENDSEC');

  /* ---- ENTITIES ---- */
  w(0, 'SECTION'); w(2, 'ENTITIES');
  currentOwner = msRecHandle;
  drawing.entities.forEach(writeEntity);
  if (drawing.paperSpace && drawing.paperSpace.length) {
    currentOwner = psRecHandle;
    inPaperSpace = true;
    drawing.paperSpace.forEach(writeEntity);
    inPaperSpace = false;
    currentOwner = msRecHandle;
  }
  w(0, 'ENDSEC');

  /* ---- OBJECTS (root dictionary, layouts, groups, mline styles, images) ---- */
  const groups = drawing.groups ?? [];
  const xrecords = drawing.xrecords ?? [];
  const geo = drawing.geoData;
  /* Unconditional: a DXF without the root dictionary (and the group and
     plot-style dictionaries under it) is discarded by DXFIN outright. */
  {
    w(0, 'SECTION'); w(2, 'OBJECTS');
    const rootHandle = 'C';
    const imgDictHandle = imageDefs.size ? handle() : '';
    const layoutDictHandle = outLayouts.length ? handle() : '';
    /* always present, even empty: DXFIN discards the drawing when the
       named objects dictionary lists no GroupTable */
    const groupDictHandle = handle();
    const mlDictHandle = mlStyles.length ? handle() : '';
    const geoHandle = geo ? handle() : '';
    const underlayDicts = new Map<string, string>();
    for (const kind of underlayKinds) underlayDicts.set(kind, handle());
    const groupHandles = groups.map(() => handle());
    const mlHandles = mlStyleHandles;         /* fixed before the entities */
    const proxyObjHandles = proxyObjs.map(() => handle());
    const sealedObjHandles = sealedObjs.map(() => handle());

    w(0, 'DICTIONARY'); w(5, rootHandle); w(330, 0);
    w(100, 'AcDbDictionary'); w(281, 1);
    w(3, 'ACAD_PLOTSTYLENAME'); w(350, plotStyleDictHandle);
    w(3, 'ACAD_GROUP'); w(350, groupDictHandle);
    if (layoutDictHandle) { w(3, 'ACAD_LAYOUT'); w(350, layoutDictHandle); }
    if (mlDictHandle) { w(3, 'ACAD_MLINESTYLE'); w(350, mlDictHandle); }
    if (imgDictHandle) { w(3, 'ACAD_IMAGE_DICT'); w(350, imgDictHandle); }
    if (geoHandle) { w(3, 'ACAD_GEOGRAPHICDATA'); w(350, geoHandle); }
    for (const [kind, h] of underlayDicts) {
      w(3, 'ACAD_' + kind.toUpperCase() + 'DEFINITIONS');
      w(350, h);
    }
    /* proxy objects keep their dictionary names, listed straight under
       the named objects dictionary; an unnamed one still needs a key */
    proxyObjs.forEach((p, i) => {
      w(3, p.name ?? ('PROXY_OBJECT_' + (i + 1)));
      w(350, proxyObjHandles[i]);
    });
    /* sealed unknown objects sit beside them under their retained names */
    sealedObjs.forEach((o, i) => {
      w(3, o.name ?? ('SEALED_OBJECT_' + (i + 1)));
      w(350, sealedObjHandles[i]);
    });

    /* the plot-style dictionary every LAYER's group 390 points into:
       a with-default dictionary whose one entry, Normal, is a
       placeholder — exactly the shape AutoCAD itself writes */
    w(0, 'ACDBDICTIONARYWDFLT'); w(5, plotStyleDictHandle); w(330, rootHandle);
    w(100, 'AcDbDictionary'); w(281, 1);
    w(3, 'Normal'); w(350, plotStyleHolderHandle);
    w(100, 'AcDbDictionaryWithDefault'); w(340, plotStyleHolderHandle);
    w(0, 'ACDBPLACEHOLDER'); w(5, plotStyleHolderHandle); w(330, plotStyleDictHandle);

    /* ---- dictionary-owned proxy objects: same record shape as the
       entity form, under AcDbProxyObject ---- */
    proxyObjs.forEach((p, i) => {
      w(0, 'ACAD_PROXY_OBJECT'); w(5, proxyObjHandles[i]); w(330, rootHandle);
      w(100, 'AcDbProxyObject');
      w(90, 499);                        /* the proxy object class itself */
      w(91, proxyClassId.get(
        proxyClassKey(p.appClass, p.sourceType, 'ACAD_PROXY_OBJECT')) ?? 0);
      writeProxyBody(p);
    });

    /* ---- sealed unknown objects: the retained record, verbatim, with
       only the handle renumbered and the owner repointed at the named
       objects dictionary that now lists it ---- */
    sealedObjs.forEach((o, i) => {
      w(0, o.sourceType);
      writeSealedTags(o.tags ?? [], sealedObjHandles[i], rootHandle);
    });

    for (const [kind, dictH] of underlayDicts) {
      const defs = [...underlayDefs.values()].filter((d) => d.kind === kind);
      w(0, 'DICTIONARY'); w(5, dictH); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      defs.forEach((d, i) => { w(3, kind.toUpperCase() + '_' + (i + 1)); w(350, d.handle); });
      for (const d of defs) {
        w(0, kind.toUpperCase() + 'DEFINITION');
        w(5, d.handle); w(330, dictH);
        w(100, 'AcDbUnderlayDefinition');
        w(1, d.path);
        w(2, d.itemName);
      }
    }

    if (geo) {
      w(0, 'GEODATA'); w(5, geoHandle); w(330, rootHandle);
      w(100, 'AcDbGeoData');
      w(90, geo.version ?? 3);
      w(330, msRecHandle);                /* host block: model space */
      w(70, geo.coordinatesType ?? 0);
      w(10, fmt(geo.designPoint.x)); w(20, fmt(geo.designPoint.y));
      w(30, fmt(geo.designPoint.z ?? 0));
      w(11, fmt(geo.referencePoint.x)); w(21, fmt(geo.referencePoint.y));
      w(31, fmt(geo.referencePoint.z ?? 0));
      w(40, fmt(geo.horizontalUnitScale ?? 1));
      w(91, geo.horizontalUnits ?? 1);
      w(41, fmt(geo.verticalUnitScale ?? geo.horizontalUnitScale ?? 1));
      w(92, geo.verticalUnits ?? geo.horizontalUnits ?? 1);
      const up = geo.upDirection ?? { x: 0, y: 0, z: 1 };
      w(210, fmt(up.x)); w(220, fmt(up.y)); w(230, fmt(up.z ?? 1));
      const north = geo.northDirection ?? { x: 0, y: 1 };
      w(12, fmt(north.x)); w(22, fmt(north.y));
      w(95, geo.scaleEstimation ?? 1);
      w(141, fmt(geo.userScaleFactor ?? 1));
      w(294, geo.seaLevelCorrection ? 1 : 0);
      w(142, fmt(geo.seaLevelElevation ?? 0));
      w(143, fmt(geo.projectionRadius ?? 0));
      /* the definition string leaves in 255-char chunks: 303* then 301;
         embedded line breaks travel in AutoCAD's caret form */
      const cs = (geo.coordinateSystem ?? '').replace(/\r?\n/g, '^J');
      const chunks: string[] = [];
      for (let i = 0; i < cs.length; i += 255) chunks.push(cs.slice(i, i + 255));
      if (!chunks.length) chunks.push('');
      for (let i = 0; i < chunks.length - 1; i++) w(303, chunks[i]);
      w(301, chunks[chunks.length - 1]);
      w(302, geo.geoRssTag ?? (geo.latitude !== undefined
        ? `<georss:point>${geo.latitude} ${geo.longitude ?? 0}</georss:point>` : ''));
      w(305, ''); w(306, ''); w(307, '');
      w(93, 0); w(96, 0);                 /* no geo mesh */
    }

    if (layoutDictHandle) {
      w(0, 'DICTIONARY'); w(5, layoutDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      outLayouts.forEach(({ l, h }) => { w(3, l.name); w(350, h); });
      outLayouts.forEach(({ l, h, brh }, i) => {
        w(0, 'LAYOUT'); w(5, h); w(330, layoutDictHandle);
        w(100, 'AcDbPlotSettings');
        w(1, ''); w(2, l.paperSize ?? 'none_device');
        w(4, ''); w(6, '');
        w(7, l.plotStyleSheet ?? '');
        w(70, 688); w(72, 0); w(73, 0); w(74, 0); w(75, 0);
        w(100, 'AcDbLayout');
        w(1, l.name);
        w(70, 1); w(71, l.tabOrder ?? i);
        w(10, fmt(l.limMin?.x ?? 0)); w(20, fmt(l.limMin?.y ?? 0));
        w(11, fmt(l.limMax?.x ?? 0)); w(21, fmt(l.limMax?.y ?? 0));
        w(12, fmt(l.insBase?.x ?? 0)); w(22, fmt(l.insBase?.y ?? 0)); w(32, fmt(l.insBase?.z ?? 0));
        if (l.extMin) { w(14, fmt(l.extMin.x)); w(24, fmt(l.extMin.y)); w(34, fmt(l.extMin.z ?? 0)); }
        if (l.extMax) { w(15, fmt(l.extMax.x)); w(25, fmt(l.extMax.y)); w(35, fmt(l.extMax.z ?? 0)); }
        w(330, brh);                        /* the block record, which 340s back */
      });
    }
    {
      w(0, 'DICTIONARY'); w(5, groupDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      groups.forEach((g, i) => { w(3, g.name); w(350, groupHandles[i]); });
      groups.forEach((g, i) => {
        w(0, 'GROUP'); w(5, groupHandles[i]); w(330, groupDictHandle);
        w(100, 'AcDbGroup');
        w(300, g.description ?? '');
        w(70, g.name.startsWith('*') ? 1 : 0);
        w(71, g.selectable === false ? 0 : 1);
        for (const h of g.entityHandles) {
          const nh = newHandleOf.get(h.toUpperCase());
          if (nh) w(340, nh);              /* unwritten members stay out */
        }
      });
    }
    if (mlDictHandle) {
      w(0, 'DICTIONARY'); w(5, mlDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      mlStyles.forEach((m, i) => { w(3, m.name); w(350, mlHandles[i]); });
      mlStyles.forEach((m, i) => {
        w(0, 'MLINESTYLE'); w(5, mlHandles[i]); w(330, mlDictHandle);
        w(100, 'AcDbMlineStyle');
        w(2, m.name); w(70, m.flags ?? 0);
        w(3, m.description ?? '');
        w(62, m.fillColor?.kind === 'aci' ? m.fillColor.index : 256);
        w(51, fmt((m.startAngle ?? Math.PI / 2) * DEG));
        w(52, fmt((m.endAngle ?? Math.PI / 2) * DEG));
        w(71, m.elements.length);
        for (const el of m.elements) {
          w(49, fmt(el.offset));
          w(62, el.color.kind === 'aci' ? el.color.index : 0);
          w(6, el.linetype ?? 'BYLAYER');
        }
      });
    }
    if (xrecords.length) {
      /* application data lives under its own dictionary so the records
         keep an owner without inventing a place in the standard tree */
      const xrDictHandle = handle();
      const xrHandles = xrecords.map(() => handle());
      w(0, 'DICTIONARY'); w(5, xrDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      xrecords.forEach((x, i) => {
        w(3, x.name ?? ('ND_XRECORD_' + (i + 1)));
        w(350, xrHandles[i]);
      });
      xrecords.forEach((x, i) => {
        w(0, 'XRECORD'); w(5, xrHandles[i]); w(330, xrDictHandle);
        w(100, 'AcDbXrecord'); w(280, 1);
        for (const v of x.values) {
          if ('point' in v) {
            w(v.code, fmt(v.point.x));
            w(v.code + 10, fmt(v.point.y));
            w(v.code + 20, fmt(v.point.z ?? 0));
          } else {
            w(v.code, typeof v.value === 'number' ? fmt(v.value) : v.value);
          }
        }
      });
    }
    if (imgDictHandle) {
      w(0, 'DICTIONARY'); w(5, imgDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      let defIdx = 0;
      for (const [, def] of imageDefs) {
        w(3, 'ND_IMAGE_' + (++defIdx));
        w(350, def.handle);
      }
      for (const [key, def] of imageDefs) {
        const path = key.slice(0, key.lastIndexOf('|'));
        w(0, 'IMAGEDEF'); w(5, def.handle); w(330, imgDictHandle);
        w(100, 'AcDbRasterImageDef');
        w(90, 0);
        w(1, path);
        w(10, fmt(def.w)); w(20, fmt(def.h));
        w(11, 1); w(21, 1);
        w(280, 1); w(281, 0);
      }
    }
    w(0, 'ENDSEC');
  }

  w(0, 'EOF');
  out[handseedAt] = handleCounter.toString(16).toUpperCase();
  return out.join('\n') + '\n';
};

/** Write a binary DXF of the same content as writeDxf.
 *  `narrowCodes` selects the pre-R13 single-byte group-code form. */
export const writeDxfBinary = (
  drawing: Drawing, options: { narrowCodes?: boolean } = {}
): Uint8Array => {
  const text = writeDxf(drawing);
  const lines = text.split('\n');
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (!isFinite(code)) { i -= 1; continue; }
    pairs.push([code, lines[i + 1]]);
  }
  return pairsToBinaryDxf(pairs, options.narrowCodes);
};
