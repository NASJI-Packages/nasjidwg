/* nasjidwg — top-level DWG reader: sections -> object map -> objects ->
 * assembled Drawing.
 *
 * Assembly is deliberately tolerant: a single undecodable object costs one
 * warning, never the file. Structure (which entity lives in which space or
 * block) comes from each entity's own entmode + owner handle, which holds
 * across every supported version, with BlockRecord ownership as backup.
 */

import type {
  BlockDefinition, Drawing, Entity, FileVersion, HeaderUcs, Layer, MeshEntity,
  PolylineEntity, PolylineVertex, TextStyle, XdataGroup
} from '../core/model.js';
import { emptyDrawing } from '../core/model.js';
import {
  detectVersion, readFileHeaderR2000, versionRank, codepageName
} from './fileheader.js';
import { readSections2004 } from './sections2004.js';
import { readSections2007 } from './sections2007.js';
import { readObjectMap } from './objectmap.js';
import { readClasses } from './classes.js';
import { readHeaderVars } from './headervars.js';
import { readAcDsSabBlobs, readSummaryInfo, readThumbnail } from './meta.js';
import { crc16 } from './bitwriter.js';
import { decodeProxyGraphics } from './proxy.js';
import { readPreR13 } from './pre13.js';
import {
  decodeObjectBody, encodingGroup, makeContext, toBase64, type RawObject
} from './objects.js';

export interface DwgReadOptions {
  /** Verify per-object and section CRCs; mismatches become warnings. */
  checkCrc?: boolean;
  /** Retain every entity's raw record bytes (Entity.record), enabling
   *  byte-preserving rewrites: with `preserveHandles`, a writer of the
   *  same encoding generation emits untouched records verbatim. */
  retainRecords?: boolean;
}

/** Read a DWG file into a Drawing. Throws only when the file structure is
 *  unusable; object-level trouble lands in drawing.warnings. */
export const readDwg = (
  data: Uint8Array, options: DwgReadOptions = {}
): Drawing => {
  const version = detectVersion(data);
  const v = versionRank(version);
  /* the pre-R13 releases are a different format entirely */
  if (v < 13) return readPreR13(data);

  /* ---- locate sections ---- */
  let handlesSection: Uint8Array;
  let classesSection: Uint8Array | undefined;
  let headerSection: Uint8Array | undefined;
  let summarySection: Uint8Array | undefined;
  let acdsSection: Uint8Array | undefined;
  let objectSpace: Uint8Array;            /* where map offsets point into */
  let codepage: string | undefined;

  if (v <= 2000) {
    const hdr = readFileHeaderR2000(data);
    codepage = hdr.codepage;
    const sec = (id: number) => {
      const s = hdr.sections.find((q) => q.id === id);
      return s ? data.subarray(s.address, s.address + s.size) : undefined;
    };
    headerSection = sec(0);
    classesSection = sec(1);
    const handles = sec(2);
    if (!handles) throw new Error('DWG is missing its object map section.');
    handlesSection = handles;
    objectSpace = data;                   /* offsets are absolute */
  } else {
    const sections = v === 2007 ? readSections2007(data) : readSections2004(data);
    const handles = sections.get('AcDb:Handles');
    const objects = sections.get('AcDb:AcDbObjects');
    if (!handles || !objects) {
      throw new Error('DWG is missing its Handles/Objects sections.');
    }
    handlesSection = handles;
    objectSpace = objects;
    classesSection = sections.get('AcDb:Classes');
    headerSection = sections.get('AcDb:Header');
    summarySection = sections.get('AcDb:SummaryInfo');
    for (const [name, bytes] of sections) {
      if (name.startsWith('AcDb:AcDs')) { acdsSection = bytes; break; }
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    codepage = codepageName(dv.getUint16(0x13, true));
    if (v >= 2007) codepage = undefined;  /* strings are UTF-16 from here on */
  }

  const classes = classesSection
    ? readClasses(classesSection, version, codepage)
    : new Map();
  const ctx = makeContext(version, classes, codepage, data[0x11]);

  /* ---- decode every object in the map ---- */
  const drawing = emptyDrawing();
  drawing.header.version = version;
  drawing.header.codepage = codepage;

  /* ---- file metadata: preview image + summary properties ---- */
  {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const previewAddr = data.length > 0x11 ? dv.getUint32(0x0D, true) : 0;
    const thumb = readThumbnail(data, previewAddr);
    if (thumb) drawing.header.thumbnail = thumb;
    if (summarySection) {
      const info = readSummaryInfo(summarySection, v >= 2007);
      if (info) drawing.header.summary = info;
    }
  }

  /* ---- header variables ---- */
  const hv = headerSection
    ? readHeaderVars(headerSection, version, data[0x0B], codepage)
    : null;
  if (hv) {
    /* Real files ship poisoned extents: a Z of 7.35e+223 next to sane X/Y,
       and the +-1e20 "unset" sentinel. Every component has to be finite
       and in range or the pair is not worth carrying. */
    const sane = (p?: { x: number; y: number; z?: number }): boolean =>
      !!p && [p.x, p.y, p.z ?? 0].every(
        (q) => Number.isFinite(q) && Math.abs(q) < 1e19);
    if (sane(hv.extMin) && sane(hv.extMax)) {
      drawing.header.extMin = hv.extMin;
      drawing.header.extMax = hv.extMax;
    }
    if (sane(hv.limMin) && sane(hv.limMax)) {
      drawing.header.limMin = hv.limMin;
      drawing.header.limMax = hv.limMax;
    }
    if (hv.insUnits !== undefined) drawing.header.insUnits = hv.insUnits;
    /* The current UCS. A drawing laid out at an angle carries its rotation
       here and nowhere else before R2000, so a consumer that never sees it
       draws the model turned — which is exactly what dropping it did. */
    const sameAsWorld = (u?: HeaderUcs): boolean =>
      !!u && u.origin.x === 0 && u.origin.y === 0 && u.origin.z === 0
      && u.xAxis.x === 1 && u.xAxis.y === 0 && u.xAxis.z === 0
      && u.yAxis.x === 0 && u.yAxis.y === 1 && u.yAxis.z === 0;
    const usable = (u?: HeaderUcs): boolean =>
      !!u && [u.origin, u.xAxis, u.yAxis].every(
        (p2) => [p2.x, p2.y, p2.z].every((q) => Number.isFinite(q) && Math.abs(q) < 1e19));
    if (usable(hv.ucs) && !sameAsWorld(hv.ucs)) drawing.header.ucs = hv.ucs;
    if (usable(hv.pUcs) && !sameAsWorld(hv.pUcs)) drawing.header.pUcs = hv.pUcs;
    if (hv.ltScale && hv.ltScale > 0 && hv.ltScale !== 1) {
      drawing.header.linetypeScale = hv.ltScale;
    }
    /* the point glyph: PDMODE 1 means a POINT draws nothing at all, so a
       consumer that never sees it draws dots the source file does not */
    if (hv.pdMode !== undefined) (drawing.header.vars ??= {}).PDMODE = hv.pdMode;
    if (hv.pdSize !== undefined) (drawing.header.vars ??= {}).PDSIZE = hv.pdSize;
    for (const [k, val] of Object.entries(hv.vars)) {
      (drawing.header.vars ??= {})[k] = val;
    }
  }
  const failures = new Map<string, number>();

  /* Handle -> record. DWG handles are in practice a dense counter, so a
     plain array replaces the Map that was the hottest line of the whole
     read (1.7M inserts with growth rehashing). Records whose body carries
     a handle outside the map's range land in the overflow map; sparse
     handle spaces fall back to a Map outright. */
  const omap = readObjectMap(handlesSection);
  let maxHandle = 0;
  for (let i = 0; i < omap.count; i++) {
    if (omap.handles[i] > maxHandle) maxHandle = omap.handles[i];
  }
  const dense = maxHandle > 0 && maxHandle < omap.count * 8 + 4096;
  const objArr: (RawObject | undefined)[] | null =
    dense ? new Array(maxHandle + 1).fill(undefined) : null;
  const objMap: Map<number, RawObject> | null = dense ? null : new Map();
  const overflow = new Map<number, RawObject>();
  const objects = {
    get(h: number): RawObject | undefined {
      if (objArr) {
        return (h >= 0 && h <= maxHandle) ? objArr[h] : overflow.get(h);
      }
      return objMap!.get(h);
    },
    set(h: number, o: RawObject): void {
      if (objArr) {
        if (h >= 0 && h <= maxHandle) objArr[h] = o;
        else overflow.set(h, o);
      } else objMap!.set(h, o);
    },
  };
  const order: RawObject[] = [];          /* file order matters for chains */
  let crcChecked = 0, crcBad = 0;
  for (let mi = 0; mi < omap.count; mi++) {
    const handle = omap.handles[mi], offset = omap.offsets[mi];
    try {
      if (offset < 0 || offset + 2 > objectSpace.length) throw new RangeError('offset');
      /* MS size prefix, then (R2010+) the handle-stream split as UMC bits */
      let p = offset;
      let size = 0, shift = 0;
      for (;;) {
        const word = objectSpace[p] | (objectSpace[p + 1] << 8);
        p += 2;
        size += (word & 0x7fff) * 2 ** shift;
        if (!(word & 0x8000)) break;
        shift += 15;
      }
      let bitsizeOverride: number | undefined;
      if (v >= 2010) {
        let hs = 0, hshift = 0;
        for (;;) {
          const b = objectSpace[p++];
          hs += (b & 0x7f) * 2 ** hshift;
          if (!(b & 0x80)) break;
          hshift += 7;
        }
        bitsizeOverride = size * 8 - hs;
      }
      const body = objectSpace.subarray(p, p + size);
      if (body.length < size) throw new RangeError('body');
      if (options.checkCrc) {
        /* the CRC covers the size prefix and the body, and follows it */
        const end = p + size;
        if (end + 2 <= objectSpace.length) {
          const stored = objectSpace[end] | (objectSpace[end + 1] << 8);
          const calc = crc16(0xC0C1, objectSpace, offset, end);
          crcChecked++;
          if (calc !== stored) crcBad++;
        }
      }
      const raw = decodeObjectBody(body, ctx, bitsizeOverride);
      if (raw) {
        if (!raw.handle) raw.handle = handle;
        if (options.retainRecords && raw.entity) {
          /* the raw record, byte for byte — a handle-stable rewrite into
             the same encoding generation can emit it verbatim, so an
             untouched entity survives with incremental-save fidelity */
          raw.entity.record = {
            data: toBase64(body.slice()),
            handleBits: v >= 2010 && bitsizeOverride !== undefined
              ? size * 8 - bitsizeOverride : undefined,
            encoding: encodingGroup(v)
          };
        }
        objects.set(raw.handle, raw);
        /* file position, for the vertex sequence fallback — a third
           1.7M-entry Map built just to answer indexOf was pure overhead */
        raw.fileIndex = order.length;
        order.push(raw);
      }
    } catch (err) {
      const key = err instanceof Error ? err.constructor.name : 'Error';
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }

  /* ---- tables ---- */
  const layerName = new Map<number, string>();
  const ltypeName = new Map<number, string>();
  const appidName = new Map<number, string>();
  const dimStyleName = new Map<number, string>();
  const styleName = new Map<number, string>();
  /* style -> its own EED, read once the APPID names are all in */
  const styleEed: { st: TextStyle; xd: XdataGroup[] }[] = [];
  const blockHeaderByHandle = new Map<number, RawObject>();
  let modelSpaceHandle: number | undefined;
  let paperSpaceHandle: number | undefined;
  let ctrlModel = 0;
  let ctrlPaper = 0;

  drawing.layers = [];
  drawing.linetypes = [];
  drawing.textStyles = [];

  for (const raw of order) {
    const t = raw.table;
    if (!t) continue;
    switch (t.kind) {
      case 'layer': {
        const name = t.name || '0';
        layerName.set(raw.handle, name);
        const layer: Layer = {
          name,
          color: t.rgb !== undefined
            ? { kind: 'rgb', rgb: t.rgb }
            : { kind: 'aci', index: Math.abs(t.colorIndex ?? 7) || 7 },
          on: !t.off,
          frozen: !!t.frozen,
          locked: !!t.locked,
          plottable: t.plot,
          lineweight: t.lineweight,
          handle: raw.handle.toString(16).toUpperCase()
        };
        if (t.xrefDependent) layer.xrefDependent = true;
        drawing.layers.push(layer);
        if (t.ltypeHandle) {
          /* patched to a name after ltypes resolve */
          layer.linetype = '#' + t.ltypeHandle.toString(16);
        }
        break;
      }
      case 'ltype':
        ltypeName.set(raw.handle, t.name || 'Continuous');
        drawing.linetypes.push({
          name: t.name || 'Continuous',
          description: t.description,
          pattern: t.pattern ?? [],
          handle: raw.handle.toString(16).toUpperCase(),
          ...(t.xrefDependent ? { xrefDependent: true } : {})
        });
        break;
      case 'style':
        styleName.set(raw.handle, t.name || 'Standard');
        {
          const st: TextStyle = {
            name: t.name || 'Standard',
            font: t.font, bigFont: t.bigFont,
            fixedHeight: t.fixedHeight, widthFactor: t.widthFactor,
            oblique: t.oblique,
            handle: raw.handle.toString(16).toUpperCase()
          };
          if (t.shapeFile) st.shapeFile = true;
          if (t.xrefDependent) st.xrefDependent = true;
          if (t.xdata) styleEed.push({ st, xd: t.xdata });
          drawing.textStyles.push(st);
        }
        break;
      case 'blockHeader':
        blockHeaderByHandle.set(raw.handle, raw);
        /* a name is only a fallback: every layout's record can be spelled
           `*Paper_Space` in the file (the reference's site plans), and the
           last one in file order is not the current layout — the block
           control's pointer is, and it wins below */
        if (!ctrlModel && /^\*model_space$/i.test(t.name ?? '')) modelSpaceHandle = raw.handle;
        if (!ctrlPaper && /^\*paper_space$/i.test(t.name ?? '')) paperSpaceHandle = raw.handle;
        break;
      case 'blockControl':
        if (t.modelSpace) modelSpaceHandle = ctrlModel = t.modelSpace;
        if (t.paperSpace) paperSpaceHandle = ctrlPaper = t.paperSpace;
        break;
      case 'appid':
        if (t.name) appidName.set(raw.handle, t.name);
        break;
      case 'dimstyle':
        if (t.name) dimStyleName.set(raw.handle, t.name);
        break;
      default:
        break;
    }
  }
  /* THE TRUETYPE TYPEFACE. A TTF style keeps its FILE in the font field
     and its FAMILY in the record's ACAD xdata — 1000 is the family and the
     top two bits of the 1071 flag word are italic and bold — and a style
     may leave the file empty and say all of it there. The APPID names are
     known only now, so this is the earliest the group can be identified. */
  for (const { st, xd } of styleEed) {
    for (const g of xd) {
      const app = g.appName
        ?? (g.appHandle ? appidName.get(parseInt(g.appHandle, 16)) : undefined);
      if (app !== 'ACAD') continue;
      for (const val of g.values) {
        if (!('value' in val)) continue;
        if (val.code === 1000 && typeof val.value === 'string' && !st.typeface) {
          st.typeface = val.value;
        }
        if (val.code === 1071 && typeof val.value === 'number') {
          if (val.value & 0x1000000) st.italic = true;
          if (val.value & 0x2000000) st.bold = true;
        }
      }
    }
  }
  if (!drawing.layers.length) drawing.layers = emptyDrawing().layers;
  /* layer linetype handles -> names */
  for (const layer of drawing.layers) {
    if (layer.linetype?.startsWith('#')) {
      const h = parseInt(layer.linetype.slice(1), 16);
      layer.linetype = ltypeName.get(h) ?? undefined;
    }
  }
  if (hv?.clayerHandle) {
    const nm = layerName.get(hv.clayerHandle);
    if (nm) (drawing.header.vars ??= {}).CLAYER = nm;
  }

  /* ---- geographic placement ---- */
  for (const raw of order) {
    if (raw.geoData) { drawing.geoData = raw.geoData; break; }
  }

  /* ---- R2010+ tables: the grid lives in a separate TABLECONTENT ---- */
  const tableContents: RawObject[] = [];
  for (const raw of order) if (raw.tableContent) tableContents.push(raw);
  if (tableContents.length) {
    const byOwner = new Map<number, RawObject>();
    for (const tc of tableContents) {
      if (tc.owner !== undefined) byOwner.set(tc.owner, tc);
    }
    /* the record itself only carries the placement from R2010 on */
    const pending = order.filter((raw) => raw.typeName === 'ACAD_TABLE'
      && (raw.entity?.type !== 'table' || raw.entity.cells.length === 0));
    /* an owner link binds them exactly; matching counts bind by position */
    for (let i = 0; i < pending.length; i++) {
      const raw = pending[i];
      const tc = byOwner.get(raw.handle)
        ?? (pending.length === tableContents.length ? tableContents[i] : undefined);
      if (!tc?.tableContent || !raw.entity) continue;
      const previous = raw.entity;
      raw.entity = {
        type: 'table',
        layer: previous.layer, color: previous.color,
        handle: previous.handle,
        xdata: previous.xdata,
        position: previous.type === 'table'
          ? previous.position : { x: 0, y: 0, z: 0 },
        direction: previous.type === 'table'
          ? previous.direction : { x: 1, y: 0, z: 0 },
        ...tc.tableContent
      };
    }
  }

  /* ---- fold vertices into their polylines and meshes ---- */
  const vertexOwner = new Map<number, RawObject[]>();
  for (const raw of order) {
    if ((raw.vertex || raw.pfaceFace) && raw.owner !== undefined) {
      let list = vertexOwner.get(raw.owner);
      if (!list) vertexOwner.set(raw.owner, list = []);
      list.push(raw);
    }
  }

  const ownedVerts = (
    raw: RawObject, handles: number[]
  ): RawObject[] => {
    if (handles.length) {
      const out: RawObject[] = [];
      for (const h of handles) {
        const vo = objects.get(h);
        if (vo && (vo.vertex || vo.pfaceFace)) out.push(vo);
      }
      if (out.length) return out;
    }
    const byOwner = vertexOwner.get(raw.handle);
    if (byOwner?.length) return byOwner;
    /* Some producers write the vertices with neither owned-handle list nor
       owner back-pointer, leaving only the file order to say what belongs
       to what: take the run that follows, up to the closing SEQEND. */
    const start = raw.fileIndex;
    if (start === undefined) return [];
    const out: RawObject[] = [];
    for (let i = start + 1; i < order.length; i++) {
      const next = order[i];
      if (next.typeName === 'SEQEND') break;
      if (!next.vertex && !next.pfaceFace) break;
      if (next.owner !== undefined && next.owner !== raw.handle) break;
      out.push(next);
    }
    return out;
  };
  /* the header's own common data, decoded before its type was known to
     fold, lands on the entity the folding produced */
  const applyFolded = (e: Entity, raw: RawObject): void => {
    const f = raw.folded;
    if (!f) return;
    e.color = f.color;
    if (f.ltypeScale !== 1) e.linetypeScale = f.ltypeScale;
    if (f.lineweight !== undefined) e.lineweight = f.lineweight;
    if (f.invisible) e.invisible = true;
    if (f.xdata) e.xdata = f.xdata;
  };
  for (const raw of order) {
    if (raw.polyline) {
      const pl = raw.polyline;
      const verts = ownedVerts(raw, pl.vertexHandles).filter((w) => w.vertex);
      /* A spline-fit polyline lists its frame — the vertices the user
         placed, flag 16 — and the fitted curve, flag 8: the curve is what
         the reference draws (the frame only under SPLFRAME), so the curve
         is `vertices` and the frame is kept apart. A curve-fit polyline
         draws every vertex, the inserted ones (flag 1) marked. */
      const frame: PolylineVertex[] = [];
      const drawn: PolylineVertex[] = [];
      for (const w of verts) {
        const vx = w.vertex!;
        const pv: PolylineVertex = { x: vx.x, y: vx.y };
        if (pl.is3d) pv.z = vx.z;
        if (vx.bulge) pv.bulge = vx.bulge;
        if (vx.startWidth) pv.startWidth = vx.startWidth;
        if (vx.endWidth) pv.endWidth = vx.endWidth;
        if (vx.id) pv.id = vx.id;
        if (vx.tangent !== undefined) pv.tangent = vx.tangent;
        const f = vx.flags ?? 0;
        if (f & 1) pv.curveFit = true;
        if (pl.splineFit && (f & 16)) frame.push(pv); else drawn.push(pv);
      }
      const vertices = drawn.length >= 2 ? drawn : [...frame, ...drawn];
      if (vertices.length < 2) continue;
      const ent: PolylineEntity = {
        type: 'polyline',
        layer: '0', color: { kind: 'byLayer' },
        handle: raw.handle.toString(16).toUpperCase(),
        vertices,
        closed: pl.closed,
        heavy: pl.is3d ? '3d' : '2d'
      };
      if (drawn.length >= 2 && frame.length) ent.frame = frame;
      if (pl.splineFit) ent.fit = pl.curveType === 6 ? 'cubic' : 'quadratic';
      else if (pl.curveFit) ent.fit = 'curve';
      if (pl.plineGen) ent.plineGen = true;
      if (pl.elevation) ent.elevation = pl.elevation;
      if (pl.extrusion) ent.extrusion = pl.extrusion;
      applyFolded(ent, raw);
      raw.entity = ent;
    } else if (raw.mesh) {
      const owned = ownedVerts(raw, raw.mesh.vertexHandles);
      const verts = owned.filter((w) => w.vertex);
      if (!verts.length) continue;
      const ent: MeshEntity = {
        type: 'mesh',
        layer: '0', color: { kind: 'byLayer' },
        handle: raw.handle.toString(16).toUpperCase(),
        meshKind: raw.mesh.kind,
        vertices: verts.map((w) => ({
          x: w.vertex!.x, y: w.vertex!.y, z: w.vertex!.z
        }))
      };
      if (raw.mesh.kind === 'grid') {
        ent.mSize = raw.mesh.m;
        ent.nSize = raw.mesh.n;
        if (raw.mesh.closedM) ent.closedM = true;
        if (raw.mesh.closedN) ent.closedN = true;
      } else {
        const faces = owned
          .filter((w) => w.pfaceFace)
          .map((w) => w.pfaceFace!.filter((i) => i !== 0));
        if (faces.length) ent.faces = faces;
      }
      applyFolded(ent, raw);
      raw.entity = ent;
    }
  }

  /* ---- anonymous block names: the file stores every anonymous block as
     its bare stem — every dimension's block is literally "*D", every
     dynamic-block variant "*U" — and AutoCAD assigns the display numbers
     at load time, starting at 1 (*D1, *D2, …; verified against AutoCAD
     2027's own DXFOUT of the same drawing). Keyed by the raw stem, all
     but one definition would vanish and every dimension would draw the
     lone survivor. References are by handle, so numbering every stem
     BEFORE any name resolves keeps definitions and references agreeing,
     and numbering from 1 matches the names AutoCAD shows. */
  {
    /* THE DYNAMIC BLOCK'S TRUE NAME. A dynamic block's definition can be
       stored as an anonymous "*U" record whose real name sits in its EED
       under the AcDbDynamicBlockTrueName APPID (beside the GUID and the
       representation tag); the reference lists such a record under that
       name, not anonymous — verified against its block table of a sheet
       set's title block. The promotion only happens when no record spells
       the name out in full: then the "*U" is a variant of it and stays
       one. */
    const trueNameOf = (xd: XdataGroup[] | undefined): string | undefined => {
      for (const g of xd ?? []) {
        const app = g.appName
          ?? (g.appHandle ? appidName.get(parseInt(g.appHandle, 16)) : undefined);
        if (app?.toLowerCase() !== 'acdbdynamicblocktruename') continue;
        for (const val of g.values) {
          if ('value' in val && val.code === 1000
              && typeof val.value === 'string' && val.value) return val.value;
        }
      }
      return undefined;
    };
    const isStem = (t: { name?: string; anonymous?: boolean }): boolean =>
      t.anonymous === true && /^\*.$/.test(t.name ?? '');
    const fixed = new Set<string>();
    for (const bh of blockHeaderByHandle.values()) {
      const t = bh.table;
      if (t?.name && !isStem(t)) fixed.add(t.name);
    }
    const taken = new Set<string>();
    /* the current paper space keeps the bare *Paper_Space name whatever
       its place in the file: the further layouts are the numbered ones,
       and a writer tells them apart by exactly that (seventeen two-layout
       samples lost a layout's viewports when the other record came first) */
    const currentPaper = paperSpaceHandle !== undefined ? blockHeaderByHandle.get(paperSpaceHandle) : undefined;
    if (currentPaper?.table?.name && /^\*paper_space$/i.test(currentPaper.table.name)) {
      taken.add(currentPaper.table.name);
    }
    for (const bh of blockHeaderByHandle.values()) {
      const t = bh.table;
      if (!t?.name) continue;
      if (bh === currentPaper && taken.has(t.name)) continue;
      const anonStem = isStem(t);
      if (anonStem && t.name === '*U') {
        const trueName = trueNameOf(t.xdata);
        if (trueName && !fixed.has(trueName) && !taken.has(trueName)) {
          t.name = trueName;
          t.anonymous = false;
          taken.add(trueName);
          continue;
        }
      }
      if (!anonStem && !taken.has(t.name)) { taken.add(t.name); continue; }
      let n = anonStem ? 1 : 2;
      while (taken.has(t.name + n)) n++;
      t.name = t.name + n;
      taken.add(t.name);
    }
  }

  /* ---- resolve per-entity properties + place entities ---- */
  const blockContents = new Map<number, Entity[]>();
  const paper: Entity[] = [];
  let orphans = 0;

  for (const raw of order) {
    const e = raw.entity;
    if (!e) continue;
    if (raw.layerHandle !== undefined) {
      e.layer = layerName.get(raw.layerHandle) ?? '0';
    }
    /* the STYLE a text names: TEXT/ATTRIB/ATTDEF and MTEXT each point at a
       style record, and without the name behind that pointer no consumer
       can know which font, width factor or slant the file asked for */
    if (raw.styleHandle !== undefined && (e.type === 'text' || e.type === 'mtext')) {
      const sn = styleName.get(raw.styleHandle);
      if (sn) e.style = sn;
    }
    if (raw.ltypeFlags === 3 && raw.ltypeHandle !== undefined) {
      e.linetype = ltypeName.get(raw.ltypeHandle);
    } else if (raw.ltypeFlags === 2) {
      e.linetype = 'Continuous';
    } else if (raw.ltypeFlags === 1) {
      /* the R2000+ two-bit shortcut: 0 = ByLayer (the default the model
         spells as absence), 1 = ByBlock — AutoCAD's own table-grid block
         lines carry it, verified against its DXFOUT of the same drawing */
      e.linetype = 'ByBlock';
    }
    if (e.type === 'insert' && raw.insert) {
      const bh = blockHeaderByHandle.get(raw.insert.blockHeader);
      e.blockName = bh?.table?.name ?? '';
      const handles = [...raw.insert.attribs];
      if (!handles.length && raw.insert.chain) {
        /* R2000 chain form: walk first -> last via each ATTRIB's next link.
           A damaged file can point the chain back at itself, so a visited
           set ends the walk rather than the guard counter. */
        const walked = new Set<number>();
        let cur: number | undefined = raw.insert.chain.first;
        while (cur && !walked.has(cur)) {
          walked.add(cur);
          handles.push(cur);
          if (cur === raw.insert.chain.last) break;
          cur = objects.get(cur)?.next;
        }
      }
      const attribs = handles
        .map((h) => objects.get(h)?.entity)
        .filter((a): a is Entity => !!a && a.type === 'text');
      if (attribs.length) e.attributes = attribs as never;
    }
    if (e.type === 'unknown' && raw.proxyGraphics) {
      /* an entity we cannot model still draws, through its cached list —
         kept raw as well, so a rewrite emits it byte for byte */
      const shapes = decodeProxyGraphics(raw.proxyGraphics, e.layer, e.color);
      if (shapes.length) e.graphics = shapes;
      e.graphicsData = toBase64(raw.proxyGraphics);
    }
    if (e.type === 'proxy' && raw.proxyGraphics) {
      /* proxies keep both forms: the decoded primitives for drawing, and
         the raw display list so a rewrite emits it byte for byte */
      const shapes = decodeProxyGraphics(raw.proxyGraphics, e.layer, e.color);
      if (shapes.length) e.graphics = shapes;
      e.graphicsData = toBase64(raw.proxyGraphics);
    }
    if (e.type === 'mleader' && raw.mleaderBlock !== undefined) {
      const bh = blockHeaderByHandle.get(raw.mleaderBlock);
      if (bh?.table?.name) e.blockName = bh.table.name;
    }
    if (e.type === 'dimension' && raw.dimBlock !== undefined) {
      const bh = blockHeaderByHandle.get(raw.dimBlock);
      if (bh?.table?.name) e.blockName = bh.table.name;
    }
    if (e.type === 'table' && raw.tableCellBlocks) {
      /* a block-content cell names the block it shows */
      for (const [index, handle] of raw.tableCellBlocks) {
        const name = blockHeaderByHandle.get(handle)?.table?.name;
        const cell = e.cells[index];
        if (name && cell) cell.blockName = name;
      }
    }
    if (e.type === 'dimension' && raw.dimStyleHandle !== undefined) {
      const nm = dimStyleName.get(raw.dimStyleHandle);
      if (nm && !/^standard$/i.test(nm)) e.style = nm;
    }
    if (e.xdata) {
      for (const g of e.xdata) {
        if (!g.appHandle) continue;
        const nm = appidName.get(parseInt(g.appHandle, 16));
        if (nm) { g.appName = nm; delete g.appHandle; }
      }
    }
    if (e.type === 'image' && raw.imageDefHandle !== undefined) {
      const def = objects.get(raw.imageDefHandle);
      if (def?.imageDef?.path) e.path = def.imageDef.path;
    }
    if (e.type === 'underlay' && raw.underlayDefHandle !== undefined) {
      const def = objects.get(raw.underlayDefHandle);
      if (def?.underlayDef) {
        if (def.underlayDef.path) e.path = def.underlayDef.path;
        if (def.underlayDef.itemName) e.itemName = def.underlayDef.itemName;
      }
    }

    if (raw.entmode === 2 || raw.owner === modelSpaceHandle) {
      drawing.entities.push(e);
    } else if (raw.entmode === 1 || raw.owner === paperSpaceHandle) {
      paper.push(e);
    } else if (raw.entmode === 0 && raw.owner !== undefined) {
      const ownerObj = objects.get(raw.owner);
      if (ownerObj?.table?.kind === 'blockHeader') {
        let list = blockContents.get(raw.owner);
        if (!list) blockContents.set(raw.owner, list = []);
        list.push(e);
      } else if (!ownerObj) {
        /* The owner handle resolves to nothing at all — a purged block
           record. Dropping the entity loses real geometry (44 MTEXT and
           POINT records in one surveyed field file), so it lands in model
           space and the drawing says so once. An owner that does exist
           but is not a block header is a vertex/attrib already folded
           into its parent above, and stays where it is. */
        orphans++;
        drawing.entities.push(e);
      }
    }
  }
  if (orphans) {
    drawing.warnings.push(
      `${orphans} entities reference a missing owner and were placed in `
      + 'model space');
  }
  if (paper.length) drawing.paperSpace = paper;

  /* ---- blocks ---- */
  for (const [handle, bhRaw] of blockHeaderByHandle) {
    const t = bhRaw.table!;
    const name = t.name ?? '';
    if (handle === modelSpaceHandle || handle === paperSpaceHandle) continue;
    let entities = blockContents.get(handle) ?? [];
    if (!entities.length && t.ownedHandles?.length) {
      entities = t.ownedHandles
        .map((h) => objects.get(h)?.entity)
        .filter((q): q is Entity => !!q);
    }
    /* Every extra paper-space layout is its own BLOCK_HEADER, all of them
       literally named *Paper_Space (the rename loop above numbers the
       duplicates). Only the one paperSpaceHandle feeds drawing.paperSpace,
       so dropping the rest threw away real geometry — 392 entities across
       46 files of the real-world corpus, including whole sheet layouts.
       They stay as blocks now: nothing is invented, nothing is lost, and
       a block is only drawn where something INSERTs it. An empty one is
       still noise worth skipping. */
    if (/^\*(model_space|paper_space)/i.test(name) && !entities.length) continue;
    const def: BlockDefinition = {
      name,
      basePoint: t.basePoint ?? { x: 0, y: 0, z: 0 },
      entities,
      handle: handle.toString(16).toUpperCase()
    };
    if (t.xrefPath !== undefined) def.xref = { path: t.xrefPath, ...(t.xrefOverlay ? { overlay: true } : {}) };
    drawing.blocks[name] = def;
  }

  /* ---- draw order: SORTENTSTABLE. Each table governs one space's (or
     block's) entity list; entry i pairs an entity with its sort key, the
     list reorders by ascending key, and an entity no entry names sorts
     under its own handle. The reorder is in place, so the array a
     consumer draws IS the draw order — the object itself is consumed
     here, never sealed and never re-emitted stale. ---- */
  /* the reference numbers a layout's viewports in file order (1 = the
     paper itself); the draw order applied below may move them, so the
     number is taken here, before it does */
  {
    const number = (list: Entity[]): void => {
      let n = 0;
      for (const e of list) if (e.type === 'viewport') e.id = ++n;
    };
    number(drawing.paperSpace ?? []);
    for (const [nm, b] of Object.entries(drawing.blocks)) {
      if (/^\*paper_space/i.test(nm)) number(b.entities);
    }
  }
  for (const raw of order) {
    const se = raw.sortents;
    if (!se || !se.ents.length) continue;
    let list: Entity[] | undefined;
    if (se.blockOwner === modelSpaceHandle) list = drawing.entities;
    else if (se.blockOwner === paperSpaceHandle) list = drawing.paperSpace;
    else {
      const nm = blockHeaderByHandle.get(se.blockOwner)?.table?.name;
      list = nm !== undefined ? drawing.blocks[nm]?.entities : undefined;
    }
    if (!list || list.length < 2) continue;
    const key = new Map<number, number>();
    for (let i = 0; i < se.ents.length; i++) key.set(se.ents[i], se.sorts[i]);
    const keyed = list.map((e, i) => {
      const h = e.handle ? parseInt(e.handle, 16) : NaN;
      return { e, i, k: key.get(h) ?? (Number.isFinite(h) ? h : i) };
    });
    keyed.sort((a, b) => (a.k - b.k) || (a.i - b.i));
    for (let i = 0; i < keyed.length; i++) list[i] = keyed[i].e;
  }

  /* ---- dynamic blocks: parameters and actions bind to the block their
     owner chain climbs to (parameter -> evaluation graph -> extension
     dictionary -> block header). ---- */
  const blockOfChain = (start: number | undefined): string | undefined => {
    let h = start;
    for (let hops = 0; hops < 6 && h !== undefined; hops++) {
      const bh = blockHeaderByHandle.get(h);
      if (bh?.table?.name) return bh.table.name;
      h = objects.get(h)?.owner;
    }
    return undefined;
  };
  for (const raw of order) {
    if (!raw.blockParam && !raw.blockAction) continue;
    const def = drawing.blocks[blockOfChain(raw.owner) ?? ''];
    if (!def) continue;
    def.isDynamic = true;
    if (raw.blockParam) (def.parameters ??= []).push(raw.blockParam);
    if (raw.blockAction && !(def.actions ?? []).includes(raw.blockAction)) {
      (def.actions ??= []).push(raw.blockAction);
    }
  }

  /* ---- dynamic blocks: the visibility parameter says what each state
     shows. The parameter names entities, so the block that owns them is
     the block the parameter belongs to. ---- */
  for (const raw of order) {
    const vis = raw.visibility;
    if (!vis) continue;
    const ownerOf = (h: number): string | undefined => {
      const owner = objects.get(h)?.owner;
      return owner === undefined
        ? undefined : blockHeaderByHandle.get(owner)?.table?.name;
    };
    let blockName: string | undefined;
    for (const h of vis.members) {
      blockName = ownerOf(h);
      if (blockName) break;
    }
    const def = blockName ? drawing.blocks[blockName] : undefined;
    if (!def) continue;
    const hex = (h: number): string => h.toString(16).toUpperCase();
    def.isDynamic = true;
    if (vis.name) def.visibilityName = vis.name;
    if (vis.prompt) def.visibilityPrompt = vis.prompt;
    if (vis.states.length) {
      def.visibilityStates = vis.states.map((st) => ({
        name: st.name, visible: st.visible.map(hex)
      }));
    }
  }

  /* ---- R2013+: bind the AcDs kernel blobs to their ACIS entities ---- */
  if (acdsSection) {
    const blobs = readAcDsSabBlobs(acdsSection);
    if (blobs.length) {
      const waiting = order
        .filter((raw) => raw.hasDsData && raw.entity?.type === 'acis')
        .map((raw) => raw.entity as Extract<Entity, { type: 'acis' }>);
      waiting.forEach((e, i) => { if (blobs[i]) e.sab = blobs[i]; });
      if (waiting.length && blobs.length !== waiting.length) {
        drawing.warnings.push(
          `${blobs.length} solid-modeling payloads for ${waiting.length} solids.`);
      }
    }
  }

  /* ---- named objects: layouts, groups, mline styles, ucs/views/vports ---- */
  /* answered from the objects map — building a second 1.7M-entry Map for
     three lookups cost more than every lookup it ever served */
  const entityByHandle = {
    has: (h: number) => !!objects.get(h)?.entity,
    get: (h: number) => objects.get(h)?.entity,
  };
  const blockNameOf = (h?: number): string | undefined =>
    h === undefined ? undefined : blockHeaderByHandle.get(h)?.table?.name;

  /* dictionary entry names, so xrecords can be reported by name */
  const dictNameOf = new Map<number, string>();
  for (const raw of order) {
    if (!raw.dictionary) continue;
    raw.dictionary.handles.forEach((h, i) => {
      const nm = raw.dictionary!.names[i];
      if (nm && !dictNameOf.has(h)) dictNameOf.set(h, nm);
    });
  }

  for (const raw of order) {
    if (raw.xrecord && raw.xrecord.values.length) {
      (drawing.xrecords ??= []).push({
        handle: raw.handle.toString(16).toUpperCase(),
        name: dictNameOf.get(raw.handle),
        values: raw.xrecord.values
      });
    }
    /* an object's EED names its APPID by handle; the reader is where
       the names are known */
    const nameApps = (xd?: XdataGroup[]): void => {
      for (const g of xd ?? []) {
        if (!g.appHandle) continue;
        const nm = appidName.get(parseInt(g.appHandle, 16));
        if (nm) { g.appName = nm; delete g.appHandle; }
      }
    };
    if (raw.proxyObject) {
      nameApps(raw.proxyObject.xdata);
      (drawing.proxyObjects ??= []).push({
        handle: raw.handle.toString(16).toUpperCase(),
        name: dictNameOf.get(raw.handle),
        ownerHandle: raw.owner?.toString(16).toUpperCase(),
        ...raw.proxyObject
      });
    }
    if (raw.unknownObject) {
      nameApps(raw.unknownObject.xdata);
      (drawing.unknownObjects ??= []).push({
        handle: raw.handle.toString(16).toUpperCase(),
        name: dictNameOf.get(raw.handle),
        ownerHandle: raw.owner?.toString(16).toUpperCase(),
        ...raw.unknownObject
      });
    }
    if (raw.layout) {
      const l = raw.layout;
      (drawing.layouts ??= []).push({
        name: l.name,
        tabOrder: l.tabOrder,
        blockName: blockNameOf(l.blockHandle),
        limMin: l.limMin, limMax: l.limMax,
        extMin: l.extMin, extMax: l.extMax, insBase: l.insBase,
        paperSize: l.paperSize, plotStyleSheet: l.plotStyleSheet
      });
    }
    if (raw.group) {
      (drawing.groups ??= []).push({
        /* the group's name is its ACAD_GROUP dictionary key; the record
           itself only carries the description */
        name: dictNameOf.get(raw.handle) ?? raw.group.name,
        description: raw.group.description,
        selectable: raw.group.selectable,
        entityHandles: raw.group.members
          .filter((h) => entityByHandle.has(h))
          .map((h) => h.toString(16).toUpperCase())
      });
    }
    if (raw.mlineStyle) {
      const ms = raw.mlineStyle;
      (drawing.mlineStyles ??= []).push({
        name: ms.name, description: ms.description, flags: ms.flags,
        fillColor: ms.fillColor,
        startAngle: ms.startAngle, endAngle: ms.endAngle,
        elements: ms.elements.map((el) => ({
          offset: el.offset, color: el.color,
          linetype: el.ltypeHandle ? ltypeName.get(el.ltypeHandle) : undefined
        }))
      });
    }
    if (raw.ucs) (drawing.ucs ??= []).push(raw.ucs);
    if (raw.view) (drawing.views ??= []).push(raw.view);
    if (raw.vport) (drawing.vports ??= []).push(raw.vport);
    if (raw.table?.kind === 'appid' && raw.table.name) {
      (drawing.appIds ??= []).push(raw.table.name);
    }
    if (raw.table?.kind === 'dimstyle' && raw.table.name) {
      (drawing.dimStyles ??= []).push({ name: raw.table.name });
    }
  }
  if (drawing.layouts) {
    drawing.layouts.sort((a, b) => (a.tabOrder ?? 0) - (b.tabOrder ?? 0));
  }

  /* Before R2004 the summary properties live in the DWGPROPS xrecord;
     surface them the same way as the later SummaryInfo section. */
  if (!drawing.header.summary) {
    const props = drawing.xrecords?.find((x) => x.name === 'DWGPROPS');
    if (props) {
      const str = (code: number): string | undefined => {
        const v = props.values.find((q) => q.code === code && 'value' in q);
        const s = v && 'value' in v ? String(v.value) : '';
        return s || undefined;
      };
      const summary = {
        title: str(2), subject: str(3), author: str(4), keywords: str(6),
        comments: str(7), lastSavedBy: str(8), revisionNumber: str(9)
      };
      /* custom properties come as paired 300+/1 groups */
      const custom: { tag: string; value: string }[] = [];
      const tags = props.values.filter((q) => q.code >= 300 && q.code <= 309 && 'value' in q);
      for (const t of tags) {
        const tag = 'value' in t ? String(t.value) : '';
        if (tag && tag !== '=') custom.push({ tag, value: '' });
      }
      if (Object.values(summary).some(Boolean) || custom.length) {
        drawing.header.summary = {
          ...summary,
          ...(custom.length ? { custom } : {})
        };
      }
    }
  }

  /* ---- warnings ---- */
  if (options.checkCrc && crcChecked) {
    if (crcBad) {
      drawing.warnings.push(
        `${crcBad} of ${crcChecked} object CRCs did not match (file may be damaged).`);
    }
  }
  for (const [kind, count] of failures) {
    drawing.warnings.push(
      `${count} object${count === 1 ? '' : 's'} could not be decoded (${kind}).`);
  }
  const unknowns = new Map<string, number>();
  const countUnknown = (list: Entity[]) => {
    for (const e of list) {
      /* a SEALED unknown is fully preserved — payload, references and
         display list — so it is not worth a warning; only an unknown
         with nothing retained is a genuine loss of fidelity */
      if (e.type === 'unknown' && !e.data && !e.graphicsData) {
        unknowns.set(e.sourceType, (unknowns.get(e.sourceType) ?? 0) + 1);
      }
    }
  };
  countUnknown(drawing.entities);
  if (drawing.paperSpace) countUnknown(drawing.paperSpace);
  for (const [name, count] of unknowns) {
    drawing.warnings.push(
      `${count} ${name} entit${count === 1 ? 'y' : 'ies'} kept without geometry (not modeled yet).`);
  }
  return drawing;
};
