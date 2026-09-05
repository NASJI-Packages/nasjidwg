/* nasjidwg — ASCII DXF R2000 (AC1015) writer.
 *
 * Ported from nasjicad's battle-tested dxf.js against the richer nasjidwg
 * document model. The model keeps exact geometry (ellipse params, spline
 * knots, hatch loops with bulges), so this writer emits it exactly instead
 * of the app-era approximations.
 */

import type {
  BlockDefinition, Color, Drawing, Entity, HatchBoundary, Layer, Layout,
  MLeaderEntity, MLeaderStyle, MTextEntity, Point3, ProxyEntity, TableEntity,
  TableStyle, TableStyleCell, TextEntity, UnknownObject, XRecord
} from '../core/model.js';
import { sabToSat } from '../acis/sab.js';
import { nearestAci } from '../core/color.js';
import { BitWriter } from '../dwg/bitwriter.js';
import { hasComplexScript, mirrorBrackets, shapeArabic } from '../text/arabic.js';
import { encodeCadSymbols, escapeUnicode } from '../text/escapes.js';
import { flattenMtextParagraphs } from '../text/mtext.js';
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

/** Options of the DXF writer. */
export interface DxfWriteOptions {
  /** Keep every source handle: entities, table records, block records,
   *  layouts, objects and sealed objects leave under the numbers the
   *  source file gave them, and fresh numbers are minted above the
   *  highest of them. What a sealed body names by handle then stays
   *  valid verbatim, so the chains the reference checks — an entity's
   *  ACAD_FIELD → FIELD, a block record's ACAD_ENHANCEDBLOCK → its
   *  evaluation graph, an ACAD_ASSOCNETWORK — survive exactly as the
   *  source spelled them. Off by default: every object is renumbered
   *  from 0x100 in write order, and the handle-typed groups of sealed
   *  bodies are remapped through the output's numbering (nulled when
   *  the target is not written). */
  preserveHandles?: boolean;
}

export const writeDxf = (drawing: Drawing, options: DxfWriteOptions = {}): string => {
  const preserve = options.preserveHandles === true;
  const up = (s: string): string => s.trim().toUpperCase();
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

  const blocks = drawing.blocks;
  const userBlockNames = Object.keys(blocks).filter((nm) =>
    blocks[nm] && !isSystemBlock(nm) && !blocks[nm].isLayout);
  /* the non-current paper-space layouts, which both readers keep as
     blocks named *Paper_Space<n>: written as the reference writes them —
     a BLOCK_RECORD, a BLOCK holding the layout's entities (flagged 67),
     and the LAYOUT object pointing at the record */
  const paperBlockNames = Object.keys(blocks).filter((nm) =>
    blocks[nm] && /^\*paper_space.+$/i.test(nm));
  /** Every entity the file will hold: model space, the current paper
   *  space, the other layouts and the block definitions. */
  const scanEntities = (): Entity[] => {
    const out = [...drawing.entities, ...(drawing.paperSpace ?? [])];
    for (const nm of userBlockNames) out.push(...blocks[nm].entities);
    for (const nm of paperBlockNames) out.push(...blocks[nm].entities);
    return out;
  };

  /* ---- handles -----------------------------------------------------------
     Source handle → the number this file gives the object. Without
     preserveHandles every object is renumbered from 0x100 in write order
     (draw order is handle order, so the array order is kept); with it
     every object that carries a source handle keeps it, and the counter
     starts above the highest number the drawing knows, so a minted
     handle never collides with a kept one. `claim` is the one door: the
     first object to claim a source handle owns its number, and a second
     claimant of the same number (a corrupt source) is minted a fresh
     one rather than aliased. */
  const outMap = new Map<string, string>();
  const srcAll = new Set<string>();
  {
    const note = (h?: string): void => {
      if (h && /^\s*[0-9A-Fa-f]+\s*$/.test(h)) srcAll.add(up(h));
    };
    const noteEnts = (list?: Entity[]): void => {
      for (const e of list ?? []) {
        note(e.handle);
        if (e.type === 'insert') for (const a of e.attributes ?? []) note(a.handle);
      }
    };
    noteEnts(drawing.entities); noteEnts(drawing.paperSpace);
    for (const b of Object.values(blocks)) { if (b) { note(b.handle); noteEnts(b.entities); } }
    for (const l of drawing.layouts ?? []) { note(l.handle); note(l.blockHandle); }
    for (const r of [...drawing.layers, ...drawing.linetypes, ...drawing.textStyles,
      ...(drawing.tableStyles ?? []), ...(drawing.mleaderStyles ?? [])]) note(r.handle);
    for (const p of drawing.proxyObjects ?? []) note(p.handle);
    for (const o of drawing.unknownObjects ?? []) note(o.handle);
    for (const x of drawing.xrecords ?? []) note(x.handle);
    if (preserve) {
      let max = 0;
      for (const h of srcAll) max = Math.max(max, parseInt(h, 16));
      if (Number.isFinite(max)) handleCounter = Math.max(handleCounter, max + 1);
    }
  }
  const claim = (src?: string): string => {
    const k = src ? up(src) : '';
    if (k && !outMap.has(k)) {
      /* only a genuine hex number can be kept; any other spelling (a
         hand-built drawing's labels) is followed but renumbered */
      const h = preserve && /^[0-9A-F]+$/.test(k) && parseInt(k, 16) > 0 ? k : handle();
      outMap.set(k, h);
      return h;
    }
    return handle();
  };
  /** A fixed canonical number (the root dictionary's C, the space
   *  records' 1F/1B, the plot-style pair E/F) — unless, under
   *  preserveHandles, the source gave that number to an object of its
   *  own, when a fresh one is minted instead. */
  const fixed = (pref: string): string => preserve && srcAll.has(pref) ? handle() : pref;
  /** The number a source handle got in this file, whichever side it is
   *  on; undefined when what it named is not written here. */
  const outHandleOf = (src?: string): string | undefined =>
    src ? outMap.get(up(src)) : undefined;

  /* ---- ACAD_TABLE geometry blocks ---------------------------------------
     A table is a block reference in the reference's spelling: group 2
     names an anonymous *T<n> block whose record (343) the table owns,
     and the reference regenerates that block's picture from the grid
     itself. Each table written here gets its own *T<n> record. A table
     that already names such a block (one read from a DXF) carries that
     block's entities across under the new number; every other table's
     block holds the grid drawn as polylines and text — what a reader
     without the class can still draw. The named source block is
     consumed here rather than written again as an ordinary block. */
  const tableEntities = scanEntities()
    .filter((e): e is TableEntity => e.type === 'table');
  const tableBlockOf = new Map<TableEntity, { name: string; rec: string; src?: BlockDefinition }>();
  const consumedBlocks = new Set<string>();
  tableEntities.forEach((t, i) => {
    const nm = t.blockName ?? '';
    const src = /^\*T/i.test(nm) && userBlockNames.includes(nm) ? blocks[nm] : undefined;
    if (src) consumedBlocks.add(nm);
    tableBlockOf.set(t, { name: '*T' + (i + 1), rec: src ? claim(src.handle) : handle(), src });
  });
  const tableBlocks = [...tableBlockOf.values()];
  const usesTables = tableBlocks.length > 0;
  const usesMLeaders = scanEntities().some((e) => e.type === 'mleader');
  const blockNames = userBlockNames.filter((nm) => !consumedBlocks.has(nm));

  /* ---- external references ---------------------------------------------
     A block with `xref` leaves as an attachment — the xref (and overlay)
     bit in its BLOCK flags and the stored path in group 1, no owned
     entities — and the reference re-attaches the file on open. The
     attachment's own layers, linetypes and text styles (`xref|name`)
     travel only beside a block written that way, flagged dependent (70
     bit 16, plus the resolved bit 32 the reference's own DXF carries);
     written as ordinary records they are audited one by one for the bar
     in their names, so the rest stay home — the DWG writer's rule. */
  const xrefBlockNames = new Set(blockNames
    .filter((nm) => blocks[nm].xref).map((nm) => nm.toLowerCase()));
  const xrefOf = (name: string): string | undefined => {
    const bar = name.indexOf('|');
    if (bar <= 0) return undefined;
    const owner = name.slice(0, bar).toLowerCase();
    return xrefBlockNames.has(owner) ? owner : undefined;
  };
  const travels = (r: { name: string; xrefDependent?: boolean }): boolean =>
    !r.xrefDependent || xrefOf(r.name) !== undefined;
  const XREF_DEP = 16 | 32;                 /* dependent + resolved */

  const ownLayers = drawing.layers.filter(travels);
  const layers: Layer[] = ownLayers.length ? ownLayers : [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
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
  /* The source numbers of the two space records come from the layouts
     that lay them out (both readers keep them there): under
     preserveHandles the records keep those numbers, and either way a
     sealed record the source hung on a space's block record is followed
     through them. */
  const layoutsIn: Layout[] = drawing.layouts ?? [];
  const msSrc = layoutsIn.find((l) => l.blockName
    ? /^\*model_space$/i.test(l.blockName) : /model/i.test(l.name))?.blockHandle;
  const psSrc = layoutsIn.find((l) => l.blockName
    ? /^\*paper_space$/i.test(l.blockName) : !/model/i.test(l.name))?.blockHandle;
  const msRecHandle = preserve && msSrc ? claim(msSrc) : fixed('1F');
  const psRecHandle = preserve && psSrc ? claim(psSrc) : fixed('1B');
  if (!preserve) {
    if (msSrc) outMap.set(up(msSrc), msRecHandle);
    if (psSrc) outMap.set(up(psSrc), psRecHandle);
  }
  /* ACAD_PLOTSTYLENAME and the placeholder its "Normal" entry points at.
     Every LAYER record must name its plot style through group 390 — DXFIN
     discards the whole drawing when the group is missing. */
  const plotStyleDictHandle = fixed('E');
  const plotStyleHolderHandle = fixed('F');
  const blockRecHandle: Record<string, string> = {};
  for (const nm of blockNames) blockRecHandle[nm] = claim(blocks[nm].handle);
  for (const nm of paperBlockNames) blockRecHandle[nm] = claim(blocks[nm].handle);

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
  /* Table and multileader records name their style by hard handle (342 /
     340) and their text style and linetype the same way, so those
     records' handles are fixed here, ahead of the tables that assign
     them. The style objects are the drawing's own TABLESTYLE and
     MLEADERSTYLE records — a "Standard" synthesized beside them when the
     drawing names none — listed under ACAD_TABLESTYLE / ACAD_MLEADERSTYLE
     in the named objects dictionary; every table and multileader points
     at the one its styleName names, else at Standard (the reference
     audits a null style). One record per name. */
  const styleHandleOf = new Map<string, string>();     /* lower-cased name */
  const ltypeHandleOf = new Map<string, string>();
  const withStandard = <T extends { name: string }>(list: T[] | undefined, standard: T): T[] => {
    const seen = new Set<string>();
    return (list?.some((s) => /^standard$/i.test(s.name)) ? [...list] : [standard, ...(list ?? [])])
      .filter((s) => !seen.has(s.name.toLowerCase()) && !!seen.add(s.name.toLowerCase()));
  };
  const usesTableStyles = usesTables || !!drawing.tableStyles?.length;
  const usesMLeaderStyles = usesMLeaders || !!drawing.mleaderStyles?.length;
  const tableStylesOut = usesTableStyles
    ? withStandard(drawing.tableStyles, { name: 'Standard' }) : [];
  const mleaderStylesOut = usesMLeaderStyles
    ? withStandard(drawing.mleaderStyles, { name: 'Standard' }) : [];
  const tableStyleDictHandle = usesTableStyles ? handle() : '';
  const tableStyleHandles = tableStylesOut.map((s) => claim(s.handle));
  const mleaderStyleDictHandle = usesMLeaderStyles ? handle() : '';
  const mleaderStyleHandles = mleaderStylesOut.map((s) => claim(s.handle));
  const styleHandleFor = <T extends { name: string }>(
    list: T[], handles: string[], name?: string
  ): string => {
    const key = (name ?? '').toLowerCase();
    let i = list.findIndex((s) => s.name.toLowerCase() === key);
    if (i < 0) i = list.findIndex((s) => /^standard$/i.test(s.name));
    return handles[i] ?? '0';
  };
  const tableStyleHandleFor = (name?: string): string =>
    styleHandleFor(tableStylesOut, tableStyleHandles, name);
  const mleaderStyleHandleFor = (name?: string): string =>
    styleHandleFor(mleaderStylesOut, mleaderStyleHandles, name);
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
  /* ---- the sealed objects: ownership-preserving passthrough -------------
     A sealed object goes out under its ORIGINAL owner when that owner is
     written — an entity, a block record (the two space blocks through
     their layouts), a layer/linetype/style record, a layout, a proxy
     object, another sealed object, a sealed dictionary — and only a
     record whose owner is not in the file takes the place its dictPath
     names on the rebuilt named-objects tree, or stays home. What this
     writer can spell: a record that arrived through DXF (its tags,
     verbatim), a dictionary (from its decoded entries — the grammar is
     fully known — each under the code it carried, with the hard-owner
     flag and the cloning code), an XRECORD read from a DWG (from the
     values decoded beside its seal). A record sealed as DWG bits alone
     — a FIELD, a graph node, a visual style read from a DWG — has no DXF
     spelling here and stays home, said so in the warnings.
     One exception, on the version axis: the reference reads every record
     with the filer of the DECLARED version, and a class whose spelling
     changed after R2000 cannot travel verbatim from a later file into
     this AC1015 one. The known cases are the records that embed typed
     values — TABLECONTENT's cells, DATALINK's connection data — whose
     R2008+ spelling (93/90/…/94/300/302/304 ACVALUE_END) makes the R2000
     filer stop with "Premature end of object", and the whole file is
     discarded. Such a record is recognized by its class when the source
     was beyond R2000, and by the ACVALUE_END marker itself whatever the
     source said. The table's content is written natively from the
     model, so leaving the record out loses nothing visible; from an
     R2000 source the record is in R2000 spelling and travels. */
  const POST_R2000_SPELLING = new Set(['TABLECONTENT', 'DATALINK']);
  const sourceBeyondR2000 =
    ['R2004', 'R2007', 'R2010', 'R2013', 'R2018'].includes(drawing.header.version ?? '');
  /* The AcDbAssoc* framework (a constraint network: the network, its
     constraint groups, variables, dependencies and the dependency
     bodies of the block constraint parameters) is respelled at R2013:
     the reference's own R2000 DXF of its Structural sample spells the
     constraint group compactly and the network with one version word
     fewer, and its R2000 filer stops on the 2018 form ("Premature end
     of object" in ACDBASSOC2DCONSTRAINTGROUP, file discarded). From a
     post-R2000 source the family stays home as one unit; whatever hard
     references reach into it (a constraint parameter node, the graph
     above it) settles home after it, reported by kind. */
  const assocKind = (kind: string): boolean =>
    kind.startsWith('ACDBASSOC') || kind.startsWith('ASSOC') || /DEPENDENCYBODY$/.test(kind);
  const spelledPastR2000 = (o: { sourceType: string; tags?: [number, string][] }): boolean => {
    const kind = o.sourceType.toUpperCase();
    if (POST_R2000_SPELLING.has(kind)) {
      return sourceBeyondR2000
        || !!o.tags?.some(([c, v]) => c === 304 && v.trim().toUpperCase() === 'ACVALUE_END');
    }
    return sourceBeyondR2000 && assocKind(kind);
  };
  type Sealed = UnknownObject;
  const kindOf = (o: Sealed): string => (o.appClass?.dxfName ?? o.sourceType ?? '').toUpperCase();
  const isDictKind = (o: Sealed): boolean => {
    const k = kindOf(o);
    return k === 'DICTIONARY' || k === 'ACDBDICTIONARYWDFLT';
  };
  /** A sealed dictionary with its entries decoded: re-listed from them. */
  const isDict = (o: Sealed): boolean => isDictKind(o) && o.entries !== undefined;
  const isXrecord = (o: Sealed): boolean => kindOf(o) === 'XRECORD';
  const hasTags = (o: Sealed): boolean => !!o.tags && o.tags.length > 0;
  /* an XRECORD read from a DWG: its values, decoded beside the seal */
  const xrecordByHandle = new Map<string, XRecord>();
  for (const x of drawing.xrecords ?? []) if (x.handle) xrecordByHandle.set(up(x.handle), x);
  const xrecordTwin = (o: Sealed): XRecord | undefined =>
    isXrecord(o) && o.handle ? xrecordByHandle.get(up(o.handle)) : undefined;
  /* A record sealed as DWG bits from a class the source's CLASSES named
     — a FIELD, a graph node, a spatial filter, a constraint network read
     from a DWG — is spelled as an ACAD_PROXY_OBJECT carrying those bits
     in DWG format under the version that wrote them: the form the
     reference itself gives an object whose enabler was absent when the
     file was saved, and which it unwraps to the native object on open
     when the enabler is present. The version word names the payload's
     own filer, so bits from a later generation than this AC1015 file
     travel too. A fixed-type record (no class) has no such spelling. */
  const DWG_VERSION_CODE: Record<string, number> = {
    R13: 19, R14: 21, R2000: 23, R2004: 25, R2007: 27, R2010: 29, R2013: 31, R2018: 33
  };
  const GROUP_OF_VERSION: Record<string, number> = {
    R13: 14, R14: 14, R2000: 2000, R2004: 2004, R2007: 2007, R2010: 2018, R2013: 2018, R2018: 2018
  };
  const hasBits = (o: Sealed): boolean =>
    !!o.data && !!o.dataBits && o.encoding !== undefined && !!o.appClass?.dxfName
    && !isDictKind(o) && !isXrecord(o);
  /** The drawing-format code of a sealed record's bits: the source
   *  file's own version when the record's encoding group is the file's
   *  (a 2010 file's records are 2010 bits, though the group says 2018),
   *  else the first release of the group. */
  const proxyVersionOf = (o: Sealed): number => {
    const hv = drawing.header.version ?? '';
    if (o.encoding === GROUP_OF_VERSION[hv]) return DWG_VERSION_CODE[hv];
    const byGroup: Record<number, string> = { 14: 'R14', 2000: 'R2000', 2004: 'R2004', 2007: 'R2007', 2018: 'R2018' };
    return DWG_VERSION_CODE[byGroup[o.encoding ?? 2018] ?? 'R2018'];
  };
  const spellable = (o: Sealed): boolean =>
    hasTags(o) || isDict(o) || xrecordTwin(o) !== undefined || hasBits(o);
  const sealedAll: Sealed[] = drawing.unknownObjects ?? [];
  const sealedByH = new Map<string, Sealed>();
  for (const o of sealedAll) if (o.handle) sealedByH.set(up(o.handle), o);
  /* the named-object dictionaries this writer builds itself: a sealed
     one of the tree carrying one of these keys is not a sealed object
     here — the writer's own goes, and what the source's listed is
     modeled or placed by path as before */
  const BUILT_NOD = new Set(['ACAD_PLOTSTYLENAME', 'ACAD_GROUP', 'ACAD_LAYOUT',
    'ACAD_MLINESTYLE', 'ACAD_TABLESTYLE', 'ACAD_MLEADERSTYLE', 'ACAD_IMAGE_DICT',
    'ACAD_PDFDEFINITIONS', 'ACAD_DGNDEFINITIONS', 'ACAD_DWFDEFINITIONS',
    'ACAD_GEOGRAPHICDATA', 'ACDB_RECOMPOSE_DATA']);
  /* the source's named objects dictionary: what a record listed straight
     under it (dictPath []) is owned by — written under this file's root */
  const nodSrc = sealedAll.find((o) => o.dictPath?.length === 0 && o.ownerHandle)?.ownerHandle;
  const rootHandle = fixed('C');
  if (nodSrc) outMap.set(up(nodSrc), rootHandle);

  /* ---- every natively written record claims its number now, so the
     settle below knows what is in the file, and every pointer at it — a
     reactor, an owner, a 1005 — resolves before anything is written.
     Entities in write order: the further layouts' blocks, the user
     blocks, the tables' own blocks, then model space and the current
     paper space. An entity that has no record in this file (a one-vertex
     polyline, an ASM solid the AC1015 spelling cannot hold) claims
     nothing, so nothing hangs off it. ---- */
  const satCache = new WeakMap<Entity, string | null>();
  const satOf = (e: Extract<Entity, { type: 'acis' }>): string | null => {
    if (satCache.has(e)) return satCache.get(e) ?? null;
    const sat = e.sat ?? (e.sab ? sabToSat(e.sab) : null);
    satCache.set(e, sat);
    return sat;
  };
  const willWrite = (e: Entity): boolean => {
    switch (e.type) {
      case 'polyline': return e.vertices.length >= 2;
      case 'spline': return e.controlPoints.length >= 2 || (e.fitPoints?.length ?? 0) >= 2;
      case 'hatch': return e.loops.length > 0;
      case 'mline': return e.vertices.length >= 2;
      case 'mesh': return e.vertices.length > 0;
      case 'insert': return !!e.blockName;
      case 'leader': return e.vertices.length >= 2;
      case 'acis': {
        const sat = satOf(e);
        if (!sat) return false;
        const ver = parseInt(sat, 10);
        return !(isFinite(ver) && ver >= 21800);
      }
      case 'unknown': return !!e.tags?.length;
      case 'proxy': return !!(e.data || e.graphicsData);
      default: return true;
    }
  };
  const entOut = new WeakMap<Entity, string>();
  const claimEnt = (e: Entity): void => {
    if (!willWrite(e)) return;
    entOut.set(e, claim(e.handle));
    if (e.type === 'insert') for (const a of e.attributes ?? []) entOut.set(a, claim(a.handle));
  };
  const spaces: { block: string; src?: string; list: Entity[] }[] = [];
  for (const nm of paperBlockNames) {
    spaces.push({ block: blockRecHandle[nm], src: blocks[nm].handle, list: blocks[nm].entities });
  }
  for (const nm of blockNames) {
    if (blocks[nm].xref) continue;
    spaces.push({ block: blockRecHandle[nm], src: blocks[nm].handle, list: blocks[nm].entities });
  }
  for (const tb of tableBlocks) {
    if (tb.src) spaces.push({ block: tb.rec, src: tb.src.handle, list: tb.src.entities });
  }
  spaces.push({ block: msRecHandle, src: msSrc, list: drawing.entities });
  spaces.push({ block: psRecHandle, src: psSrc, list: drawing.paperSpace ?? [] });
  for (const s of spaces) s.list.forEach(claimEnt);
  const layoutOut = new Map<Layout, string>();
  for (const l of layoutsIn) layoutOut.set(l, claim(l.handle));
  /* the symbol-table records written natively, by record */
  const recOut = new Map<object, string>();
  const ownStyles = drawing.textStyles.filter(travels)
    .filter((s, i, all) => !(s.shapeFile
      && all.some((o) => o !== s && !o.shapeFile && o.name.toLowerCase() === s.name.toLowerCase())));
  const keptStyles = ownStyles.filter((s) => !(s.shapeFile && s.name.includes('|') && !s.xrefDependent));
  const styles = keptStyles.length ? keptStyles : [{ name: 'Standard' }];
  for (const r of [...layers, ...drawing.linetypes.filter(travels), ...styles] as { handle?: string }[]) {
    recOut.set(r, claim(r.handle));
  }
  const proxyObjHandles = proxyObjs.map((p) => claim(p.handle));

  /* ---- draw order under preserveHandles: a space whose array order
     differs from its ascending handle order would read back reordered,
     so it gets a SORTENTSTABLE under an ACAD_SORTENTS entry of its block
     record's extension dictionary — the source's own sealed one when it
     travels, a fresh one otherwise — in the reference's spelling. A
     default write needs nothing: fresh handles ascend in write order. */
  interface SortPlan {
    block: string; src?: string; dict: string; sealedDict?: Sealed;
    table: string; pairs: [string, string][];
  }
  const sortPlans: SortPlan[] = [];
  /* this writer's own entries in a sealed dictionary, by its source handle */
  const extraFor = new Map<string, [string, string, number][]>();
  if (preserve) {
    for (const s of spaces) {
      const hs = s.list.map((e) => entOut.get(e)).filter((h): h is string => !!h);
      const num = hs.map((h) => parseInt(h, 16));
      if (!num.some((n, i) => i > 0 && n < num[i - 1])) continue;
      const sorted = [...num].sort((a, b) => a - b);
      const pairs: [string, string][] = [];
      hs.forEach((h, i) => {
        const k = sorted[i].toString(16).toUpperCase();
        if (k !== h) pairs.push([h, k]);
      });
      const sealedDict = s.src ? sealedAll.find((o) => isDict(o) && !!o.ownerHandle
        && up(o.ownerHandle) === up(s.src!)) : undefined;
      const table = handle();
      if (sealedDict?.handle) extraFor.set(up(sealedDict.handle), [['ACAD_SORTENTS', table, 3]]);
      sortPlans.push({ block: s.block, src: s.src, dict: sealedDict ? '' : handle(), sealedDict, table, pairs });
    }
  }

  /* ---- the settle: what travels, to a fixed point. Out first by what
     cannot be spelled; then, repeatedly, anything whose owner is a
     sealed object that stays (one chain, one loss, reported at its
     root), a dictionary with nothing written left to list (quietly:
     whatever it lost reports itself), a dictionary or record whose owner
     is not written and that has no place on the tree, and a record with
     a hard reference (340/360) into nothing — the reference resolves
     those while opening and audits or refuses the file over a dangler.
     Each removal can strand another, hence the loop. ---- */
  const whyNot = new Map<Sealed, string>();
  const silent = new Set<Sealed>();
  const travel = new Set<Sealed>();
  for (const o of sealedAll) {
    const kind = kindOf(o) || 'sealed object';
    if (kind === 'ACDBPLACEHOLDER') {
      /* the plot-style placeholder: this writer's own goes, as always */
      whyNot.set(o, `${kind} (this writer builds its own)`);
      silent.add(o);
      continue;
    }
    if (!spellable(o)) { whyNot.set(o, `${kind} (sealed as DWG bits, no DXF spelling)`); continue; }
    /* (a bits-sealed record travels under its own version word, whatever
       this file's: the version axis binds the tagged ones alone) */
    if (hasTags(o) && spelledPastR2000(o)) {
      whyNot.set(o, `${kind} (its post-R2000 spelling has no place in an AC1015 file)`);
      continue;
    }
    if (isDictKind(o) && o.dictPath?.length === 0 && o.name && BUILT_NOD.has(up(o.name))) {
      whyNot.set(o, `${kind} ${o.name} (this writer builds its own)`);
      silent.add(o);
      continue;
    }
    travel.add(o);
  }
  const written = (h: string): boolean => {
    const k = up(h);
    const s = sealedByH.get(k);
    return s ? travel.has(s) : outMap.has(k);
  };
  const pathKey = (p: string[]): string => p.map(up).join(' ');
  /** Every hard reference of a tagged body (340–349 hard pointer,
   *  360–369 hard owner) lands on something written. An XRECORD's data
   *  is nulled instead (the proven behaviour of the value-written
   *  record), a dictionary's entries are filtered. */
  const hardRefsIn = (o: Sealed): boolean => {
    if (isXrecord(o) || isDict(o)) return true;
    if (!o.tags) {
      /* a bits-sealed record's reference list: the hard codes (3 owner,
         5 pointer) must land on something written, as the DWG writer
         demands of them */
      return !(o.refs ?? []).some((r) => (r.code === 3 || r.code === 5)
        && !!r.value && up(r.value) !== '0' && !written(r.value));
    }
    let body = false;
    for (const [c, v] of o.tags) {
      if (c === 100) { body = true; continue; }
      if (!body) continue;
      if (((c >= 340 && c <= 349) || (c >= 360 && c <= 369))
        && v.trim() && up(v) !== '0' && !written(v)) return false;
    }
    return true;
  };
  const stay = (o: Sealed, why: string, quiet: boolean): void => {
    travel.delete(o);
    whyNot.set(o, why);
    if (quiet) silent.add(o);
  };
  for (let changed = true; changed;) {
    changed = false;
    /* the tree dictionaries that list a travelling record by path */
    const placedUnder = new Set<string>();
    for (const o of travel) if (o.dictPath !== undefined) placedUnder.add(pathKey(o.dictPath));
    for (const o of [...travel]) {
      const kind = kindOf(o) || 'sealed object';
      const own = o.ownerHandle ? up(o.ownerHandle) : '';
      const ownerSealed = own ? sealedByH.get(own) : undefined;
      const ownerIn = !!own && written(own);
      let why: string | null = null;
      let quiet = false;
      if (ownerSealed && !travel.has(ownerSealed)
        /* (a record listed by a tree dictionary that stays home takes
           its place by path, as it always did) */
        && !(isDictKind(ownerSealed) && ownerSealed.dictPath !== undefined)) {
        why = `${kind} (its owner stays home)`;
        quiet = true;
      } else if (isDict(o)) {
        const lists = (o.entries ?? []).some((en) => written(en.handle))
          || (o.handle !== undefined && extraFor.has(up(o.handle)))
          || (o.dictPath !== undefined && o.name !== undefined
            && placedUnder.has(pathKey([...o.dictPath, o.name])));
        if (!lists) {
          why = `${kind} (nothing it lists is written)`;
          quiet = true;
        } else if (!ownerIn && o.dictPath === undefined) {
          why = `${kind} (extension dictionary of an object not written)`;
        }
      } else if (!ownerIn && o.dictPath === undefined) {
        why = `${kind} (its owner is not written)`;
      } else if (!hardRefsIn(o)) {
        why = `${kind} (a hard reference into an object not written)`;
      }
      if (why !== null) {
        stay(o, why, quiet);
        changed = true;
      }
    }
  }
  const sealedObjs = sealedAll.filter((o) => travel.has(o));
  const sealedObjHandles = sealedObjs.map((o) => claim(o.handle));
  const sealedOut = new Map<Sealed, string>();
  sealedObjs.forEach((o, i) => sealedOut.set(o, sealedObjHandles[i]));
  for (const p of sortPlans) {
    const d = p.sealedDict ? sealedOut.get(p.sealedDict) : undefined;
    if (d) p.dict = d;
    else { p.sealedDict = undefined; if (!p.dict) p.dict = handle(); }
  }
  const sortentsByBlock = new Map<string, SortPlan>();
  for (const p of sortPlans) sortentsByBlock.set(p.block, p);
  /** The sealed extension dictionary each written record carries, by the
   *  owner's source handle: a travelling sealed dictionary owned by a
   *  record that does not list it as an entry (one listed is an entry). */
  const xdictByOwner = new Map<string, Sealed>();
  for (const o of sealedObjs) {
    if (!isDictKind(o) || !o.ownerHandle) continue;
    const owner = sealedByH.get(up(o.ownerHandle));
    if (owner && isDictKind(owner)
      && (owner.entries ?? []).some((en) => !!o.handle && up(en.handle) === up(o.handle))) continue;
    xdictByOwner.set(up(o.ownerHandle), o);
  }
  /** A block whose genuine evaluation graph travels: its sealed
   *  extension dictionary lists ACAD_ENHANCEDBLOCK → a travelling graph. */
  const graphTravels = (nm: string): boolean => {
    const bh = blocks[nm]?.handle;
    const d = bh ? xdictByOwner.get(up(bh)) : undefined;
    if (!d) return false;
    const en = (d.entries ?? []).find((e) => up(e.name) === 'ACAD_ENHANCEDBLOCK');
    const g = en ? sealedByH.get(up(en.handle)) : undefined;
    return !!g && travel.has(g) && kindOf(g) === 'ACAD_EVALUATION_GRAPH';
  };
  /* what stays home, said once per reason */
  {
    const counts = new Map<string, number>();
    for (const [o, why] of whyNot) {
      if (silent.has(o)) continue;
      counts.set(why, (counts.get(why) ?? 0) + 1);
    }
    for (const [why, n] of counts) drawing.warnings.push(`${n} ${why} left out of the DXF`);
  }

  /* ---- associative hatches: the loops' source boundary objects, when
     they are in this file, and the reactor each boundary entity carries
     back to the hatch — the pair the reference's AUDIT checks ("Boundary
     Missing a Reactor — Remove Associativity"). A hatch whose boundaries
     are not here leaves non-associative, and a reactor at such a hatch
     is dropped. ---- */
  const hatchLoopHandles = new Map<Entity, string[][]>();
  const hatchReactorsFor = new Map<string, string[]>();
  const hatchOutAll = new Set<string>();
  const hatchOutAssoc = new Set<string>();
  for (const s of spaces) {
    for (const e of s.list) {
      if (e.type !== 'hatch') continue;
      const h = entOut.get(e);
      if (!h) continue;
      hatchOutAll.add(h);
      if (!e.associative) continue;
      const loops = e.loops.map((lp) => (lp.boundaryHandles ?? [])
        .map((b) => outHandleOf(b)).filter((t): t is string => !!t));
      if (!loops.some((l) => l.length)) continue;
      hatchLoopHandles.set(e, loops);
      hatchOutAssoc.add(h);
      for (const l of loops) {
        for (const t of l) {
          const list = hatchReactorsFor.get(t) ?? [];
          if (!list.includes(h)) list.push(h);
          hatchReactorsFor.set(t, list);
        }
      }
    }
  }
  /** The reactors a written record lists: the source's, for every target
   *  in this file (a hatch only when it leaves associative), plus the
   *  hatches whose boundary the record is. */
  const reactorsOut = (list: string[] | undefined, self: string): string[] => {
    const res: string[] = [];
    const add = (t?: string): void => { if (t && t !== self && !res.includes(t)) res.push(t); };
    for (const r of list ?? []) {
      const t = outHandleOf(r);
      if (t && hatchOutAll.has(t) && !hatchOutAssoc.has(t)) continue;
      add(t);
    }
    for (const t of hatchReactorsFor.get(self) ?? []) add(t);
    return res;
  };
  /** The two fenced runs of a record's identity, in the reference's own
   *  order: `102 {ACAD_XDICTIONARY 360 h 102 }` when the sealed extension
   *  dictionary travels, then `102 {ACAD_REACTORS 330 h … 102 }`. */
  const writeFences = (
    src: string | undefined, reactors: string[] | undefined, self: string, xdictOverride?: string
  ): void => {
    const sealedXd = src ? xdictByOwner.get(up(src)) : undefined;
    const xd = xdictOverride ?? (sealedXd ? sealedOut.get(sealedXd) : undefined);
    if (xd) { w(102, '{ACAD_XDICTIONARY'); w(360, xd); w(102, '}'); }
    const rs = reactorsOut(reactors, self);
    if (rs.length) {
      w(102, '{ACAD_REACTORS');
      for (const r of rs) w(330, r);
      w(102, '}');
    }
  };
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
  /* ---- the class registry: every CLASS record of the file in the order
     the CLASSES section writes them, since class numbers are positional
     (the first CLASS record is 500). The two always-present plot-style
     classes first, the fixed pairs (images, underlays, tables, multi-
     leaders), the proxy classes, then the classes the sealed records
     re-declare — a class the reference loads on demand (WIPEOUTVARIABLES
     from the WipeOut module, say) is skipped on open without its CLASS
     record, and the dictionary entry naming the record is then audited
     away — and the draw-order table's. One record per class name. ---- */
  interface ClassDecl { dxf: string; cpp: string; app: string; flags: number; wasProxy: boolean; ent: boolean }
  const classDecls: ClassDecl[] = [];
  const classIndex = new Map<string, number>();
  const declareClass = (d: ClassDecl): void => {
    const key = up(d.dxf);
    if (!key || classIndex.has(key)) return;
    classIndex.set(key, 500 + classDecls.length);
    classDecls.push(d);
  };
  const classIdOf = (dxfName: string): number => classIndex.get(up(dxfName)) ?? 0;
  declareClass({ dxf: 'ACDBDICTIONARYWDFLT', cpp: 'AcDbDictionaryWithDefault', app: 'ObjectDBX Classes', flags: 0, wasProxy: false, ent: false });
  declareClass({ dxf: 'ACDBPLACEHOLDER', cpp: 'AcDbPlaceholder', app: 'ObjectDBX Classes', flags: 0, wasProxy: false, ent: false });
  const ismClass = (dxf: string, cpp: string, ent: boolean): void =>
    declareClass({ dxf, cpp, app: 'ISM', flags: 127, wasProxy: false, ent });
  if (usesImages) {
    ismClass('IMAGE', 'AcDbRasterImage', true);
    ismClass('WIPEOUT', 'AcDbWipeout', true);
    ismClass('IMAGEDEF', 'AcDbRasterImageDef', false);
    ismClass('RASTERVARIABLES', 'AcDbRasterVariables', false);
  }
  for (const kind of underlayKinds) {
    const cap = kind.charAt(0).toUpperCase() + kind.slice(1);
    ismClass(kind.toUpperCase() + 'UNDERLAY', `AcDb${cap}Reference`, true);
    ismClass(kind.toUpperCase() + 'DEFINITION', `AcDb${cap}Definition`, false);
  }
  /* the table and multileader class pairs, spelled as the reference's
     own R2000 DXF spells them (application name and capability flags
     included); a record of either kind is refused without its class */
  if (usesTables) declareClass({ dxf: 'ACAD_TABLE', cpp: 'AcDbTable', app: 'ObjectDBX Classes', flags: 1025, wasProxy: false, ent: true });
  if (usesTableStyles) declareClass({ dxf: 'TABLESTYLE', cpp: 'AcDbTableStyle', app: 'ObjectDBX Classes', flags: 4095, wasProxy: false, ent: false });
  if (usesMLeaders) declareClass({ dxf: 'MULTILEADER', cpp: 'AcDbMLeader', app: 'ACDB_MLEADER_CLASS', flags: 1025, wasProxy: false, ent: true });
  if (usesMLeaderStyles) declareClass({ dxf: 'MLEADERSTYLE', cpp: 'AcDbMLeaderStyle', app: 'ACDB_MLEADERSTYLE_CLASS', flags: 4095, wasProxy: false, ent: false });
  /* proxy classes re-state the original application's naming, with the
     was-a-proxy flag (280) set — what the class stood for in the source */
  for (const [key, pc] of proxyClasses) {
    declareClass({ dxf: key, cpp: pc.cpp, app: pc.app, flags: pc.ent ? 4095 : 0, wasProxy: true, ent: pc.ent });
  }
  for (const o of sealedObjs) {
    if (o.appClass) {
      declareClass({
        dxf: o.appClass.dxfName, cpp: o.appClass.cppName || o.appClass.dxfName,
        app: o.appClass.appName || 'ObjectDBX Classes', flags: 0, wasProxy: false, ent: false
      });
    }
  }
  for (const e of allEntities()) {
    if (e.type === 'unknown' && e.tags?.length && e.appClass) {
      declareClass({
        dxf: e.appClass.dxfName, cpp: e.appClass.cppName || e.appClass.dxfName,
        app: e.appClass.appName || 'ObjectDBX Classes', flags: 4095, wasProxy: false, ent: true
      });
    }
  }
  /* the draw-order tables this writer adds under preserveHandles */
  if (sortPlans.length) declareClass({ dxf: 'SORTENTSTABLE', cpp: 'AcDbSortentsTable', app: 'ObjectDBX Classes', flags: 0, wasProxy: false, ent: false });
  const proxyClassId = new Map<string, number>();
  for (const key of proxyClasses.keys()) proxyClassId.set(key, classIdOf(key));

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
      case 'table': {
        const wide = ent.columnWidths.reduce((s, v) => s + (isNum(v) ? v : 0), 0);
        const tall = ent.rowHeights.reduce((s, v) => s + (isNum(v) ? v : 0), 0);
        grow(ent.position.x, ent.position.y - tall);
        grow(ent.position.x + wide, ent.position.y);
        break;
      }
      case 'mleader':
        for (const l of ent.leaders) {
          for (const line of l.lines) for (const p of line) grow(p.x, p.y);
          if (l.landing) grow(l.landing.x, l.landing.y);
        }
        if (ent.textPosition) grow(ent.textPosition.x, ent.textPosition.y);
        if (ent.blockPosition) grow(ent.blockPosition.x, ent.blockPosition.y);
        break;
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
  /* unknown vars the reader preserved travel back as [code, value] pairs
     — except the handle-valued ones: $HANDSEED is this writer's own (a
     carried one would follow it and win, and a seed below the numbers
     used here has the reference reseating records into collisions —
     "Bad handle … already in use", file discarded), and a pointer such
     as $CMATERIAL or $INTERFEREOBJVS names an object of the source's
     numbering, which is gone */
  for (const [name, v] of Object.entries(hdr.vars ?? {})) {
    if (!Array.isArray(v)) continue;
    const groups = v as unknown[];
    if (!groups.every((g) => Array.isArray(g) && g.length === 2 && isNum(g[0]))) continue;
    if (groups.some((g) => {
      const c = (g as [number, unknown])[0];
      return c === 5 || c === 105 || (c >= 320 && c <= 369);
    })) continue;
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

  /* ---- CLASSES: the registry, in its order (the plot-style machinery
     first, spelled the way the reference spells it — these two classes
     exist in every R2000+ file it writes) ---- */
  {
    w(0, 'SECTION'); w(2, 'CLASSES');
    for (const c of classDecls) {
      w(0, 'CLASS'); w(1, c.dxf); w(2, c.cpp); w(3, c.app);
      w(90, c.flags); w(280, c.wasProxy ? 1 : 0); w(281, c.ent ? 1 : 0);
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
    ...drawing.linetypes.filter(travels)
  ];
  w(0, 'TABLE'); w(2, 'LTYPE'); w(5, handle()); w(100, 'AcDbSymbolTable');
  w(70, linetypes.length);
  for (const lt of linetypes as (typeof linetypes[number] & { xrefDependent?: boolean; handle?: string })[]) {
    const lh = recOut.get(lt) ?? handle();
    ltypeHandleOf.set(lt.name.toLowerCase(), lh);
    w(0, 'LTYPE'); w(5, lh);
    writeFences(lt.handle, undefined, lh);
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbLinetypeTableRecord');
    w(2, lt.name); w(70, lt.xrefDependent ? XREF_DEP : 0); w(3, lt.description ?? '');
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
    const lyh = recOut.get(ly) ?? handle();
    w(0, 'LAYER'); w(5, lyh);
    writeFences(ly.handle, undefined, lyh);
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbLayerTableRecord');
    w(2, ly.name);
    w(70, (ly.frozen ? 1 : 0) | (ly.locked ? 4 : 0) | (ly.xrefDependent ? XREF_DEP : 0));
    w(62, ly.on ? aci : -aci);         /* negative 62 = layer off */
    if (ly.color.kind === 'rgb') w(420, ly.color.rgb);
    w(6, ly.linetype ?? 'Continuous');
    if (isNum(ly.lineweight)) w(370, lineweightCode(ly.lineweight));
    if (ly.plottable === false) w(290, 0);
    w(390, plotStyleHolderHandle);
  }
  w(0, 'ENDTAB');

  w(0, 'TABLE'); w(2, 'STYLE'); w(5, handle()); w(100, 'AcDbSymbolTable');
  w(70, styles.length);
  for (const st of styles as (typeof styles[number] & { xrefDependent?: boolean; handle?: string })[]) {
    const sh = recOut.get(st) ?? handle();
    if (!st.shapeFile || !styleHandleOf.has(st.name.toLowerCase())) {
      styleHandleOf.set(st.name.toLowerCase(), sh);
    }
    w(0, 'STYLE'); w(5, sh);
    writeFences(st.handle, undefined, sh);
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbTextStyleTableRecord');
    w(2, st.name); w(70, (st.shapeFile ? 1 : 0) | (st.xrefDependent ? XREF_DEP : 0));
    w(40, fmt(st.fixedHeight ?? 0));
    w(41, fmt(st.widthFactor ?? 1));
    w(50, fmt(st.oblique ?? 0)); w(71, 0); w(42, 2.5);
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
    /* every application the drawing's xdata names must be registered —
       DXFIN drops an xdata group whose APPID the table does not list —
       so the table is the source's APPIDs plus whatever is in use */
    const apps: string[] = [...(drawing.appIds ?? [])];
    const seenApp = new Set(apps.map((a) => a.toUpperCase()));
    const addApp = (name?: string): void => {
      if (!name || seenApp.has(name.toUpperCase())) return;
      seenApp.add(name.toUpperCase());
      apps.push(name);
    };
    if (!apps.length) addApp('ACAD');
    const walkApps = (list?: Entity[]): void => {
      for (const e of list ?? []) {
        for (const g of e.xdata ?? []) addApp(g.appName);
        if (e.type === 'insert') {
          for (const a of e.attributes ?? []) for (const g of a.xdata ?? []) addApp(g.appName);
        }
      }
    };
    walkApps(drawing.entities);
    walkApps(drawing.paperSpace);
    for (const b of Object.values(blocks)) walkApps(b?.entities);
    for (const p of proxyObjs) for (const g of p.xdata ?? []) addApp(g.appName);
    for (const s of [...tableStylesOut, ...mleaderStylesOut]) {
      for (const g of s.xdata ?? []) addApp(g.appName);
    }
    /* every MULTILEADER and its style carry the ACAD_MLEADERVER xdata
       the reference writes on its own */
    if (usesMLeaderStyles) addApp('ACAD_MLEADERVER');
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
  w(70, 2 + paperBlockNames.length + blockNames.length + tableBlocks.length);
  const brHandleOf = (nm: string): string => nm === '*Model_Space' ? msRecHandle
    : nm === '*Paper_Space' ? psRecHandle : blockRecHandle[nm];
  /* Layouts and their block records must point at each other — 330 down
     from the LAYOUT object, 340 back from the BLOCK_RECORD — or AUDIT
     deletes the dictionary entry. Handles are fixed here so the table
     can state the back-pointers; a layout whose block never lands in
     the table (one the drawing no longer holds) stays out of the
     dictionary rather than being listed dangling. */
  const outLayouts: { l: Layout; h: string; brh: string }[] = [];
  for (const l of layoutsIn) {
    const brh = l.blockName ? brHandleOf(l.blockName)
      : /model/i.test(l.name) ? msRecHandle : psRecHandle;
    if (brh) outLayouts.push({ l, h: layoutOut.get(l) ?? handle(), brh });
  }
  const layoutOfBr = new Map(outLayouts.map((o) => [o.brh, o.h]));
  /* each record's identity: its extension dictionary when the sealed one
     travels (a dynamic block's graph, a space's draw-order table) — the
     table this writer adds itself takes the fresh dictionary it made */
  const blockRecord = (h: string, src: string | undefined, name: string): void => {
    w(0, 'BLOCK_RECORD'); w(5, h);
    writeFences(src, undefined, h, sortentsByBlock.get(h)?.dict);
    w(100, 'AcDbSymbolTableRecord'); w(100, 'AcDbBlockTableRecord');
    w(2, name);
  };
  for (const nm of ['*Model_Space', '*Paper_Space'].concat(paperBlockNames, blockNames)) {
    const src = nm === '*Model_Space' ? msSrc : nm === '*Paper_Space' ? psSrc : blocks[nm].handle;
    blockRecord(brHandleOf(nm), src, isSystemBlock(nm) ? nm : outBlockName(nm));
    const lh = layoutOfBr.get(brHandleOf(nm));
    if (lh) w(340, lh);
  }
  /* the anonymous *T<n> records the tables own */
  for (const tb of tableBlocks) blockRecord(tb.rec, tb.src?.handle, tb.name);
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

  /* Every entity's number was claimed above — in write order, or the
     source's own under preserveHandles — so a pointer at one (a leader's
     annotation, an xdata 1005, a reactor, a group member) resolves
     whichever of the two is written first; written verbatim they would
     point at nothing and AUDIT strips each one as "not an entity". */
  const allWritten = (): Entity[] => {
    const out = [...drawing.entities, ...(drawing.paperSpace ?? [])];
    for (const nm of blockNames) out.push(...blocks[nm].entities);
    return out;
  };
  const entStart = (dxfName: string, ent: Entity, subclass?: string): void => {
    const h = entOut.get(ent) ?? handle();
    w(0, dxfName); w(5, h);
    writeFences(ent.handle, ent.reactors, h);
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
    /* In the order the reference's own R2000 DXF spells a proxy: the
       packed version word (95: version low, maintenance high) and the
       origin flag (70) first, then the display list, the entity data,
       the references, and 94 closing the record. The documented order
       lists 94/95/70 last, but a 94 ahead of 95 and 70 ends the record
       early in the reference's reader — a file whose proxy objects were
       spelled that way lost its named objects dictionary on open
       ("GroupTable dictionary was not defined") and was discarded. */
    w(95, (p.proxyMaint ?? 0) * 0x10000 + (p.proxyVersion ?? 0));
    w(70, p.fromDxf ? 1 : 0);
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
    writeProxyRefs(p.refs);
    w(94, 0);                            /* end of the reference run */
  };
  /** A proxy record's reference list, each under the DXF group of its
   *  handle code — 2 soft owner 350, 3 hard owner 360, 4 soft pointer
   *  330, 5 hard pointer 340. A target this file numbered is followed
   *  to its new number; any other reference keeps the number it was,
   *  code-for-code, the way the proxy contract always promised (the DWG
   *  writer's rule; a sealed record with a hard reference into nothing
   *  never gets this far — the settle kept it home). */
  const writeProxyRefs = (refs?: { code: number; value: string }[]): void => {
    for (const ref of refs ?? []) {
      const code = ref.code === 2 ? 350 : ref.code === 3 ? 360 : ref.code === 5 ? 340 : 330;
      const v = ref.value.trim();
      w(code, outHandleOf(v) ?? v);
    }
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

  /** Where a 250-character chunk may end. A chunk is a DXF string of
   *  its own, so the escapes that live at that level must not straddle
   *  the cut: a `^X` caret pair split after the caret is a malformed
   *  string ("DXF read error" — the reference discards the whole file
   *  over one), and a `\U+XXXX` or `%%x` code is safest whole too. */
  const chunkCut = (rest: string): number => {
    let cut = 250;
    while (cut > 200) {
      if (rest[cut - 1] === '^') { cut--; continue; }
      const u = rest.lastIndexOf('\\U+', cut - 1);
      if (u >= 0 && u + 7 > cut) { cut = u; continue; }
      if (rest[cut - 1] === '%' || (rest[cut - 2] === '%' && rest[cut - 1] === '%')) { cut--; continue; }
      break;
    }
    return cut;
  };

  /** A long string as 250-character chunks — every chunk but the last
   *  under `chunkCode`, the last (possibly empty) under `lastCode`. The
   *  escapes are applied first, so the 250 is measured on what lands in
   *  the file (a character above ASCII is seven once written). */
  const emitChunked = (body: string, chunkCode: number, lastCode: number): void => {
    let rest = escapeUnicode(body);
    while (rest.length > 250) {              /* DXF chunking contract */
      const cut = chunkCut(rest);
      w(chunkCode, rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    w(lastCode, rest);
  };

  const emitMtextValue = (body: string): void => emitChunked(body, 3, 1);

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
    /* an R2000 file knows no paragraph codes: the reference's own 2000
       save drops every `\p…;` (the 2004 indents and the 2008 alignment
       alike), and so does this AC1015 writer */
    emitMtextValue(flattenMtextParagraphs(mtextBody(ent.text), 2000,
      isNum(ent.height) && ent.height > 0 ? ent.height : 5));
    w(50, fmt((ent.rotation || 0) * DEG));
    if (ent.style) w(7, ent.style);
  };

  /** A loop's source boundary objects: 97 the count, then one 330 per
   *  entity — the entities in this file, for an associative hatch. */
  const writeBounds = (bounds: string[]): void => {
    w(97, bounds.length);
    for (const hb of bounds) w(330, hb);
  };
  const writeHatchLoop = (b: HatchBoundary, first: boolean, bounds: string[]): void => {
    /* the loop-type bits beyond the structural polyline one; when the
       source never said, the first loop is spelled external as before */
    const flagged = b.external !== undefined || b.derived !== undefined
      || b.outermost !== undefined;
    const bits = flagged
      ? (b.external ? 1 : 0) | (b.derived ? 4 : 0) | (b.outermost ? 16 : 0)
      : (first ? 1 : 0);
    if (b.kind === 'polyline') {
      const hasBulge = b.vertices.some((p) => isNum(p.bulge) && p.bulge !== 0);
      w(92, 2 | bits);                       /* polyline (+loop bits) */
      w(72, hasBulge ? 1 : 0);
      w(73, b.closed ? 1 : 0);
      w(93, b.vertices.length);
      for (const p of b.vertices) {
        w(10, fmt(p.x)); w(20, fmt(p.y));
        if (hasBulge) w(42, fmt(p.bulge ?? 0));
      }
      writeBounds(bounds);
    } else if (b.kind === 'circle') {
      w(92, bits); w(93, 1);
      w(72, 2);                              /* circular arc edge */
      w(10, fmt(b.center.x)); w(20, fmt(b.center.y));
      w(40, fmt(b.radius));
      w(50, 0); w(51, 360); w(73, 1);
      writeBounds(bounds);
    } else if (b.kind === 'ellipse') {
      w(92, bits); w(93, 1);
      w(72, 3);                              /* ellipse edge */
      w(10, fmt(b.center.x)); w(20, fmt(b.center.y));
      w(11, fmt(b.majorAxis.x)); w(21, fmt(b.majorAxis.y));
      w(40, fmt(b.ratio));
      w(50, 0); w(51, 360); w(73, 1);
      writeBounds(bounds);
    } else {
      /* exact edge list — angles are radians in the model, degrees in DXF */
      w(92, bits);
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
      writeBounds(bounds);                              /* source boundary objects */
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
    w(70, (a.invisible ? 1 : 0) | (a.constant ? 2 : 0));
    if (va) w(74, va);
  };

  /** A block's attribute definition: the TEXT body closed by the
   *  AcDbAttributeDefinition subclass, whose 70 flags carry the
   *  invisible/constant bits back to the reader. */
  let attdefSeq = 0;
  const writeAttdef = (a: TextEntity): void => {
    entStart('ATTDEF', a, 'AcDbText');
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
    w(100, 'AcDbAttributeDefinition');
    w(3, '');                                /* prompt */
    w(2, 'ATTD' + ++attdefSeq);              /* model keeps no tag — invent one */
    w(70, (a.invisible ? 1 : 0) | (a.constant ? 2 : 0));
    if (va) w(74, va);
  };

  /* XDATA rides at the very end of its record — an entity's, or a
     dictionary-owned object's */
  const writeXdata = (ent: { xdata?: Entity['xdata'] }): void => {
    for (const g of ent.xdata ?? []) {
      w(1001, g.appName ?? 'ACAD');
      for (const v of g.values) {
        if ('point' in v) {
          w(v.code, fmt(v.point.x));
          w(v.code + 10, fmt(v.point.y));
          w(v.code + 20, fmt(v.point.z ?? 0));
        } else if (v.code === 1005) {
          /* the source drawing's handle space is gone — every object was
             renumbered — so a carried 1005 is repointed at the number its
             target got here, and nulled when the target was not written:
             AUDIT flags a dangling one ("XData Handle Unknown") and nulls
             it, which is the same end state without the noise. */
          w(1005, outHandleOf(String(v.value)) ?? (preserve ? String(v.value) : 0));
        } else {
          w(v.code, typeof v.value === 'number' ? fmt(v.value) : v.value);
        }
      }
    }
  };

  /** Re-emit a sealed record's raw tags. Everything travels verbatim —
   *  values bypass the escaping writer on purpose, byte-for-byte survival
   *  being the whole point — except what must be this file's for it to
   *  cohere. The identity ahead of the first subclass marker: the
   *  record's own handle (group 5, or 105 for the DIMVAR-style records)
   *  becomes the number allocated here, the bare owner 330 is repointed
   *  at the real owner, and the two fences the reference writes there —
   *  `{ACAD_XDICTIONARY` naming the extension dictionary, `{ACAD_REACTORS`
   *  the records watching this one — are re-derived from the model: the
   *  dictionary's fence goes only when the sealed dictionary travels
   *  (verbatim it would point at nothing, and AUDIT reports each
   *  extension dictionary it cannot reach), a reactor only for a target
   *  in the file. A fence of any other name is an application's own and
   *  travels verbatim.
   *  The body past the marker: under preserveHandles every handle-typed
   *  group (320–369, the 1005 of its xdata) is still true and travels
   *  verbatim; without it each is remapped through this file's numbering
   *  and nulled when its target is not written. A dictionary's entry
   *  runs (3 with the 350/360 after it) are replaced by the list handed
   *  in, at the place of the first — the entries whose targets are here,
   *  and this writer's own beside them. */
  const writeSealedTags = (
    tags: readonly [number, string][], newHandle: string, owner: string,
    ident: { src?: string; reactors?: string[]; dict?: [string, string, number][] }
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
    let identityDone = false, ownerDone = false;
    const identity = (code: number): void => {
      w(code, newHandle);
      writeFences(ident.src, ident.reactors, newHandle);
      identityDone = true;
    };
    if (!hasHandle) identity(5);
    const remap = (v: string): string => {
      const k = up(v);
      if (!k || k === '0') return v;
      return outMap.get(k) ?? (preserve ? v : '0');
    };
    let inDict = false, pendingKey = false;
    let entriesDone = ident.dict === undefined;
    const emitEntries = (): void => {
      if (entriesDone) return;
      entriesDone = true;
      for (const [n, t, code] of ident.dict!) { w(3, n); w(code === 3 ? 360 : 350, t); }
    };
    for (let i = 0; i < tags.length; i++) {
      const [c, v] = tags[i];
      if (c === 102 && i < firstSubclass && v.trim().startsWith('{')) {
        /* a fenced run: everything up to the closing 102 */
        let j = i + 1;
        while (j < tags.length && tags[j][0] !== 102) j++;
        const name = v.trim().toUpperCase();
        if (name !== '{ACAD_REACTORS' && name !== '{ACAD_XDICTIONARY') {
          for (let k = i; k <= j && k < tags.length; k++) {
            out.push(String(tags[k][0]), tags[k][1]);
          }
        }
        i = j;
        continue;
      }
      if (i < firstSubclass) {
        if ((c === 5 || c === 105) && !identityDone) { identity(c); continue; }
        if (c === 330 && !ownerDone) {
          ownerDone = true;
          w(330, owner);
          continue;
        }
        out.push(String(c), v);
        continue;
      }
      if (c === 100) {
        if (inDict) emitEntries();
        inDict = ident.dict !== undefined && /^AcDbDictionary$/i.test(v.trim());
        out.push(String(c), v);
        continue;
      }
      if (inDict) {
        if (c === 3) { pendingKey = true; emitEntries(); continue; }
        if ((c === 350 || c === 360) && pendingKey) { pendingKey = false; continue; }
        pendingKey = false;
      }
      if ((c >= 320 && c <= 369) || c === 1005) {
        out.push(String(c), remap(v));
        continue;
      }
      out.push(String(c), v);
    }
    if (!entriesDone) emitEntries();
  };

  /** A sealed dictionary, re-listed from its decoded entries: each entry
   *  whose target is written, under the reference code it carried (360
   *  hard owner, 350 soft), then this writer's own beside them — an
   *  ACAD_SORTENTS table, a record placed by path — which replace a
   *  stale entry of the same key. From its tags when it arrived through
   *  DXF (the flags, the with-default tail and its xdata travel
   *  verbatim), spelled from the model otherwise. */
  const writeSealedDict = (
    p: UnknownObject, h: string, owner: string, extra: [string, string, number][]
  ): void => {
    const ownCode = p.hardOwner ? 3 : 2;
    const items: [string, string, number][] = [];
    const seen = new Set<string>();
    const extraKeys = new Set(extra.map(([n]) => up(n)));
    for (const en of p.entries ?? []) {
      const key = up(en.name);
      if (extraKeys.has(key) || seen.has(key)) continue;
      const t = outHandleOf(en.handle);
      if (!t) continue;
      seen.add(key);
      items.push([en.name, t, en.code === 3 || en.code === 5 ? 3
        : en.code === 2 || en.code === 4 ? 2 : ownCode]);
    }
    for (const [n, t, code] of extra) {
      const key = up(n);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push([n, t, code]);
    }
    w(0, p.sourceType || 'DICTIONARY');
    if (p.tags?.length) {
      writeSealedTags(p.tags, h, owner, { src: p.handle, reactors: p.reactors, dict: items });
      return;
    }
    w(5, h);
    writeFences(p.handle, p.reactors, h);
    w(330, owner);
    w(100, 'AcDbDictionary');
    if (p.hardOwner) w(280, 1);
    w(281, p.cloning ?? 1);
    for (const [n, t, code] of items) { w(3, n); w(code === 3 ? 360 : 350, t); }
    writeXdata(p);
  };

  /** An XRECORD from its typed values — the record read from a DWG,
   *  whose bits have no DXF spelling but whose values do — under its
   *  owner, with the identity its seal carries. A pointer in the data
   *  (320–369) names an object of the source file: repointed at the
   *  number that object got here, nulled when it was not written (a 360
   *  left verbatim would claim whatever record holds that number now:
   *  "Bad handle … already in use", file discarded); under
   *  preserveHandles it is still true and travels as it was. */
  const writeXrecordValues = (
    x: XRecord, h: string, owner: string, seal?: UnknownObject
  ): void => {
    w(0, 'XRECORD'); w(5, h);
    writeFences(seal?.handle, seal?.reactors, h);
    w(330, owner);
    w(100, 'AcDbXrecord'); w(280, seal?.cloning ?? 1);
    for (const v of x.values) {
      if ('point' in v) {
        w(v.code, fmt(v.point.x));
        w(v.code + 10, fmt(v.point.y));
        w(v.code + 20, fmt(v.point.z ?? 0));
      } else if (v.code >= 320 && v.code <= 369) {
        const src = String(v.value);
        w(v.code, outHandleOf(src) ?? (preserve && up(src) !== '0' ? src : 0));
      } else {
        w(v.code, typeof v.value === 'number' ? fmt(v.value) : v.value);
      }
    }
  };

  /** A record sealed as DWG bits, as an ACAD_PROXY_OBJECT of its class.
   *  The payload is the record's data area exactly as an object record
   *  of its generation lays it out: the data bits, and from R2007 the
   *  string stream behind them with its size (two words past 0x7FFF)
   *  and the strings-present flag as the last bit — a bare 0 bit when
   *  there are no strings. Measured on the reference with A-01's 102
   *  FIELDs and its evaluation graph: the data bits alone unwrap only
   *  the records whose strings happen not to matter, a count-prefixed
   *  envelope hangs its loader, and this layout unwraps every one on
   *  open — `(entget)` answers FIELD, and its own DXFOUT lists them
   *  natively. Under the version word of the filer that wrote the bits,
   *  DWG format (70 = 0), then the reference list and the record's own
   *  xdata. */
  const writeSealedProxy = (o: UnknownObject, h: string, owner: string): void => {
    const enc = o.encoding ?? 2018;
    const payload = new BitWriter();
    if (o.data && o.dataBits) payload.putBits(fromBase64(o.data), o.dataBits);
    if (enc >= 2007) {
      const sb = o.strData ? o.strBits ?? 0 : 0;
      if (sb === 0) payload.b(0);
      else {
        payload.putBits(fromBase64(o.strData!), sb);
        if (sb >= 0x8000) { payload.rs(sb >> 15); payload.rs((sb & 0x7fff) | 0x8000); } else payload.rs(sb);
        payload.b(1);
      }
    }
    const bits = payload.pos;
    w(0, 'ACAD_PROXY_OBJECT'); w(5, h);
    writeFences(o.handle, o.reactors, h);
    w(330, owner);
    w(100, 'AcDbProxyObject');
    w(90, 499);
    w(91, classIdOf(o.appClass!.dxfName));
    w(95, proxyVersionOf(o));
    w(70, 0);
    w(93, bits);
    emit310Chunks(payload.bytes());
    writeProxyRefs(o.refs);
    w(94, 0);
    writeXdata(o);
  };

  /** The text style a record points at by hard handle: the named one,
   *  else Standard, else the first in the table. */
  const textStyleHandleFor = (name?: string): string =>
    styleHandleOf.get((name ?? '').toLowerCase()) ?? styleHandleOf.get('standard')
      ?? [...styleHandleOf.values()][0] ?? '0';

  /** The entity whose common properties a derived record borrows —
   *  without the source handle, or every derived record would be
   *  numbered from the same `newHandleOf` slot and collide. */
  const propsOf = (ent: Entity): Entity => {
    const p = { ...ent };
    delete p.handle;
    delete p.reactors;
    delete p.xdict;
    return p;
  };

  /** A table's grid as polylines and its cell text, with the table's
   *  top-left corner at (ox, oy): the picture inside a table's own *T
   *  block (origin 0,0), or the whole table where no record can be. */
  const writeTablePicture = (ent: TableEntity, ox: number, oy: number): void => {
    const props = propsOf(ent);
    const xs: number[] = [ox];
    for (const wdt of ent.columnWidths) xs.push(xs[xs.length - 1] + wdt);
    const ys: number[] = [oy];
    for (const h of ent.rowHeights) ys.push(ys[ys.length - 1] - h);
    const box = (x1: number, y1: number, x2: number, y2: number): void => {
      entStart('LWPOLYLINE', props, 'AcDbPolyline');
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
  };

  /** A multileader as its leader lines plus the annotation text — the
   *  picture, for a file that carries no MULTILEADER class. */
  const writeMLeaderPicture = (ent: MLeaderEntity): void => {
    const props = propsOf(ent);
    for (const leader of ent.leaders) {
      for (const line of leader.lines) {
        const pts = leader.landing && line.length ? [...line, leader.landing] : line;
        if (pts.length < 2) continue;
        entStart('LWPOLYLINE', props, 'AcDbPolyline');
        w(90, pts.length);
        w(70, 0);
        for (const p of pts) { w(10, fmt(p.x)); w(20, fmt(p.y)); }
      }
    }
    if (ent.text && ent.textPosition) {
      writeEntityBody({
        type: 'mtext', layer: ent.layer, color: ent.color,
        position: ent.textPosition, text: ent.text,
        height: ent.textHeight ?? 2.5, rotation: ent.textRotation ?? 0
      });
    }
  };

  /** The MULTILEADER record, in the reference's own R2000 DXF spelling
   *  (its DXFOUT of the multileader sample, group for group). After
   *  AcDbMLeader comes the fenced 300 CONTEXT_DATA{ … 301 } block: the
   *  overall scale (40), the content base point (10), text height (41),
   *  arrowhead size (140), landing gap (145), the attachment quartet,
   *  then the text (290 flag, 304 contents, 340 style, 12 location, 13
   *  direction, 42 rotation, colours and the column/background words)
   *  or the block (296 flag, 341 record, 14 normal, 15 location, 16
   *  scale, 46 rotation, 93 colour, the 4x4 transform as sixteen 47s),
   *  the content plane (110/111/112) and one 302 LEADER{ … 303 } per
   *  leader — 290/291 presence flags, 10 the point where the leader
   *  meets the dogleg, 11 the dogleg direction, 90 its index, 40 the
   *  dogleg length, and a 304 LEADER_LINE{ … 305 } per line holding
   *  that line's points as 10/20/30 runs with its 91 index. The groups
   *  after the block restate the style-level facts: 340 the
   *  MLEADERSTYLE, 90 which properties the record overrides, line type,
   *  colour, linetype and weight (170/91/341/171), the landing and
   *  dogleg switches (290/291) and sizes (41 dogleg, 42 arrowhead),
   *  172 the content type (1 block, 2 mtext), 343 the text style, the
   *  text attachment/angle/alignment words, 92 the text colour, 292
   *  the frame, 344 the block record, 93 the block colour, 10 the block
   *  scale, 43 its rotation, 176 its connection, 293 annotative, and
   *  the closing 294/178/179/45 (text direction, IPE alignment, text
   *  attachment point, overall scale). The groups the reference adds
   *  from 2010 on (270 version, 271–273 attachment directions, 295)
   *  have no place in an AC1015 file and are not written. */
  /** The number this file gave the ATTDEF an attribute value names — by
   *  the source handle when it maps to one of the block's definitions,
   *  else by the value's 1-based index among them. */
  const attdefHandleFor = (
    blockName: string, a: { attdef?: string; index?: number }
  ): string => {
    const defs = (blocks[blockName]?.entities ?? []).filter(
      (x): x is TextEntity => x.type === 'text' && x.attribute === 'attdef');
    if (a.attdef) {
      const h = outHandleOf(a.attdef);
      if (h && defs.some((d) => entOut.get(d) === h)) return h;
    }
    const d = defs[(a.index || 1) - 1];
    return (d && entOut.get(d)) || '0';
  };

  const writeMLeader = (ent: MLeaderEntity): void => {
    const hasText = ent.text !== undefined && ent.text !== null;
    const blockRec = ent.blockName ? blockRecHandle[ent.blockName] : undefined;
    const hasBlock = !hasText && !!blockRec;
    const scale = isNum(ent.scale) && ent.scale > 0 ? ent.scale : 1;
    const textHeight = isNum(ent.textHeight) && ent.textHeight > 0 ? ent.textHeight : 0.18;
    const arrow = isNum(ent.arrowSize) && ent.arrowSize > 0 ? ent.arrowSize : 0.18;
    const l0 = ent.leaders[0];
    const dogleg = isNum(l0?.doglegLength) ? l0!.doglegLength! : 0;
    const firstPt = ent.leaders.flatMap((l) => l.lines).find((ln) => ln.length)?.[0];
    /* the content base point: where the first dogleg ends */
    const cb: Point3 = l0?.landing && l0.doglegVector
      ? {
          x: l0.landing.x + l0.doglegVector.x * dogleg,
          y: l0.landing.y + l0.doglegVector.y * dogleg,
          z: (l0.landing.z ?? 0) + (l0.doglegVector.z ?? 0) * dogleg
        }
      : ent.textPosition ?? ent.blockPosition ?? l0?.landing ?? firstPt ?? { x: 0, y: 0, z: 0 };
    const tsH = textStyleHandleFor(ent.textStyle);
    const pt = (code: number, p: Point3): void => {
      w(code, fmt(p.x)); w(code + 10, fmt(p.y)); w(code + 20, fmt(p.z ?? 0));
    };
    entStart('MULTILEADER', ent, 'AcDbMLeader');
    w(300, 'CONTEXT_DATA{');
    w(40, fmt(scale));
    pt(10, cb);
    w(41, fmt(textHeight));
    w(140, fmt(arrow));
    w(145, 0.09);                         /* landing gap */
    w(174, 1); w(175, 1);                 /* left / right attachment */
    w(176, 0); w(177, 0);                 /* text align type, attachment type */
    w(290, hasText ? 1 : 0);
    if (hasText) {
      /* the contents, chunked like an MTEXT body past 250 characters */
      emitChunked(mtextBody(ent.text!), 304, 304);
      w(11, 0); w(21, 0); w(31, 1);       /* text normal */
      w(340, tsH);
      pt(12, ent.textPosition ?? cb);
      const rot = ent.textRotation ?? 0;
      w(13, fmt(Math.cos(rot))); w(23, fmt(Math.sin(rot))); w(33, 0);
      w(42, fmt(rot)); w(43, 0); w(44, 0); /* rotation, width, height */
      w(45, 1); w(170, 1);                /* line spacing factor, style */
      w(90, -1073741824);                 /* text colour: ByLayer */
      w(171, 1); w(172, 5);               /* attachment, flow direction */
      w(91, -1073741824);                 /* background colour */
      w(141, 0); w(92, 13421772);         /* background scale, transparency */
      w(291, 0); w(292, 0);               /* background fill, mask */
      w(173, 0); w(293, 0);               /* column type, auto height */
      w(142, 0); w(143, 0);               /* column width, gutter */
      w(294, 0); w(295, 0);               /* flow reversed, word break */
    }
    w(296, hasBlock ? 1 : 0);
    if (hasBlock) {
      w(341, blockRec!);
      w(14, 0); w(24, 0); w(34, 1);       /* block normal */
      const bp = ent.blockPosition ?? cb;
      const bs = ent.blockScale ?? { x: 1, y: 1, z: 1 };
      const br = ent.blockRotation ?? 0;
      pt(15, bp);
      w(16, fmt(bs.x)); w(26, fmt(bs.y)); w(36, fmt(bs.z ?? 1));
      w(46, fmt(br));
      w(93, -1073741824);                 /* block colour: ByLayer */
      const c = Math.cos(br), s = Math.sin(br);
      for (const v of [
        bs.x * c, -bs.y * s, 0, bp.x,
        bs.x * s, bs.y * c, 0, bp.y,
        0, 0, bs.z ?? 1, bp.z ?? 0,
        0, 0, 0, 1
      ]) w(47, fmt(v));
    }
    pt(110, firstPt ?? cb);               /* content plane origin */
    w(111, 1); w(121, 0); w(131, 0);
    w(112, 0); w(122, 1); w(132, 0);
    w(297, 0);                            /* normal reversed */
    ent.leaders.forEach((ld, i) => {
      const lastPt = ld.lines.find((ln) => ln.length)?.slice(-1)[0];
      const landing = ld.landing ?? lastPt ?? cb;
      const dv = ld.doglegVector ?? { x: 1, y: 0, z: 0 };
      w(302, 'LEADER{');
      w(290, 1); w(291, 1);
      pt(10, landing);
      pt(11, dv);
      w(90, i);
      w(40, fmt(isNum(ld.doglegLength) ? ld.doglegLength : dogleg));
      ld.lines.forEach((line, j) => {
        w(304, 'LEADER_LINE{');
        for (const p of line) pt(10, p);
        w(91, j);
        w(305, '}');
      });
      w(303, '}');
    });
    w(301, '}');
    w(340, mleaderStyleHandleFor(ent.styleName));
    /* the properties this record states itself rather than taking from
       the style: dogleg length (7), arrowhead size (9), text height (17)
       and overall scale (25); a block adds content type (10), block id
       (20), scale (22) and rotation (23) */
    w(90, 0x80 | 0x200 | 0x20000 | 0x2000000
      | (hasBlock ? 0x400 | 0x100000 | 0x400000 | 0x800000 : 0));
    w(170, 1);                            /* leader line type: straight */
    w(91, -1056964608);                   /* line colour: ByBlock */
    w(341, ltypeHandleOf.get('byblock') ?? '0');
    w(171, -2);                           /* lineweight: ByBlock */
    w(290, ent.hasLanding === false ? 0 : 1);
    w(291, ent.hasDogleg === false ? 0 : 1);
    w(41, fmt(dogleg));
    w(42, fmt(arrow));
    w(172, hasBlock ? 1 : 2);
    w(343, tsH);
    w(173, 1); w(95, 1);                  /* text left / right attachment */
    w(174, 1); w(175, 0);                 /* text angle type, alignment */
    w(92, -1056964608);                   /* text colour: ByBlock */
    w(292, 0);                            /* text frame */
    if (hasBlock) w(344, blockRec!);
    w(93, -1056964608);                   /* block colour: ByBlock */
    const bs2 = ent.blockScale ?? { x: 1, y: 1, z: 1 };
    w(10, fmt(bs2.x)); w(20, fmt(bs2.y)); w(30, fmt(bs2.z ?? 1));
    w(43, fmt(ent.blockRotation ?? 0));
    w(176, 0);                            /* block connection type */
    w(293, 0);                            /* annotative */
    /* the block labels, between the annotative flag and the text
       direction as the reference's own export places them: 330 the
       ATTDEF (under the number this file gave it), 177 the index, 44
       the width, 302 the value */
    if (hasBlock) {
      for (const lb of ent.attributes ?? []) {
        if (typeof lb.text !== 'string') continue;
        w(330, attdefHandleFor(ent.blockName!, lb));
        w(177, lb.index || 1);
        w(44, fmt(lb.width ?? 0));
        w(302, encodeCadSymbols(lb.text));
      }
    }
    w(294, 0);                            /* text direction negative */
    w(178, 0);                            /* IPE alignment */
    w(179, 1);                            /* text attachment point */
    w(45, fmt(scale));
  };

  /** The ACAD_TABLE record, in the reference's own R2000 DXF spelling
   *  (its DXFOUT of the tables sample, group for group): a block
   *  reference prologue — 2 the table's *T<n> block, 10 the insertion
   *  point — then AcDbTable: 342 the TABLESTYLE, 343 the block record,
   *  11 the row direction, 90 the value flags, 91 rows, 92 columns,
   *  93–96 the override words, one 141 per row height, one 142 per
   *  column width, and the cells row by row. Each cell opens with its
   *  171 type (1 text, 2 block), then 172 flags, 173 merged-into-another,
   *  174 autofit, 175/176 the merge extent in columns/rows, 177 which
   *  properties it overrides (1 alignment, 32 text height), 178 virtual
   *  edge and 145 rotation; a text cell's contents follow as 3-chunked
   *  group 1, a block cell's as 340 the record, 144 the scale and 179
   *  its attribute count; 170 alignment and 140 text height close a cell
   *  that states them. The 2008+ words (280 version, 91 per-cell flags,
   *  92, the 301 CELL_VALUE block) belong to later file versions and are
   *  not written into an AC1015 file — the reference's own R2000 DXF
   *  leaves them out the same way. */
  const writeTable = (ent: TableEntity, blockName: string, blockRec: string): void => {
    const rows = ent.numRows, cols = ent.numColumns;
    /* the cells a merge covers — every one but its anchor */
    const covered = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = ent.cells[r * cols + c];
        if (!cell || covered[r * cols + c]) continue;
        const sc = Math.max(1, cell.spanColumns ?? 1), sr = Math.max(1, cell.spanRows ?? 1);
        for (let rr = r; rr < Math.min(rows, r + sr); rr++) {
          for (let cc = c; cc < Math.min(cols, c + sc); cc++) {
            if (rr !== r || cc !== c) covered[rr * cols + cc] = 1;
          }
        }
      }
    }
    entStart('ACAD_TABLE', ent, 'AcDbBlockReference');
    w(2, blockName);
    w(10, fmt(ent.position.x)); w(20, fmt(ent.position.y)); w(30, fmt(ent.position.z ?? 0));
    w(100, 'AcDbTable');
    w(342, tableStyleHandleFor(ent.styleName));
    w(343, blockRec);
    const dir = ent.direction ?? { x: 1, y: 0, z: 0 };
    w(11, fmt(dir.x)); w(21, fmt(dir.y)); w(31, fmt(dir.z ?? 0));
    w(90, 22);                            /* flags for table value */
    w(91, rows); w(92, cols);
    /* the table-level override word and its values, as the reference's
       own export spells a header-less legend (`93 3, 280 1, 281 1`):
       0x01 title suppressed (280), 0x02 header suppressed (281), 0x04
       flow direction (70), 0x08/0x10 the cell margins (40/41) */
    const tf = (ent.titleSuppressed ? 0x01 : 0) | (ent.headerSuppressed ? 0x02 : 0)
      | (isNum(ent.flowDirection) ? 0x04 : 0)
      | (isNum(ent.horizontalMargin) ? 0x08 : 0)
      | (isNum(ent.verticalMargin) ? 0x10 : 0);
    w(93, tf); w(94, 0); w(95, 0); w(96, 0);
    if (tf & 0x01) w(280, 1);
    if (tf & 0x02) w(281, 1);
    if (tf & 0x04) w(70, ent.flowDirection!);
    if (tf & 0x08) w(40, fmt(ent.horizontalMargin!));
    if (tf & 0x10) w(41, fmt(ent.verticalMargin!));
    for (let r = 0; r < rows; r++) w(141, fmt(isNum(ent.rowHeights[r]) ? ent.rowHeights[r] : 1));
    for (let c = 0; c < cols; c++) w(142, fmt(isNum(ent.columnWidths[c]) ? ent.columnWidths[c] : 1));
    /* the per-cell overrides, in the reference's own R2000 spelling: the
       177 word (0x01 alignment, 0x02 fill switch, 0x04 fill colour, 0x08
       text colour, 0x10 text style, 0x20 text height; per edge
       top/right/bottom/left colour 0x40<<i, lineweight 0x400<<i,
       visibility 0x4000<<i — a 16-bit group, so the bottom and left
       visibility bits fall off exactly as they do in its export), then
       170 / 283 / 63 / 64 / 7 / 140, and the edges as it orders them:
       right (275/285/65), bottom (276/286/66), left (278/288/68), top
       (279/289/69), each as lineweight, visibility, colour */
    const aci = (c: Color): number => c.kind === 'byBlock' ? 0
      : c.kind === 'byLayer' ? 256 : c.kind === 'aci' ? c.index : nearestAci(c.rgb);
    const styleKnown = (nm?: string): boolean => !!nm
      && drawing.textStyles.some((s) => s.name.toLowerCase() === nm.toLowerCase());
    const EDGES = ['top', 'right', 'bottom', 'left'] as const;
    const EDGE_CODES: Record<typeof EDGES[number], [number, number, number]> = {
      top: [279, 289, 69], right: [275, 285, 65], bottom: [276, 286, 66], left: [278, 288, 68]
    };
    for (let i = 0; i < rows * cols; i++) {
      const cell = ent.cells[i] ?? {};
      const isCovered = covered[i] === 1 || cell.merged === true;
      const cellBlock = cell.contentType === 2 && cell.blockName
        ? blockRecHandle[cell.blockName] : undefined;
      const hasHeight = isNum(cell.textHeight) && cell.textHeight > 0;
      const textStyle = styleKnown(cell.textStyle) ? cell.textStyle : undefined;
      let flags = (cell.alignment !== undefined || cellBlock ? 0x01 : 0)
        | (cell.fillEnabled !== undefined ? 0x02 : 0)
        | (cell.fillColor ? 0x04 : 0) | (cell.textColor ? 0x08 : 0)
        | (textStyle ? 0x10 : 0) | (hasHeight ? 0x20 : 0);
      EDGES.forEach((edge, k) => {
        const b = cell.borders?.[edge];
        if (!b) return;
        if (b.color) flags |= 0x40 << k;
        if (isNum(b.lineweight)) flags |= 0x400 << k;
        if (b.visible !== undefined) flags |= 0x4000 << k;
      });
      w(171, cellBlock ? 2 : 1);
      /* 172: the edges the cell overrides (1 top, 2 right, 4 bottom, 8
         left) — the reference's DXFIN takes an edge override only when
         this byte announces it (proven on its re-export of ours) */
      w(172, EDGES.reduce((m, edge, k) => cell.borders?.[edge] ? m | (1 << k) : m, 0));
      w(173, isCovered ? 1 : 0);
      w(174, cell.autofit ? 1 : 0);
      w(175, isCovered ? 1 : Math.max(1, cell.spanColumns ?? 1));
      w(176, isCovered ? 1 : Math.max(1, cell.spanRows ?? 1));
      w(177, flags & 0xffff);
      w(178, 0);
      w(145, fmt(isNum(cell.rotation) ? cell.rotation : 0));
      if (cellBlock) {
        w(340, cellBlock); w(144, 1);
        const attrs = (cell.attributes ?? []).filter((a) => typeof a.text === 'string');
        w(179, attrs.length);
        for (const a of attrs) {
          w(331, attdefHandleFor(cell.blockName!, a));
          w(300, encodeCadSymbols(a.text));
        }
        w(170, cell.alignment ?? 5);
      } else {
        emitMtextValue(mtextBody(cell.text ?? ''));
        if (cell.alignment !== undefined) w(170, cell.alignment);
      }
      if (cell.fillEnabled !== undefined) w(283, cell.fillEnabled ? 0 : 1);   /* "fill none" */
      if (cell.fillColor) w(63, aci(cell.fillColor));
      if (cell.textColor) w(64, aci(cell.textColor));
      if (textStyle) w(7, encodeCadSymbols(textStyle));
      if (hasHeight) w(140, fmt(cell.textHeight!));
      for (const edge of ['right', 'bottom', 'left', 'top'] as const) {
        const b = cell.borders?.[edge];
        if (!b) continue;
        const [lwCode, visCode, colCode] = EDGE_CODES[edge];
        if (isNum(b.lineweight)) w(lwCode, b.lineweight);
        if (b.visible !== undefined) w(visCode, b.visible ? 0 : 1);
        if (b.color) w(colCode, aci(b.color));
      }
    }
  };

  const writeEntity = (ent: Entity): void => {
    writeEntityBody(ent);
    /* insert-with-attribs emits its xdata inline, before the ATTRIB run;
       a sealed unknown's tags already carry any xdata verbatim */
    if (ent.type === 'insert' && ent.attributes?.length) return;
    if (ent.type === 'unknown' && ent.tags?.length) return;
    if (ent.type === 'mleader' && usesMLeaders) {
      /* the reference stamps every MULTILEADER with its ACAD_MLEADERVER
         xdata (1070 2); one that arrived without it leaves with it */
      const xd = ent.xdata ?? [];
      writeXdata({
        xdata: xd.some((g) => g.appName === 'ACAD_MLEADERVER') ? xd
          : [...xd, { appName: 'ACAD_MLEADERVER', values: [{ code: 1070, value: 2 }] }]
      });
      return;
    }
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
        const is3d = ent.heavy === '3d' || ent.vertices.some((p) => p.z !== undefined);
        if (ent.heavy || is3d) {
          /* the heavy POLYLINE: a header, one VERTEX per vertex, a SEQEND
             — the mesh flavours' sibling. 70: 1 closed, 2 curve-fit,
             4 spline-fit, 8 3D, 128 plinegen; 75 the spline type. A
             spline-fit polyline writes its frame (VERTEX 70 = 16) ahead
             of the fitted curve (8); a curve-fit one flags the inserted
             vertices (1); a 3D one's vertices all carry 32. */
          const fit = ent.fit;
          const flag = (ent.closed ? 1 : 0) | (fit === 'curve' ? 2 : fit ? 4 : 0)
            | (is3d ? 8 : 0) | (ent.plineGen ? 128 : 0);
          entStart('POLYLINE', ent, is3d ? 'AcDb3dPolyline' : 'AcDb2dPolyline');
          w(66, 1);
          w(10, 0); w(20, 0); w(30, is3d ? 0 : fmt(ent.elevation ?? 0));
          w(70, flag);
          if (fit === 'quadratic') w(75, 5);
          else if (fit === 'cubic') w(75, 6);
          if (!is3d) writeExtrusion(ent);
          /* sub-records repeat the owner's space, layer, colour, linetype
             and weight — the audit resets a vertex whose colour differs
             from its owner's, one error per vertex */
          const subEnt = (): void => {
            w(100, 'AcDbEntity');
            if (inPaperSpace) w(67, 1);
            w(8, ent.layer || '0');
            writeColor(ent.color);
            if (ent.linetype) w(6, ent.linetype);
            if (isNum(ent.lineweight)) w(370, lineweightCode(ent.lineweight));
          };
          const vertex = (p: (typeof ent.vertices)[number], vflag: number): void => {
            w(0, 'VERTEX'); w(5, handle()); w(330, currentOwner);
            subEnt();
            w(100, 'AcDbVertex');
            w(100, is3d ? 'AcDb3dPolylineVertex' : 'AcDb2dVertex');
            w(10, fmt(p.x)); w(20, fmt(p.y));
            w(30, fmt(is3d ? (p.z ?? 0) : (ent.elevation ?? 0)));
            if (!is3d) {
              if (isNum(p.startWidth) && p.startWidth !== 0) w(40, fmt(p.startWidth));
              if (isNum(p.endWidth) && p.endWidth !== 0) w(41, fmt(p.endWidth));
              if (isNum(p.bulge) && p.bulge !== 0) w(42, fmt(p.bulge));
            }
            w(70, vflag | (is3d ? 32 : 0) | (isNum(p.tangent) ? 2 : 0));
            if (isNum(p.tangent)) w(50, fmt(p.tangent * DEG));
            if (isNum(p.id) && p.id) w(91, p.id);
          };
          /* the reference's order for a spline-fit polyline: the first
             frame vertex, the whole fitted run, then the rest of the
             frame (16, 8×n, 16, 16 on its DXF of Road Profile and T-01);
             the readers sort by flag, so either order reads the same */
          const frame = fit && fit !== 'curve' ? (ent.frame ?? []) : [];
          if (frame.length) vertex(frame[0], 16);
          for (const p of ent.vertices) {
            vertex(p, fit === 'curve' ? (p.curveFit ? 1 : 0) : fit ? 8 : 0);
          }
          for (const p of frame.slice(1)) vertex(p, 16);
          w(0, 'SEQEND'); w(5, handle()); w(330, currentOwner);
          subEnt();
          return;
        }
        entStart('LWPOLYLINE', ent, 'AcDbPolyline');
        w(90, ent.vertices.length);
        w(70, (ent.closed ? 1 : 0) | (ent.plineGen ? 128 : 0));
        if (isNum(ent.constantWidth) && ent.constantWidth > 0) w(43, fmt(ent.constantWidth));
        if (isNum(ent.elevation) && ent.elevation !== 0) w(38, fmt(ent.elevation));
        writeExtrusion(ent);
        for (const p of ent.vertices) {
          w(10, fmt(p.x)); w(20, fmt(p.y));
          /* 40/41/42/91 are positional: they belong to the vertex opened
             by the preceding 10 */
          if (isNum(p.startWidth)) w(40, fmt(p.startWidth));
          if (isNum(p.endWidth)) w(41, fmt(p.endWidth));
          if (isNum(p.bulge) && p.bulge !== 0) w(42, fmt(p.bulge));
          if (isNum(p.id) && p.id) w(91, p.id);
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
        if (ent.attribute === 'attdef') { writeAttdef(ent); return; }
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
        /* Associative only when its boundary objects are in this file:
           the links (97 n + 330 …) and the reactor each boundary entity
           carries back go together — a hatch that CLAIMS the link
           without them is an AUDIT error ("Boundary Undefined") on every
           single one, and a link without its reactor is another
           ("Boundary Missing a Reactor"). */
        const bounds = hatchLoopHandles.get(ent);
        w(71, bounds ? 1 : 0);
        w(91, ent.loops.length);
        ent.loops.forEach((b, i) => writeHatchLoop(b, i === 0, bounds?.[i] ?? []));
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
        if (ent.pixelSize !== undefined) w(47, fmt(ent.pixelSize));
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
        if (ent.clipInverted) w(290, 1);     /* inverted clip (2010+) */
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
        {
          const ann = outHandleOf(ent.annotation);
          w(73, ann ? (ent.annotationType ?? 0) : 3);
          w(76, ent.vertices.length);
          for (const p of ent.vertices) {
            w(10, fmt(p.x)); w(20, fmt(p.y)); w(30, fmt(p.z ?? 0));
          }
          if (ann) w(340, ann);
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
        const sat = satOf(ent);
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
        w(68, 1); w(69, ent.id ?? 1);
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
        if (!usesMLeaders) {
          /* no class pair in this file (a multileader met only inside a
             proxy's picture): its leader lines plus the annotation text,
             which every reader draws without the class */
          writeMLeaderPicture(ent);
          return;
        }
        writeMLeader(ent);
        return;
      }

      case 'table': {
        const tb = tableBlockOf.get(ent);
        if (!tb) {
          /* a table without a record of its own (one met only inside a
             proxy's picture): the grid and the text, in place */
          writeTablePicture(ent, ent.position.x, ent.position.y);
          return;
        }
        writeTable(ent, tb.name, tb.rec);
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
          writeSealedTags(ent.tags, entOut.get(ent) ?? handle(), currentOwner,
            { src: ent.handle, reactors: ent.reactors });
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
  for (const nm of paperBlockNames) {
    const def = blocks[nm];
    const base = def.basePoint ?? { x: 0, y: 0, z: 0 };
    const owner = blockRecHandle[nm];
    w(0, 'BLOCK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(67, 1); w(8, '0'); w(100, 'AcDbBlockBegin');
    w(2, nm); w(70, 0);
    w(10, fmt(base.x)); w(20, fmt(base.y)); w(30, fmt(base.z ?? 0));
    w(3, nm); w(1, '');
    currentOwner = owner;
    inPaperSpace = true;
    def.entities.forEach(writeEntity);
    inPaperSpace = false;
    currentOwner = msRecHandle;
    w(0, 'ENDBLK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(67, 1); w(8, '0'); w(100, 'AcDbBlockEnd');
  }
  for (const nm of blockNames) {
    const def = blocks[nm];
    const base = def.basePoint ?? { x: 0, y: 0, z: 0 };
    const owner = blockRecHandle[nm];
    const xref = def.xref;
    /* a dynamic block's graph (its visibility states, parameters and
       actions) is not rebuilt here: when the genuine graph travels
       sealed under the block record's extension dictionary the block is
       dynamic as the source had it, otherwise it is written static and
       the drawing's warnings say so, as the DWG writers' `downgraded`
       does */
    {
      const nStates = def.visibilityStates?.length ?? 0;
      const nParams = def.parameters?.length ?? 0;
      const nActions = def.actions?.length ?? 0;
      if ((nStates || nParams || nActions) && !graphTravels(nm)) {
        drawing.warnings.push(`dynamic block ${nm}: `
          + (nStates ? `${nStates} visibility state(s), ` : '')
          + `${nParams} parameter(s) and ${nActions} action(s) written static`);
      }
    }
    w(0, 'BLOCK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(8, '0'); w(100, 'AcDbBlockBegin');
    w(2, outBlockName(nm));
    /* 4 xref, 8 overlay; the resolved bit (32) is the reference's to
       set once it has found the file, and is ignored on input */
    w(70, xref ? 4 | (xref.overlay ? 8 : 0) : 0);
    w(10, fmt(base.x)); w(20, fmt(base.y)); w(30, fmt(base.z ?? 0));
    w(3, outBlockName(nm)); w(1, xref ? xref.path : '');
    if (xref) {
      /* an attachment's geometry lives in the referenced file: its
         record owns nothing, whatever a consumer left in `entities` */
      if (def.entities.length) {
        drawing.warnings.push(def.entities.length + ' entities inside xref block "'
          + nm + '" skipped in DXF: an attachment\'s geometry lives in the referenced file.');
      }
    } else {
      currentOwner = owner;
      def.entities.forEach(writeEntity);
      currentOwner = msRecHandle;
    }
    w(0, 'ENDBLK'); w(5, handle()); w(330, owner);
    w(100, 'AcDbEntity'); w(8, '0'); w(100, 'AcDbBlockEnd');
  }
  /* the tables' own anonymous blocks (70 = 1), each holding the picture
     of its table: the source block's entities when the table named one,
     else the grid drawn at the origin */
  for (const [t, tb] of tableBlockOf) {
    w(0, 'BLOCK'); w(5, handle()); w(330, tb.rec);
    w(100, 'AcDbEntity'); w(8, '0'); w(100, 'AcDbBlockBegin');
    w(2, tb.name); w(70, 1);
    w(10, 0); w(20, 0); w(30, 0);
    w(3, tb.name); w(1, '');
    currentOwner = tb.rec;
    if (tb.src) tb.src.entities.forEach(writeEntity);
    else writeTablePicture(t, 0, 0);
    currentOwner = msRecHandle;
    w(0, 'ENDBLK'); w(5, handle()); w(330, tb.rec);
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
  /* the column-MTEXT recompose record is derived below from the MTEXTs
     themselves; a carried one would name source handles and double it.
     An XRECORD sealed beside its values leaves under its owner with the
     sealed objects (or stays home with them): only the records without
     a seal — the named objects dictionary's own, a caller's — are
     listed here, the named ones straight under the root as the source
     had them, the rest under a dictionary of their own. */
  const xrecords = (drawing.xrecords ?? [])
    .filter((x) => (x.name ?? '').toUpperCase() !== 'ACDB_RECOMPOSE_DATA'
      && !(x.handle && sealedByH.has(up(x.handle))));
  const geo = drawing.geoData;
  /* Unconditional: a DXF without the root dictionary (and the group and
     plot-style dictionaries under it) is discarded by DXFIN outright. */
  {
    w(0, 'SECTION'); w(2, 'OBJECTS');
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
    const xrHandles = xrecords.map((x) => claim(x.handle));
    /* Column MTEXT in an R2000 file: the further columns are MTEXT
       entities of their own, named by handle in the first column's
       ACAD_MTEXT_COLUMNS xdata (the 1005 above, repointed). The reference
       re-attaches them on load only for the parents an
       ACDB_RECOMPOSE_DATA record under the named objects dictionary
       lists — 90 = 1, then one 330 per parent — with the record the
       columns load as one MTEXT, without it as two (externally proven on
       the reference's own R2000 DXF of its Text-and-Tables sample; the
       DWG writers write the same record). */
    const isColumnParent = (e: Entity): boolean => e.type === 'mtext'
      && !!e.xdata?.some((g) => g.values.some((v) => 'value' in v
        && v.code === 1000 && v.value === 'ACAD_MTEXT_COLUMNS_BEGIN'));
    /* the reference's pre-2007 saves list every ACAD_TABLE beside the
       column MTEXTs (one 330 each, ascending by handle) */
    const columnParents = allWritten()
      .filter((e) => isColumnParent(e) || e.type === 'table')
      .map((e) => entOut.get(e))
      .filter((h): h is string => !!h)
      .sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
    const recomposeHandle = columnParents.length ? handle() : '';

    /* ---- the named-objects tree the sealed records hang from. Each
       carries the keys of the dictionaries from the named objects
       dictionary down to its owner (dictPath) and its own key (name).
       A dictionary this writer synthesizes anyway (the named ones below)
       takes the sealed entries as extra entries — a key that collides
       with a synthesized entry loses, record and all. Every other
       dictionary on a path is the source's own when that travels sealed
       (re-listed from its entries, its number kept under
       preserveHandles) and a plain DICTIONARY rebuilt otherwise, so a
       SCALE lands under ACAD_SCALELIST and a MATERIAL under
       ACAD_MATERIAL as in the source, not flattened into the named
       objects dictionary where two "Standard"s would collide. ---- */
    interface DictNode {
      path: string[]; handle: string; keys: Set<string>; entries: [string, string][];
      sealed?: Sealed;
    }
    const upper = (s: string): string => s.toUpperCase();
    const synthesizedTop = new Map<string, { handle: string; keys: string[] }>();
    const synth = (name: string, h: string, keys: string[]): void => {
      if (h) synthesizedTop.set(name, { handle: h, keys });
    };
    synth('ACAD_PLOTSTYLENAME', plotStyleDictHandle, ['Normal']);
    synth('ACAD_GROUP', groupDictHandle, groups.map((g) => g.name));
    synth('ACAD_LAYOUT', layoutDictHandle, outLayouts.map(({ l }) => l.name));
    synth('ACAD_MLINESTYLE', mlDictHandle, mlStyles.map((m) => m.name));
    synth('ACAD_TABLESTYLE', tableStyleDictHandle, tableStylesOut.map((s) => s.name));
    synth('ACAD_MLEADERSTYLE', mleaderStyleDictHandle, mleaderStylesOut.map((s) => s.name));
    synth('ACAD_IMAGE_DICT', imgDictHandle,
      [...imageDefs.keys()].map((_, i) => 'ND_IMAGE_' + (i + 1)));
    for (const [kind, h] of underlayDicts) {
      synth('ACAD_' + kind.toUpperCase() + 'DEFINITIONS', h,
        [...underlayDefs.values()].filter((d) => d.kind === kind)
          .map((_, i) => kind.toUpperCase() + '_' + (i + 1)));
    }
    const nodes = new Map<string, DictNode>();
    const nodeKey = (p: string[]): string => p.map(upper).join(' ');
    const treeDicts: DictNode[] = [];
    /* the source's own tree dictionaries that travel, by the path each
       sits at: the node at that path is the sealed record itself */
    const sealedNodeAt = new Map<string, Sealed>();
    for (const o of sealedObjs) {
      if (isDictKind(o) && o.dictPath !== undefined && o.name !== undefined) {
        sealedNodeAt.set(nodeKey([...o.dictPath, o.name]), o);
      }
    }
    const isNodeDict = (o: Sealed): boolean =>
      isDictKind(o) && o.dictPath !== undefined && o.name !== undefined
      && sealedNodeAt.get(nodeKey([...o.dictPath, o.name])) === o;
    nodes.set('', {
      path: [], handle: rootHandle, entries: [],
      keys: new Set([
        ...synthesizedTop.keys(),
        ...(geoHandle ? ['ACAD_GEOGRAPHICDATA'] : []),
        ...proxyObjs.map((p, i) => upper(p.name ?? ('PROXY_OBJECT_' + (i + 1)))),
        ...(recomposeHandle ? ['ACDB_RECOMPOSE_DATA'] : [])
      ])
    });
    const nodeFor = (path: string[]): DictNode | null => {
      const k = nodeKey(path);
      const have = nodes.get(k);
      if (have) return have;
      const parent = nodeFor(path.slice(0, -1));
      if (!parent) return null;
      const name = path[path.length - 1];
      const top = path.length === 1 ? synthesizedTop.get(upper(name)) : undefined;
      let n: DictNode;
      if (top) {
        n = { path, handle: top.handle, keys: new Set(top.keys.map(upper)), entries: [] };
      } else {
        /* a synthesized entry that is not a dictionary holds the key
           (a sealed parent lists by handle: its entries dedupe by key
           on the way out) */
        if (parent.keys.has(upper(name)) && !parent.sealed) return null;
        const sealed = sealedNodeAt.get(k);
        n = {
          path, handle: sealed ? sealedOut.get(sealed)! : handle(),
          keys: new Set(), entries: [], sealed
        };
        parent.entries.push([name, n.handle]);
        parent.keys.add(upper(name));
        treeDicts.push(n);
      }
      nodes.set(k, n);
      return n;
    };
    /* the source's tree dictionaries first, so their places exist */
    for (const o of sealedNodeAt.values()) nodeFor([...o.dictPath!, o.name!]);
    /** Listed on the tree under a key; false when the key is taken. */
    const place = (n: DictNode, key: string, h: string): boolean => {
      if (n.keys.has(upper(key)) && !n.sealed) return false;
      n.keys.add(upper(key));
      n.entries.push([key, h]);
      return true;
    };
    /* The owner each sealed record leaves under: its source owner when
       that is written (an entity, a record, a proxy, a sealed object,
       the root), else the tree dictionary its path names; null = not
       placed. A record with a path is listed there as well — for a
       sealed tree dictionary the same entry it decoded, deduped on the
       way out. The tree dictionaries themselves go with the tree. */
    const sealedOwner: (string | null)[] = sealedObjs.map((o, i) => {
      if (isNodeDict(o)) return 'tree';
      const n = o.dictPath !== undefined ? nodeFor(o.dictPath) : null;
      const listed = n ? place(n, o.name ?? ('SEALED_OBJECT_' + (i + 1)), sealedObjHandles[i]) : false;
      const oh = outHandleOf(o.ownerHandle);
      if (oh !== undefined) return oh;
      return n && listed ? n.handle : null;
    });
    /* a proxy object under its owner too: a tree dictionary lists it
       there, anything else under the root as before */
    const proxyOwnerOut: string[] = proxyObjs.map((p, i) => {
      const oh = outHandleOf(p.ownerHandle);
      const n = oh !== undefined ? [...nodes.values()].find((x) => x.handle === oh) : undefined;
      if (n && n.path.length) {
        place(n, p.name ?? ('PROXY_OBJECT_' + (i + 1)), proxyObjHandles[i]);
        return n.handle;
      }
      return oh !== undefined && n === undefined ? oh : rootHandle;
    });
    /* the XRECORDs without a seal: a named one straight under the root
       as the source listed it, the rest under a dictionary of their own */
    const rootKeys = nodes.get('')!.keys;
    const xrDirect = xrecords.map((x) => {
      if (!x.name || rootKeys.has(upper(x.name))) return false;
      rootKeys.add(upper(x.name));
      return true;
    });
    const xrLoose = xrecords.map((_, i) => i).filter((i) => !xrDirect[i]);
    const xrDictHandle = xrLoose.length ? handle() : '';
    /** The extra entries a synthesized dictionary lists: sealed records
     *  placed under it and rebuilt dictionaries below it. */
    const extraEntries = (name: string): void => {
      for (const [k, h] of nodes.get(nodeKey([name]))?.entries ?? []) { w(3, k); w(350, h); }
    };

    w(0, 'DICTIONARY'); w(5, rootHandle); w(330, 0);
    w(100, 'AcDbDictionary'); w(281, 1);
    w(3, 'ACAD_PLOTSTYLENAME'); w(350, plotStyleDictHandle);
    w(3, 'ACAD_GROUP'); w(350, groupDictHandle);
    if (layoutDictHandle) { w(3, 'ACAD_LAYOUT'); w(350, layoutDictHandle); }
    if (mlDictHandle) { w(3, 'ACAD_MLINESTYLE'); w(350, mlDictHandle); }
    if (tableStyleDictHandle) { w(3, 'ACAD_TABLESTYLE'); w(350, tableStyleDictHandle); }
    if (mleaderStyleDictHandle) { w(3, 'ACAD_MLEADERSTYLE'); w(350, mleaderStyleDictHandle); }
    if (imgDictHandle) { w(3, 'ACAD_IMAGE_DICT'); w(350, imgDictHandle); }
    if (geoHandle) { w(3, 'ACAD_GEOGRAPHICDATA'); w(350, geoHandle); }
    for (const [kind, h] of underlayDicts) {
      w(3, 'ACAD_' + kind.toUpperCase() + 'DEFINITIONS');
      w(350, h);
    }
    /* proxy objects keep their dictionary names, listed straight under
       the named objects dictionary; an unnamed one still needs a key */
    proxyObjs.forEach((p, i) => {
      if (proxyOwnerOut[i] !== rootHandle) return;
      w(3, p.name ?? ('PROXY_OBJECT_' + (i + 1)));
      w(350, proxyObjHandles[i]);
    });
    /* sealed records placed straight under the named objects dictionary,
       and the tree dictionaries the others hang from */
    for (const [k, h] of nodes.get('')?.entries ?? []) { w(3, k); w(350, h); }
    if (recomposeHandle) { w(3, 'ACDB_RECOMPOSE_DATA'); w(350, recomposeHandle); }
    xrecords.forEach((x, i) => {
      if (xrDirect[i]) { w(3, x.name!); w(350, xrHandles[i]); }
    });
    if (xrDictHandle) { w(3, 'ND_XRECORDS'); w(350, xrDictHandle); }

    /* the plot-style dictionary every LAYER's group 390 points into:
       a with-default dictionary whose one entry, Normal, is a
       placeholder — exactly the shape AutoCAD itself writes */
    w(0, 'ACDBDICTIONARYWDFLT'); w(5, plotStyleDictHandle); w(330, rootHandle);
    w(100, 'AcDbDictionary'); w(281, 1);
    w(3, 'Normal'); w(350, plotStyleHolderHandle);
    extraEntries('ACAD_PLOTSTYLENAME');
    w(100, 'AcDbDictionaryWithDefault'); w(340, plotStyleHolderHandle);
    w(0, 'ACDBPLACEHOLDER'); w(5, plotStyleHolderHandle); w(330, plotStyleDictHandle);

    /* ---- dictionary-owned proxy objects: same record shape as the
       entity form, under AcDbProxyObject ---- */
    proxyObjs.forEach((p, i) => {
      w(0, 'ACAD_PROXY_OBJECT'); w(5, proxyObjHandles[i]);
      writeFences(p.handle, undefined, proxyObjHandles[i]);
      w(330, proxyOwnerOut[i]);
      w(100, 'AcDbProxyObject');
      w(90, 499);                        /* the proxy object class itself */
      w(91, proxyClassId.get(
        proxyClassKey(p.appClass, p.sourceType, 'ACAD_PROXY_OBJECT')) ?? 0);
      writeProxyBody(p);
      writeXdata(p);
    });

    /* ---- the dictionaries of the named-objects tree, each under its
       parent: the source's own (sealed, re-listed from its entries with
       whatever was placed below it beside them) or a plain DICTIONARY
       rebuilt for the records placed on a path the source's tree no
       longer has ---- */
    const emitted = new Set<string>();
    for (const n of treeDicts) {
      const parent = nodes.get(nodeKey(n.path.slice(0, -1)));
      const ownerH = parent?.handle ?? rootHandle;
      if (n.sealed) {
        const code = n.sealed.hardOwner ? 3 : 2;
        const extra: [string, string, number][] = n.entries.map(([k, h]) => [k, h, code]);
        if (n.sealed.handle) extra.push(...(extraFor.get(up(n.sealed.handle)) ?? []));
        writeSealedDict(n.sealed, n.handle, ownerH, extra);
      } else {
        w(0, 'DICTIONARY'); w(5, n.handle); w(330, ownerH);
        w(100, 'AcDbDictionary'); w(281, 1);
        for (const [k, h] of n.entries) { w(3, k); w(350, h); }
      }
      emitted.add(n.handle);
    }

    /* ---- the other sealed objects, owners ahead of what hangs off
       them: a sealed dictionary from its entries, a tagged record
       verbatim (its identity and handle groups re-derived), an XRECORD
       from its values. One whose sealed owner did not make it out is
       left with it. ---- */
    {
      const children = new Map<string, Sealed[]>();
      const roots: Sealed[] = [];
      for (const o of sealedObjs) {
        const owner = o.ownerHandle ? sealedByH.get(up(o.ownerHandle)) : undefined;
        if (owner && owner !== o && travel.has(owner)) {
          const k = up(o.ownerHandle!);
          const list = children.get(k) ?? [];
          list.push(o);
          children.set(k, list);
        } else {
          roots.push(o);
        }
      }
      const order: Sealed[] = [];
      const seen = new Set<Sealed>();
      const visit = (o: Sealed): void => {
        if (seen.has(o)) return;
        seen.add(o);
        order.push(o);
        if (o.handle) for (const c of children.get(up(o.handle)) ?? []) visit(c);
      };
      roots.forEach(visit);
      sealedObjs.forEach(visit);            /* a cycle, if any, still leaves */
      const indexOf = new Map<Sealed, number>();
      sealedObjs.forEach((o, i) => indexOf.set(o, i));
      for (const o of order) {
        const i = indexOf.get(o)!;
        const owner = sealedOwner[i];
        if (!owner || owner === 'tree') continue;
        const h = sealedObjHandles[i];
        const ownerSealed = o.ownerHandle ? sealedByH.get(up(o.ownerHandle)) : undefined;
        if (ownerSealed && ownerSealed !== o && travel.has(ownerSealed)
          && !emitted.has(sealedOut.get(ownerSealed) ?? '')) continue;
        if (isDict(o)) {
          writeSealedDict(o, h, owner, o.handle ? (extraFor.get(up(o.handle)) ?? []) : []);
        } else if (hasTags(o)) {
          w(0, o.sourceType);
          writeSealedTags(o.tags!, h, owner, { src: o.handle, reactors: o.reactors });
        } else if (hasBits(o)) {
          writeSealedProxy(o, h, owner);
        } else {
          const twin = xrecordTwin(o);
          if (!twin) continue;
          writeXrecordValues(twin, h, owner, o);
        }
        emitted.add(h);
      }
    }

    /* ---- the draw-order tables (preserveHandles): the fresh dictionary
       when the block had no sealed one to list the table in, then the
       table in the reference's spelling — the dictionary as reactor and
       owner, the block record, one 331/5 pair per entity out of its
       handle order ---- */
    for (const p of sortPlans) {
      if (!p.sealedDict) {
        w(0, 'DICTIONARY'); w(5, p.dict); w(330, p.block);
        w(100, 'AcDbDictionary'); w(280, 1); w(281, 1);
        w(3, 'ACAD_SORTENTS'); w(360, p.table);
      }
      w(0, 'SORTENTSTABLE'); w(5, p.table);
      w(102, '{ACAD_REACTORS'); w(330, p.dict); w(102, '}');
      w(330, p.dict);
      w(100, 'AcDbSortentsTable');
      w(330, p.block);
      for (const [e, k] of p.pairs) { w(331, e); w(5, k); }
    }

    for (const [kind, dictH] of underlayDicts) {
      const defs = [...underlayDefs.values()].filter((d) => d.kind === kind);
      w(0, 'DICTIONARY'); w(5, dictH); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      defs.forEach((d, i) => { w(3, kind.toUpperCase() + '_' + (i + 1)); w(350, d.handle); });
      extraEntries('ACAD_' + kind.toUpperCase() + 'DEFINITIONS');
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
      extraEntries('ACAD_LAYOUT');
      outLayouts.forEach(({ l, h, brh }, i) => {
        w(0, 'LAYOUT'); w(5, h);
        writeFences(l.handle, undefined, h);
        w(330, layoutDictHandle);
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
      extraEntries('ACAD_GROUP');
      groups.forEach((g, i) => {
        w(0, 'GROUP'); w(5, groupHandles[i]); w(330, groupDictHandle);
        w(100, 'AcDbGroup');
        w(300, g.description ?? '');
        w(70, g.name.startsWith('*') ? 1 : 0);
        w(71, g.selectable === false ? 0 : 1);
        for (const h of g.entityHandles) {
          const nh = outHandleOf(h);
          if (nh) w(340, nh);              /* unwritten members stay out */
        }
      });
    }
    if (mlDictHandle) {
      w(0, 'DICTIONARY'); w(5, mlDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      mlStyles.forEach((m, i) => { w(3, m.name); w(350, mlHandles[i]); });
      extraEntries('ACAD_MLINESTYLE');
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
    if (tableStyleDictHandle) {
      /* Every TABLESTYLE an ACAD_TABLE's 342 can resolve to, spelled as
         the reference's own R2000 DXF spells its Standard: the
         description, flow direction and flags, the margins, the title /
         header suppression switches, then the data, title and header
         cell styles — each its text style and height, alignment, text
         and fill colour, fill switch, and the six borders (lineweight,
         visibility, colour). Values a style leaves unsaid take the
         reference's defaults. */
      w(0, 'DICTIONARY'); w(5, tableStyleDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      tableStylesOut.forEach((s, i) => { w(3, s.name); w(350, tableStyleHandles[i]); });
      extraEntries('ACAD_TABLESTYLE');
      const aciOf = (c: Color | undefined, dflt: number): number =>
        !c ? dflt : c.kind === 'byBlock' ? 0 : c.kind === 'byLayer' ? 256
        : c.kind === 'rgb' ? nearestAci(c.rgb) : c.index;
      const cellOf = (
        c: TableStyleCell | undefined, height: number, align: number
      ): TableStyleCell => ({ textHeight: height, alignment: align, ...c });
      const textStyleNameFor = (name?: string): string =>
        name && styleHandleOf.has(name.toLowerCase()) ? name
        : styleHandleOf.has('standard') ? 'Standard' : styles[0].name;
      tableStylesOut.forEach((s, i) => {
        w(0, 'TABLESTYLE'); w(5, tableStyleHandles[i]); w(330, tableStyleDictHandle);
        w(100, 'AcDbTableStyle');
        w(3, s.description ?? s.name);
        w(70, s.flowDirection ?? 0); w(71, s.flags ?? 0);
        w(40, fmt(s.horizontalMargin ?? 0.06)); w(41, fmt(s.verticalMargin ?? 0.06));
        w(280, s.titleSuppressed ? 1 : 0); w(281, s.headerSuppressed ? 1 : 0);
        const cells = [cellOf(s.data, 0.18, 2), cellOf(s.title, 0.25, 5), cellOf(s.header, 0.18, 5)];
        for (const c of cells) {
          w(7, textStyleNameFor(c.textStyle));
          w(140, fmt(c.textHeight ?? 0.18)); w(170, c.alignment ?? 5);
          w(62, aciOf(c.textColor, 0)); w(63, aciOf(c.fillColor, 7));
          w(283, c.fillOn ? 1 : 0);
          for (let k = 0; k < 6; k++) {
            const b = c.borders?.[k] ?? {};
            w(274 + k, b.lineweight ?? -2);
            w(284 + k, b.visible === false ? 0 : 1);
            w(64 + k, aciOf(b.color, 0));
          }
        }
        writeXdata(s);
      });
    }
    if (mleaderStyleDictHandle) {
      /* Every MLEADERSTYLE a MULTILEADER's 340 can resolve to, field for
         field in the reference's R2000 DXF spelling — the colours as the
         32-bit form (C0 ByLayer, C1 ByBlock, C2 RGB, C3 ACI), the
         linetype, arrowhead, text style and block as handles — and the
         ACAD_MLEADERVER stamp. Values a style leaves unsaid take the
         reference's defaults: mtext content, two-point straight leaders,
         ByBlock colours and linetype, 0.09 landing gap, 0.36 dogleg,
         0.18 arrowhead / text height / align space, 0.125 break size. */
      w(0, 'DICTIONARY'); w(5, mleaderStyleDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      mleaderStylesOut.forEach((s, i) => { w(3, s.name); w(350, mleaderStyleHandles[i]); });
      extraEntries('ACAD_MLEADERSTYLE');
      const dwordOf = (c: Color | undefined): number => {
        const u = !c || c.kind === 'byBlock' ? 0xC1000000
          : c.kind === 'byLayer' ? 0xC0000000
          : c.kind === 'rgb' ? (0xC2000000 | (c.rgb & 0xffffff))
          : (0xC3000000 | (c.index & 0xff));
        return u | 0;
      };
      mleaderStylesOut.forEach((s, i) => {
        w(0, 'MLEADERSTYLE'); w(5, mleaderStyleHandles[i]); w(330, mleaderStyleDictHandle);
        w(100, 'AcDbMLeaderStyle');
        w(170, s.contentType ?? 2);         /* content type: mtext */
        w(171, s.drawMLeaderOrder ?? 1); w(172, s.drawLeaderOrder ?? 0);
        w(90, s.maxLeaderPoints ?? 2);
        w(40, fmt(s.firstSegmentAngle ?? 0)); w(41, fmt(s.secondSegmentAngle ?? 0));
        w(173, s.leaderType ?? 1);          /* leader type: straight */
        w(91, dwordOf(s.lineColor));
        w(340, (s.linetype && ltypeHandleOf.get(s.linetype.toLowerCase()))
          || ltypeHandleOf.get('byblock') || '0');
        w(92, s.lineweight ?? -2);
        w(290, s.landing === false ? 0 : 1); w(42, fmt(s.landingGap ?? 0.09));
        w(291, s.dogleg === false ? 0 : 1); w(43, fmt(s.doglegLength ?? 0.36));
        w(3, s.description ?? s.name);
        const arrow = s.arrowBlock ? blockRecHandle[s.arrowBlock] : undefined;
        if (arrow) w(341, arrow);
        w(44, fmt(s.arrowSize ?? 0.18));
        w(300, s.defaultText ?? '');
        w(342, textStyleHandleFor(s.textStyle));
        w(174, s.textLeftAttachment ?? 1); w(178, s.textRightAttachment ?? 1);
        w(175, s.textAngleType ?? 1); w(176, s.textAlignment ?? 0);
        w(93, dwordOf(s.textColor));
        w(45, fmt(s.textHeight ?? 0.18));
        w(292, s.textFrame ? 1 : 0); w(297, s.alwaysAlignLeft ? 1 : 0);
        w(46, fmt(s.alignSpace ?? 0.18));
        const blk = s.blockName ? blockRecHandle[s.blockName] : undefined;
        if (blk) w(343, blk);
        w(94, dwordOf(s.blockColor));
        const bs = s.blockScale ?? { x: 1, y: 1, z: 1 };
        w(47, fmt(bs.x)); w(49, fmt(bs.y)); w(140, fmt(bs.z ?? 1));
        w(293, s.useBlockScale === false ? 0 : 1);
        w(141, fmt(s.blockRotation ?? 0));
        w(294, s.useBlockRotation === false ? 0 : 1);
        w(177, s.blockConnection ?? 0);
        w(142, fmt(s.scale ?? 1));
        w(295, s.propertyChanged ? 1 : 0); w(296, s.annotative ? 1 : 0);
        w(143, fmt(s.breakSize ?? 0.125));
        const xd = (s.xdata ?? []).filter((g) => g.appName !== 'ACAD_MLEADERVER');
        if (xd.length) writeXdata({ xdata: xd });
        w(1001, 'ACAD_MLEADERVER'); w(1070, 2);
      });
    }
    if (recomposeHandle) {
      w(0, 'XRECORD'); w(5, recomposeHandle); w(330, rootHandle);
      w(100, 'AcDbXrecord'); w(280, 1);
      w(90, 1);
      for (const h of columnParents) w(330, h);
    }
    /* the named records the root lists itself, as the source did */
    xrecords.forEach((x, i) => {
      if (xrDirect[i]) writeXrecordValues(x, xrHandles[i], rootHandle);
    });
    if (xrDictHandle) {
      /* a caller's own records, unnamed or named like an entry the root
         already holds, live under a dictionary of their own so they
         keep an owner without inventing a place in the standard tree;
         a key already taken gets a ~n suffix, the way the DWG writers
         spell it */
      w(0, 'DICTIONARY'); w(5, xrDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      const xrKeys = new Set<string>();
      for (const i of xrLoose) {
        const base = xrecords[i].name ?? ('ND_XRECORD_' + (i + 1));
        let key = base;
        for (let n = 2; xrKeys.has(key.toUpperCase()); n++) key = `${base}~${n}`;
        xrKeys.add(key.toUpperCase());
        w(3, key);
        w(350, xrHandles[i]);
      }
      for (const i of xrLoose) writeXrecordValues(xrecords[i], xrHandles[i], xrDictHandle);
    }
    if (imgDictHandle) {
      w(0, 'DICTIONARY'); w(5, imgDictHandle); w(330, rootHandle);
      w(100, 'AcDbDictionary'); w(281, 1);
      let defIdx = 0;
      for (const [, def] of imageDefs) {
        w(3, 'ND_IMAGE_' + (++defIdx));
        w(350, def.handle);
      }
      extraEntries('ACAD_IMAGE_DICT');
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
  drawing: Drawing, options: { narrowCodes?: boolean } & DxfWriteOptions = {}
): Uint8Array => {
  const text = writeDxf(drawing, { preserveHandles: options.preserveHandles });
  const lines = text.split('\n');
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (!isFinite(code)) { i -= 1; continue; }
    pairs.push([code, lines[i + 1]]);
  }
  return pairsToBinaryDxf(pairs, options.narrowCodes);
};
