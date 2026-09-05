/* nasjidwg — DWG object decoding (R2000 through R2018).
 *
 * Every DWG object is one bit-packed record: common data, type-specific
 * data, then a handle stream that starts at bit `bitsize`. R2007+ adds a
 * backwards-located string stream inside the data area, so a decoder here
 * always juggles up to three cursors over the same bytes:
 *
 *   r        data stream (geometry, flags)
 *   hr       handle stream (layer, owner, block refs...)
 *   sr       string stream (R2007+ text; earlier versions read text inline)
 *
 * Order only matters *within* each stream, which is why common handles can
 * be consumed before type-specific data is read.
 */

import { BitReader, decodeCodepage, resolveHandle } from './bitstream.js';
import { versionRank } from './fileheader.js';
import { decodeCadText } from '../text/escapes.js';
import type {
  AcisEntity, BlockParameter, Color, DimensionEntity, DimensionKind, Entity,
  Face3DEntity,
  FileVersion, GeoData, HatchBoundary, HatchDefLine, HatchEdge, HatchGradient,
  HatchLoopFlags,
  MeshEntity, MLeaderAttribute, MLeaderStyle, MLineVertex, Point2, Point3,
  PolylineVertex,
  ProxyObject, TableBorder, TableCell, TableStyle, TableStyleCell,
  TextHAlign, TextVAlign, UnknownObject, View, ViewportEntity, VPort, XdataGroup,
  XdataValue
} from '../core/model.js';
import type { DwgClassInfo } from './classes.js';
/* The structural member types, checked once per record — a regex test per
 * 1.7M records showed up in profiles. */
/** Objects decoded into the model AND retained sealed: the members of an
 *  ownership chain the writers re-attach under the original owner rather
 *  than re-create — extension dictionaries with the XRECORDs they list,
 *  and the nodes of a dynamic block's evaluation graph. */
const DUAL_SEALED = new Set([
  'DICTIONARY', 'ACDBDICTIONARYWDFLT', 'XRECORD', 'DICTIONARYVAR',
  'BLOCKVISIBILITYPARAMETER',
  'BLOCKLINEARPARAMETER', 'BLOCKROTATIONPARAMETER', 'BLOCKFLIPPARAMETER',
  'BLOCKALIGNMENTPARAMETER', 'BLOCKBASEPOINTPARAMETER', 'BLOCKXYPARAMETER',
  'BLOCKPOLARPARAMETER', 'BLOCKPOINTPARAMETER', 'BLOCKLOOKUPPARAMETER',
  'BLOCKMOVEACTION', 'BLOCKROTATEACTION', 'BLOCKSCALEACTION',
  'BLOCKSTRETCHACTION', 'BLOCKPOLARSTRETCHACTION', 'BLOCKFLIPACTION',
  'BLOCKARRAYACTION', 'BLOCKLOOKUPACTION'
]);

const STRUCTURAL_TYPES = new Set([
  'POLYLINE_2D', 'POLYLINE_3D', 'BLOCK', 'ENDBLK', 'SEQEND']);

/** Fixed-type objects with no decoder that are retained sealed all the
 *  same: the ACDBPLACEHOLDER (type 80) is an empty body the plot style
 *  name dictionary names as its default — without it that dictionary
 *  cannot be written back (its default would dangle). */
const SEAL_FIXED = new Set(['ACDBPLACEHOLDER']);

/* Colour singletons. A million-entity drawing builds a Color object per
 * entity; ByLayer alone accounted for most of them, and none is ever
 * mutated (consumers clone before editing), so every entity shares one
 * frozen instance per value. */
const BY_LAYER: Color = Object.freeze({ kind: 'byLayer' } as Color);
const BY_BLOCK: Color = Object.freeze({ kind: 'byBlock' } as Color);
const ACI_COLORS: readonly Color[] = Object.freeze(
  Array.from({ length: 256 }, (_, i) =>
    Object.freeze({ kind: 'aci', index: i } as Color)));


export interface DecodeContext {
  version: FileVersion;
  v: number;                              /* versionRank(version) */
  codepage?: string;
  classes: Map<number, DwgClassInfo>;
  /** Raw acad release byte at file offset 0x11 (0x1a = R2006). */
  dwgVerByte?: number;
}

export const makeContext = (
  version: FileVersion, classes: Map<number, DwgClassInfo>, codepage?: string,
  dwgVerByte?: number
): DecodeContext => ({
  version, v: versionRank(version), codepage, classes, dwgVerByte
});

/** Base64 for retained binary payloads (browser-safe, no Buffer). */
export const toBase64 = (bytes: Uint8Array): string => {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += CH[a >> 2] + CH[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (i + 1 < bytes.length ? CH[(((b ?? 0) & 15) << 2) | ((c ?? 0) >> 6)] : '=')
      + (i + 2 < bytes.length ? CH[(c ?? 0) & 63] : '=');
  }
  return out;
};

/* ------------------------------------------------------------------ *
 * Raw decoded object: the model entity plus the relations the reader
 * needs to assemble a Drawing (all as absolute handles).
 * ------------------------------------------------------------------ */

export interface TableRecord {
  kind: 'layer' | 'ltype' | 'style' | 'blockHeader'
      | 'blockControl' | 'tableControl' | 'appid' | 'dimstyle'
      | 'ucs' | 'view' | 'vport';
  name?: string;
  /** The record belongs to an attached external reference. */
  xrefDependent?: boolean;
  /* layer */
  colorIndex?: number;
  rgb?: number;
  frozen?: boolean;
  off?: boolean;
  locked?: boolean;
  plot?: boolean;
  lineweight?: number;
  ltypeHandle?: number;
  /* ltype */
  description?: string;
  pattern?: number[];
  /* style */
  shapeFile?: boolean;
  font?: string;
  bigFont?: string;
  fixedHeight?: number;
  widthFactor?: number;
  oblique?: number;
  /** STYLE only: the record's own EED, where a TrueType style keeps its
   *  typeface. Resolved to a name by the reader, which is the first place
   *  that knows which APPID each group belongs to. */
  xdata?: XdataGroup[];
  /* block header */
  basePoint?: Point3;
  anonymous?: boolean;
  /** An external reference's record: the attached file and whether the
   *  attachment is an overlay. */
  xrefPath?: string;
  xrefOverlay?: boolean;
  firstEntity?: number;
  lastEntity?: number;
  ownedHandles?: number[];
  /* block control */
  modelSpace?: number;
  paperSpace?: number;
}

/** One cell style of a TABLESTYLE record, its text style and border
 *  linetypes still as handles (the assembler names them). */
export interface RawTableStyleCell extends Omit<TableStyleCell, 'textStyle' | 'borders'> {
  textStyleHandle?: number;
  borders?: { lineweight?: number; visible?: boolean; color?: Color; ltypeHandle?: number }[];
}

/** TABLESTYLE record payload: everything but the dictionary name. */
export interface RawTableStyle extends Omit<TableStyle, 'name' | 'handle' | 'data' | 'title' | 'header' | 'xdata'> {
  data?: RawTableStyleCell;
  title?: RawTableStyleCell;
  header?: RawTableStyleCell;
}

/** MLEADERSTYLE record payload, its four references still as handles. */
export interface RawMLeaderStyle extends Omit<MLeaderStyle,
  'name' | 'handle' | 'linetype' | 'arrowBlock' | 'textStyle' | 'blockName' | 'xdata'> {
  ltypeHandle?: number;
  arrowHandle?: number;
  textStyleHandle?: number;
  blockHandle?: number;
}

export interface RawObject {
  handle: number;
  typeName: string;
  isEntity: boolean;
  /** Position in file order, stamped by the reader's main loop (the vertex
   *  sequence fallback needs it; a Map built for it was pure overhead). */
  fileIndex?: number;
  entity?: Entity;
  /* common entity relations */
  entmode?: number;                       /* 0 owner block, 1 paper, 2 model */
  owner?: number;
  /** The record's extension dictionary, when it has one. */
  xdict?: number;
  /** Persistent reactors (objects only; entity reactors are rebuilt). */
  reactors?: number[];
  layerHandle?: number;
  ltypeFlags?: number;
  ltypeHandle?: number;
  /** TEXT/ATTRIB/ATTDEF/MTEXT: the STYLE record the object is drawn with. */
  styleHandle?: number;
  prev?: number;
  next?: number;
  /* per-type extras used by the assembler */
  insert?: {
    blockHeader: number; attribs: number[]; hasAttribs: boolean;
    /** R2000 chain form: first/last ATTRIB handles (walk via .next). */
    chain?: { first: number; last: number };
  };
  polyline?: {
    is3d: boolean; closed: boolean; vertexHandles: number[];
    first?: number; last?: number;
    /** The header's 70 bits 2/4/128 and its 75 curve type. */
    curveFit?: boolean; splineFit?: boolean; plineGen?: boolean;
    curveType?: number;
    /** 2D only: elevation and OCS normal of the header. */
    elevation?: number; extrusion?: Point3;
  };
  /** VERTEX_2D/3D payload; `flags` is the record's own 70 byte. */
  vertex?: PolylineVertex & { z: number; flags?: number };
  /** The common entity data of a record that folds into another entity
   *  (a heavy polyline's header, a mesh): decoded before the type-specific
   *  part, applied by the assembler once the folded entity exists. */
  folded?: {
    color: Color; ltypeScale: number; lineweight?: number;
    invisible: boolean; xdata?: XdataGroup[];
  };
  blockName?: string;                     /* BLOCK entity */
  table?: TableRecord;
  /** DIMENSION_*: handle of the anonymous geometry block. */
  dimBlock?: number;
  /** PolylineMesh / PolylinePFace awaiting vertex folding. */
  mesh?: {
    kind: 'grid' | 'faces';
    m?: number; n?: number; closedM?: boolean; closedN?: boolean;
    vertexHandles: number[];
  };
  /** PFaceFace: up to 4 signed 1-based vertex indices. */
  pfaceFace?: number[];
  /** IMAGE/WIPEOUT: IMAGEDEF handle to resolve into a file path. */
  imageDefHandle?: number;
  /** IMAGEDEF object payload. */
  imageDef?: { path?: string };
  /** DIMENSION_*: DIMSTYLE handle, resolved to a name by the assembler. */
  dimStyleHandle?: number;
  /** DICTIONARY: entry names paired with their target handles, the
   *  reference code each entry used, and the record's two flags. */
  dictionary?: {
    names: string[]; handles: number[]; codes: number[];
    cloning?: number; hardOwner?: boolean;
    /** ACDBDICTIONARYWDFLT: the default record's handle. */
    defaultHandle?: number;
  };
  /** ACAD_PROXY_OBJECT (0x1F3): the retained record, named by the
   *  assembler from its owning dictionary. */
  proxyObject?: Omit<ProxyObject, 'handle' | 'name'>;
  /** Any other object the semantic layer could not model: retained sealed
   *  (universal passthrough), named by the assembler when a dictionary
   *  lists it. */
  unknownObject?: Omit<UnknownObject, 'handle' | 'name'>;
  /** LAYOUT object payload (block handle resolved by the assembler). */
  layout?: {
    name: string; tabOrder?: number; blockHandle?: number;
    limMin?: Point2; limMax?: Point2; extMin?: Point3; extMax?: Point3;
    insBase?: Point3; paperSize?: string; plotStyleSheet?: string;
  };
  /** GROUP object payload. */
  group?: { name: string; description?: string; selectable?: boolean; members: number[] };
  /** MLINESTYLE object payload. Each element's linetype is a handle
   *  from R2018 and a table index before (32767 BYLAYER, 32766 BYBLOCK,
   *  else the record's position in the linetype table's list). */
  mlineStyle?: {
    name: string; description?: string; flags?: number; fillColor?: Color;
    startAngle?: number; endAngle?: number;
    elements: { offset: number; color: Color; ltypeHandle?: number; ltypeIndex?: number }[];
  };
  /** MLINE: the MLINESTYLE record the entity is drawn with. */
  mlineStyleHandle?: number;
  /** DICTIONARYVAR object payload: the schema byte and the value text. */
  dictionaryVar?: { schema: number; value: string };
  /** UCS / VIEW / VPORT table payloads. */
  ucs?: {
    name: string; origin: Point3; xAxis: Point3; yAxis: Point3;
    elevation?: number; orthoViewType?: number;
    orthoOrigins?: { type: number; origin: Point3 }[];
    baseUcsHandle?: number;
  };
  view?: View;
  vport?: {
    name: string; lowerLeft: Point2; upperRight: Point2; center: Point2;
    height: number; aspectRatio?: number; direction?: Point3; target?: Point3;
    snapBase?: Point2; gridSpacing?: Point2;
  };
  /** Extended data parsed from the record's EED chunks. */
  xdata?: XdataGroup[];
  /** XRECORD payload (typed group values). */
  xrecord?: { values: XdataValue[] };
  /** SORTENTSTABLE payload: entry i pairs ents[i] with sort key sorts[i];
   *  the assembler reorders blockOwner's entity list by ascending key. */
  sortents?: { blockOwner: number; ents: number[]; sorts: number[] };
  /** R2013+: heavy data lives in the AcDs section, not in the record. */
  hasDsData?: boolean;
  /** MULTILEADER: block content + style handles. */
  mleaderBlock?: number;
  mleaderStyle?: number;
  /** ACAD_TABLE: the block record holding its rendered geometry. */
  tableBlock?: number;
  tableStyle?: number;
  tableContent?: TableGrid;
  /** TABLESTYLE / MLEADERSTYLE object payloads, named by the assembler
   *  from the ACAD_TABLESTYLE / ACAD_MLEADERSTYLE dictionaries. */
  tableStyleObj?: RawTableStyle;
  mleaderStyleObj?: RawMLeaderStyle;
  /** ACAD_TABLE: block record handle per block-content cell, by cell
   *  index (the assembler resolves the names). */
  tableCellBlocks?: Map<number, number>;
  /** ACAD_TABLE: text-style handle per cell that overrides its style,
   *  by cell index (the assembler resolves the names). */
  tableCellTextStyles?: Map<number, number>;
  /** ATTDEF: the definition's tag, for the labels that name it by
   *  handle (multileader block labels, table block cells). */
  attTag?: string;
  /** GEODATA payload. */
  geoData?: GeoData;
  /** PDF/DGN/DWF UNDERLAY: definition handle to resolve into a path. */
  underlayDefHandle?: number;
  /** PDF/DGN/DWF DEFINITION object payload. */
  underlayDef?: { path: string; itemName: string };
  /** A dynamic block's visibility parameter, before it is bound. */
  visibility?: {
    name: string; prompt: string;
    members: number[];
    states: { name: string; visible: number[] }[];
  };
  /** Any other dynamic-block parameter, before it is bound. */
  blockParam?: BlockParameter;
  /** A dynamic-block action; the class itself names the kind. */
  blockAction?: string;
  /** Raw cached display list, decoded by the assembler. */
  proxyGraphics?: Uint8Array;
}

/* ------------------------------------------------------------------ *
 * type numbers
 * ------------------------------------------------------------------ */

const FIXED_TYPES: Record<number, string> = {
  1: 'TEXT', 2: 'ATTRIB', 3: 'ATTDEF', 4: 'BLOCK', 5: 'ENDBLK', 6: 'SEQEND',
  7: 'INSERT', 8: 'MINSERT', 10: 'Vertex2d', 11: 'Vertex3d',
  12: 'VertexMesh', 13: 'VertexPFace', 14: 'PFaceFace',
  15: 'Polyline2d', 16: 'Polyline3d', 17: 'ARC', 18: 'CIRCLE', 19: 'LINE',
  20: 'DimOrdinate', 21: 'DimRotated', 22: 'DimAligned',
  23: 'DimAngular3Point', 24: 'DimAngular2Line', 25: 'DimRadius',
  26: 'DimDiameter', 27: 'POINT', 28: '3DFACE', 29: 'PolylinePFace',
  30: 'PolylineMesh', 31: 'SOLID', 32: 'TRACE', 33: 'SHAPE', 34: 'VIEWPORT',
  35: 'ELLIPSE', 36: 'SPLINE', 37: 'REGION', 38: '3DSOLID', 39: 'BODY',
  40: 'RAY', 41: 'XLINE', 42: 'DICTIONARY', 43: 'OLEFRAME', 44: 'MTEXT',
  45: 'LEADER', 46: 'TOLERANCE', 47: 'MLINE', 48: 'BlockTable',
  49: 'BlockRecord', 50: 'LayerTable', 51: 'LAYER', 52: 'TextStyleTable',
  53: 'STYLE', 56: 'LinetypeTable', 57: 'LTYPE', 60: 'ViewTable',
  61: 'VIEW', 62: 'UcsTable', 63: 'UCS', 64: 'VPortTable', 65: 'VPORT',
  66: 'AppIdTable', 67: 'APPID', 68: 'DimStyleTable', 69: 'DIMSTYLE',
  70: 'VxTable', 71: 'VX', 72: 'GROUP', 73: 'MLINESTYLE', 74: 'OLE2FRAME',
  77: 'LWPOLYLINE', 78: 'HATCH', 79: 'XRECORD', 80: 'ACDBPLACEHOLDER',
  81: 'VBA_PROJECT', 82: 'LAYOUT',
  /* the two fixed proxy types (R13 called them zombies) */
  0x1f2: 'ACAD_PROXY_ENTITY', 0x1f3: 'ACAD_PROXY_OBJECT'
};

const ENTITY_TYPE = (t: number): boolean =>
  (t >= 1 && t <= 47 && t !== 42 && t !== 43) || t === 74 || t === 77
  || t === 78 || t === 0x1f2;

const CONTROL_TYPES = new Set([48, 50, 52, 56, 60, 62, 64, 66, 68, 70]);

/** Value kind carried by a DXF group code inside XRECORD/XDATA resbufs. */
type ResbufKind =
  | 'string' | 'real' | 'point' | 'int8' | 'int16' | 'int32' | 'int64'
  | 'bool' | 'binary' | 'handle' | 'invalid';

export const resbufKind = (gc: number): ResbufKind => {
  if (gc < 0) return 'handle';
  /* 5 (and 105) is a handle spelled as TEXT in an XRECORD — a counted
     string like any other, not an object id: the reference's own
     data-extraction records carry a code-5 group of length 0 right
     before the run ends, and read as an 8-byte id it overran the record
     and lost the record to the seal */
  if (gc <= 9) return 'string';
  if (gc <= 37) return 'point';
  if (gc <= 59) return 'real';
  if (gc <= 79) return 'int16';
  if (gc <= 99) return 'int32';
  if (gc <= 102) return 'string';
  if (gc === 105) return 'string';
  if (gc <= 109) return 'invalid';
  if (gc <= 139) return 'point';
  if (gc <= 149) return 'real';
  if (gc <= 169) return 'int64';
  if (gc <= 179) return 'int16';
  if (gc <= 209) return 'invalid';
  if (gc <= 269) return 'point';
  if (gc <= 279) return 'int16';
  if (gc <= 289) return 'int8';
  if (gc <= 299) return 'bool';
  if (gc <= 309) return 'string';
  if (gc <= 319) return 'binary';
  if (gc <= 329) return 'handle';
  if (gc <= 369) return 'handle';         /* object ids */
  if (gc <= 389) return 'int16';
  if (gc <= 399) return 'handle';
  if (gc <= 409) return 'int16';
  if (gc <= 419) return 'string';
  if (gc <= 429) return 'int32';
  if (gc <= 439) return 'string';
  if (gc <= 459) return 'int32';
  if (gc <= 469) return 'real';
  if (gc <= 479) return 'string';
  if (gc === 999) return 'string';
  if (gc < 1000) return 'invalid';
  if (gc === 1004) return 'binary';
  if (gc <= 1009) return 'string';
  if (gc <= 1039) return 'point';
  if (gc <= 1042) return 'real';
  if (gc <= 1069) return 'point';
  if (gc <= 1070) return 'int16';
  if (gc === 1071) return 'int32';
  return 'invalid';
};

/** DWG lineweight code -> millimeters (undefined = ByLayer/ByBlock/default). */
const LW_MM = [
  0.00, 0.05, 0.09, 0.13, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50,
  0.53, 0.60, 0.70, 0.80, 0.90, 1.00, 1.06, 1.20, 1.40, 1.58, 2.00, 2.11
];
const lwToMm = (code: number): number | undefined =>
  code >= 0 && code < 24 ? LW_MM[code] : undefined;

/* ------------------------------------------------------------------ *
 * shared low-level pieces
 * ------------------------------------------------------------------ */

/** Parse EED (extended entity data) chunks into XDATA groups. The DWG
 *  record codes map onto the DXF 1000-range as code+1000 (0→1000 string,
 *  2→1002 brace, 4→1004 binary, 5→1005 handle, 10..13→101x points,
 *  40..42→104x reals, 70→1070, 71→1071). */
const parseEed = (r: BitReader, c: DecodeContext): XdataGroup[] | undefined => {
  const groups: XdataGroup[] = [];
  for (;;) {
    const size = r.bs();
    if (size <= 0) break;
    const app = r.h();
    const bytes = r.bytes(size);
    const g: XdataGroup = {
      appHandle: app.value.toString(16).toUpperCase(),
      values: []
    };
    try {
      const er = new BitReader(bytes);
      while (er.pos + 8 <= bytes.length * 8) {
        const code = er.rc();
        if (code === 0) {
          if (c.v >= 2007) {
            const len = er.rs();
            let s = '';
            for (let i = 0; i < len; i++) s += String.fromCharCode(er.rs());
            g.values.push({ code: 1000, value: s });
          } else {
            const len = er.rc();
            er.rs();                        /* codepage of the string */
            g.values.push({
              code: 1000,
              value: decodeCodepage(er.bytes(len), c.codepage)
            });
          }
        } else if (code === 2) {
          g.values.push({ code: 1002, value: er.rc() ? '}' : '{' });
        } else if (code === 3 || code === 5) {
          let v = 0;
          for (let i = 0; i < 8; i++) v = v * 256 + er.rc();
          g.values.push({
            code: code === 3 ? 1003 : 1005,
            value: v.toString(16).toUpperCase()
          });
        } else if (code === 4) {
          const len = er.rc();
          let hex = '';
          for (let i = 0; i < len; i++) {
            hex += er.rc().toString(16).padStart(2, '0').toUpperCase();
          }
          g.values.push({ code: 1004, value: hex });
        } else if (code >= 10 && code <= 13) {
          g.values.push({
            code: 1000 + code,
            point: { x: er.rd(), y: er.rd(), z: er.rd() }
          });
        } else if (code >= 40 && code <= 42) {
          g.values.push({ code: 1000 + code, value: er.rd() });
        } else if (code === 70) {
          const v = er.rs();
          g.values.push({ code: 1070, value: v >= 0x8000 ? v - 0x10000 : v });
        } else if (code === 71) {
          const v = er.rl();
          g.values.push({ code: 1071, value: v > 0x7FFFFFFF ? v - 0x100000000 : v });
        } else {
          break;                            /* unknown record: stop this chunk */
        }
      }
    } catch {
      /* keep whatever parsed of this chunk */
    }
    groups.push(g);
  }
  return groups.length ? groups : undefined;
};

const pt3 = (x: number, y: number, z: number): Point3 => ({ x, y, z });

/** An extrusion worth keeping: the default normal is dropped so only
 *  entities that really sit in their own plane carry one. */
const extrusionOf = (v: readonly [number, number, number]): Point3 | undefined => {
  const [ex, ey, ez] = v;
  if (Math.abs(ex) < 1e-12 && Math.abs(ey) < 1e-12 && Math.abs(ez - 1) < 1e-12) {
    return undefined;
  }
  if (!isFinite(ex) || !isFinite(ey) || !isFinite(ez)) return undefined;
  if (!ex && !ey && !ez) return undefined;
  return pt3(ex, ey, ez);
};

/** The four frame corners an OLE payload carries in front of the document:
 *  two bytes, then upper-left, upper-right, lower-right and lower-left as
 *  plain little-endian doubles. */
const oleFrameCorners = (
  data: Uint8Array | undefined
): [Point3, Point3, Point3, Point3] => {
  const zero: Point3 = { x: 0, y: 0, z: 0 };
  const out: Point3[] = [];
  if (data && data.length >= 0x62) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < 4; i++) {
      const at = 2 + i * 24;
      out.push({
        x: dv.getFloat64(at, true),
        y: dv.getFloat64(at + 8, true),
        z: dv.getFloat64(at + 16, true)
      });
    }
  }
  while (out.length < 4) out.push({ ...zero });
  return out as [Point3, Point3, Point3, Point3];
};

/** R2007+ string stream: found by walking backwards from `bitsize`.
 *  Returns the reader positioned at the stream's first bit and the exact
 *  content length in bits (the size fields and flag are excluded), so a
 *  sealed retention can carry the stream verbatim. */
const stringStream = (
  body: Uint8Array, bitsize: number
): { r: BitReader; bits: number } | null => {
  if (bitsize < 17) return null;
  const probe = new BitReader(body, bitsize - 1);
  if (!probe.b()) return null;
  probe.pos = bitsize - 1 - 16;
  let size = probe.rs();
  let hdr = 16;
  if (size & 0x8000) {
    probe.pos = bitsize - 1 - 32;
    const hi = probe.rs();
    size = (size & 0x7fff) | (hi << 15);
    hdr = 32;
  }
  const start = bitsize - 1 - hdr - size;   /* size is in bits */
  if (start < 0) return null;
  return { r: new BitReader(body, start, bitsize - 1), bits: size };
};

/** The bit-encoding generation of an object's interior. Records keep the
 *  same specific-data encoding within a generation, so sealed bits can be
 *  re-emitted natively inside their own group and must travel wrapped
 *  outside it. */
export const encodingGroup = (v: number): number =>
  v <= 14 ? 14 : v >= 2010 ? 2018 : v;

/** Marks a proxy record as a nasjidwg seal-wrap: the low half of the
 *  version word names the payload's encoding group. Real proxies carry
 *  small version words; this magic cannot collide with them. */
export const SEAL_MAGIC = 0x4e530000;      /* 'NS' << 16 */

interface CommonEntity {
  handle: number;
  entmode: number;
  numReactors: number;
  nolinks: boolean;
  xdicMissing: boolean;
  color: Color;
  ltypeScale: number;
  ltypeFlags: number;
  plotstyleFlags: number;
  materialFlags: number;
  invisible: boolean;
  lineweight?: number;
  visFlags: [boolean, boolean, boolean];
  shadowFlags: number;
}

class Ctx {
  /** Handle stream. R13/R14 discover its position (bitsize) mid-record, so
   *  the common readers may re-point it. */
  hr: BitReader;
  /** First bit past the object's data area — before the string stream and
   *  its flag (R2007+), at the handle-stream start before that. R13/R14
   *  discover it mid-record; the common readers update it. Blob retention
   *  (proxies, sealed unknowns) captures r.pos .. dataEnd verbatim. */
  dataEnd: number;
  /** R2007+ string stream extent, for sealed retention. */
  srStart = 0;
  srBits = 0;
  constructor(
    readonly c: DecodeContext,
    readonly r: BitReader,
    hr: BitReader,
    readonly sr: BitReader | null,
    dataEnd = 0
  ) { this.hr = hr; this.dataEnd = dataEnd; }
  get v(): number { return this.c.v; }

  /** Version-appropriate text read (logical Arabic restored). */
  text(): string {
    const raw = this.v >= 2007 && this.sr
      ? this.sr.tu()
      : decodeCodepage(this.r.tBytes(), this.c.codepage);
    return decodeCadText(raw);
  }

  handle(owner: number): number { return this.hr.hAbs(owner); }

  /** ENC (R2004+ entities) / CMC (before) — reads hr for DBCOLOR refs. */
  entityColor(): Color {
    if (this.v < 2004) return this.indexColor(this.r.bs());
    const raw = this.r.bs() & 0xffff;
    const flags = raw >> 8;
    const index = raw & 0x1ff;
    let rgb: number | null = null;
    if (flags & 0x20) this.r.bl();        /* transparency */
    if (flags & 0x40) this.hr.h();        /* color book ref */
    else if (flags & 0x80) rgb = this.r.bl() & 0xffffff;
    if ((flags & 0x41) === 0x41) this.text();
    if ((flags & 0x42) === 0x42) this.text();
    if (rgb !== null) return { kind: 'rgb', rgb };
    return this.indexColor(index);
  }

  /** Full CMC (R2004+ objects, e.g. LAYER color). `force2004` selects the
   *  R2004 layout even in older files, which a few records ask for. */
  cmc(force2004 = false): { color: Color; index: number } {
    const index = this.r.bs();
    if (this.v < 2004 && !force2004) return { color: this.indexColor(index), index };
    const rgb = this.r.bl() >>> 0;
    const byte = this.r.rc();
    if (byte & 1) this.text();
    if (byte & 2) this.text();
    const method = (rgb >>> 24) & 0xff;
    if (method === 0xc2) return { color: { kind: 'rgb', rgb: rgb & 0xffffff }, index };
    if (method === 0xc3) return { color: this.indexColor(rgb & 0xff), index: rgb & 0xff };
    /* 0xC0/0xC1 say ByLayer/ByBlock outright; the leading BS is a legacy
       field AutoCAD leaves 0 in 2004+ CMCs, so falling through to it read
       every ByLayer as ByBlock (caught against AutoCAD 2027's own
       MLINESTYLE records, whose BYLAYER elements decoded as byBlock). */
    if (method === 0xc1) return { color: BY_BLOCK, index: 0 };
    if (method === 0xc0) return { color: BY_LAYER, index: 256 };
    return { color: this.indexColor(index), index };
  }

  indexColor(index: number): Color {
    if (index === 256 || index === -1) return BY_LAYER;
    if (index === 0) return BY_BLOCK;
    return ACI_COLORS[Math.abs(index) & 0xff];
  }

  /** Common entity data + common entity handles. */
  xdata?: XdataGroup[];
  /** R2013+: the object stores its heavy payload in the AcDs section. */
  hasDsData = false;
  /** Cached display list of a proxy/unknown entity, when present. */
  proxyGraphics?: Uint8Array;

  commonEntity(): CommonEntity {
    const { r, v } = this;
    const handle = r.hValue();
    this.selfHandle = handle;
    this.xdata = parseEed(r, this.c);
    if (r.b()) {                          /* cached display list */
      const size = v <= 2007 ? r.rl() : r.bll();
      const blob = r.bytes(size);
      if (size > 8 && size < 0x4000000) this.proxyGraphics = blob;
    }
    if (v <= 14) {
      /* R13/R14 store the handle-stream position here, mid-record */
      const bitsize = r.rl();
      this.hr = new BitReader(r.data, bitsize, this.hr.endBit);
      this.dataEnd = bitsize;
    }
    const entmode = r.bb();
    const numReactors = r.bl();
    let nolinks = false, xdicMissing = false;
    let ltypeFlags = 0;
    if (v <= 14) ltypeFlags = r.b() === 1 ? 0 : 3;   /* isbylayerlt */
    if (v >= 2004) xdicMissing = r.b() === 1;
    if (v <= 2002) nolinks = r.b() === 1;
    if (v >= 2013) this.hasDsData = r.b() === 1;
    const color = this.entityColor();
    const ltypeScale = r.bd();
    let plotstyleFlags = 0;
    if (v >= 2000) {
      ltypeFlags = r.bb();
      plotstyleFlags = r.bb();
    }
    let materialFlags = 0, shadowFlags = 0;
    if (v >= 2007) { materialFlags = r.bb(); shadowFlags = r.rc(); }
    const visFlags: [boolean, boolean, boolean] = [false, false, false];
    if (v >= 2010) {
      visFlags[0] = r.b() === 1; visFlags[1] = r.b() === 1; visFlags[2] = r.b() === 1;
    }
    const invisible = (r.bs() & 1) === 1;
    const lineweight = v >= 2000 ? lwToMm(r.rc()) : undefined;

    /* --- handle stream, common part --- */
    const hr = this.hr;
    const out: CommonEntity = {
      handle, entmode, numReactors, nolinks, xdicMissing, color, ltypeScale,
      ltypeFlags, plotstyleFlags, materialFlags, invisible, lineweight,
      visFlags, shadowFlags
    };
    if (entmode === 0) this.ownerHandle = this.handle(handle);
    /* persistent reactors: kept (a constraint's dependency hangs on the
       entity it watches as one); the array only exists when there are
       any, which on a million-entity drawing is almost never */
    if (numReactors > 0 && numReactors < 100000) {
      const reactors: number[] = [];
      for (let i = 0; i < numReactors; i++) reactors.push(this.handle(handle));
      this.reactors = reactors;
    } else {
      for (let i = 0; i < numReactors; i++) hr.h();
    }
    /* the extension dictionary: kept, so the sealed dictionary behind it
       can be hung back under the entity on a rewrite */
    if (v < 2004 || !xdicMissing) this.xdictHandle = this.handle(handle);
    if (v <= 14) {
      /* R13/R14: layer + ltype come BEFORE the prev/next chain */
      this.layerHandle = this.handle(handle);
      if (ltypeFlags === 3) this.ltypeHandle = this.handle(handle);
      if (!nolinks) {
        this.prevHandle = this.handle(handle);
        this.nextHandle = this.handle(handle);
      }
      return out;
    }
    if (v <= 2000 && !nolinks) {
      this.prevHandle = this.handle(handle);
      this.nextHandle = this.handle(handle);
    }
    this.layerHandle = this.handle(handle);
    if (ltypeFlags === 3) this.ltypeHandle = this.handle(handle);
    if (v >= 2007) {
      if (materialFlags === 3) hr.h();
      if (shadowFlags === 3) hr.h();
    }
    if (plotstyleFlags === 3) hr.h();
    if (v >= 2010) for (const f of visFlags) { if (f) hr.h(); }
    return out;
  }

  ownerHandle?: number;
  /** The record's extension dictionary (0 = none). */
  xdictHandle = 0;
  /** Persistent reactors, captured for objects (entity reactors are the
   *  hatch back-links the writer rebuilds, and a per-entity array would
   *  be GC pressure on a million-entity drawing). */
  reactors?: number[];
  prevHandle?: number;
  nextHandle?: number;
  layerHandle?: number;
  ltypeHandle?: number;
  /** The record's own handle, which a relative reference resolves against. */
  selfHandle = 0;
  styleHandle?: number;

  numReactors = 0;
  xdicMissing = false;

  /** Common (non-entity) object data + handles. Control objects read their
   *  handle stream inline after the data instead of trusting bitsize. */
  commonObject(isControl: boolean): { handle: number } {
    const { r, v } = this;
    const handle = r.hValue();
    this.xdata = parseEed(r, this.c);
    if (v <= 14) {
      /* R13/R14: the handle-stream position lives here, after EED */
      const bitsize = r.rl();
      this.hr = new BitReader(r.data, bitsize, this.hr.endBit);
      this.dataEnd = bitsize;
    }
    this.numReactors = r.bl();
    this.xdicMissing = v >= 2004 ? r.b() === 1 : false;
    if (v >= 2013) r.b();                 /* has_ds_data */
    if (!isControl) {
      this.ownerHandle = this.handle(handle);
      if (this.numReactors > 0 && this.numReactors < 100000) {
        const reactors: number[] = [];
        for (let i = 0; i < this.numReactors; i++) reactors.push(this.handle(handle));
        this.reactors = reactors;
      } else {
        for (let i = 0; i < this.numReactors; i++) this.hr.h();
      }
      if (v < 2004 || !this.xdicMissing) this.xdictHandle = this.handle(handle);
    }
    return { handle };
  }

  /** Common table-record flags (name + xref bookkeeping + xref handle). */
  tableFlags(): string {
    const name = this.text();
    let dependent = false;
    if (this.v <= 2004) {
      this.r.b(); this.r.bs();            /* used, xrefindex + 1 */
      dependent = this.r.b() === 1;       /* xref dependent */
    } else {
      this.r.bs();                        /* is_xref_resolved only */
    }
    const xref = this.hr.h();             /* xref block handle */
    this.lastXrefDependent = dependent || xref.value > 0;
    return name;
  }
  /** What the last tableFlags() read: whether the record is an external
   *  reference's (a non-zero xref block, or the pre-2007 flag). */
  lastXrefDependent = false;
}

/* ------------------------------------------------------------------ *
 * entity decoders
 * ------------------------------------------------------------------ */

const H_ALIGN: TextHAlign[] = ['left', 'center', 'right', 'aligned', 'middle', 'fit'];
const V_ALIGN: TextVAlign[] = ['baseline', 'bottom', 'middle', 'top'];

const decodeTextLike = (
  x: Ctx, kind: 'text' | 'attrib' | 'attdef', raw?: RawObject
): Entity => {
  const { r, v } = x;
  /** ATTRIB/ATTDEF close with tag + field length + flags (bit 1 invisible,
   *  bit 2 constant); R2010 fronts the tag with a class-version byte and
   *  R2018 with the attribute type, whose multiline forms (2/4) embed an
   *  MTEXT body this decoder does not walk — their flags stay unread.
   *  Bounded record, so a malformed tail costs the flags, never the text. */
  const attribFlags = (): number => {
    let single = true;
    try {
      if (v >= 2010) r.rc();              /* class version */
      if (v >= 2018) single = r.rc() <= 1;
    } catch { single = false; }
    const tag = x.text();
    /* the tag stays on the raw record: a multileader's block label or a
       table's block cell names the definition by handle */
    if (raw && kind === 'attdef' && tag) raw.attTag = tag;
    if (!single) return 0;
    try {
      r.bs();                             /* field length */
      return r.rc();
    } catch { return 0; }
  };
  const finish = (ent: Entity): Entity => {
    if (kind === 'text') return ent;
    const t = ent as Extract<Entity, { type: 'text' }>;
    t.attribute = kind;
    const flags = attribFlags();
    if (flags & 1) t.invisible = true;
    if (flags & 2) t.constant = true;
    return t;
  };
  if (x.v <= 14) {
    /* R13/R14: all fields explicit, no dataflags */
    const elevation = r.bd();
    const [ix, iy] = r.rd2();
    const [ax, ay] = r.rd2();
    const r14Ext = extrusionOf(r.bd3());
    r.bd();                               /* thickness */
    const oblique = r.bd();
    const rotation = r.bd();
    const height = r.bd();
    const widthFactor = r.bd();
    const text = x.text();
    r.bs();                               /* generation */
    const ha = r.bs();
    const va = r.bs();
    const ent = finish({
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: pt3(ix, iy, elevation),
      alignmentPoint: (ha || va) ? pt3(ax, ay, elevation) : undefined,
      text, height, rotation,
      widthFactor: widthFactor !== 1 ? widthFactor : undefined,
      oblique: oblique || undefined,
      halign: H_ALIGN[ha] ?? 'left',
      valign: V_ALIGN[va] ?? 'baseline',
      ...(r14Ext ? { extrusion: r14Ext } : {})
    });
    x.styleHandle = x.handle(x.selfHandle);   /* style */
    return ent;
  }
  const df = r.rc();                      /* dataflags: bits mark ABSENT fields */
  const elevation = (df & 0x01) ? 0 : r.rd();
  const [ix, iy] = r.rd2();
  let ax = ix, ay = iy;
  if (!(df & 0x02)) { ax = r.dd(ix); ay = r.dd(iy); }
  const textExt = extrusionOf(r.be());
  r.bt();                                 /* thickness */
  const oblique = (df & 0x04) ? 0 : r.rd();
  const rotation = (df & 0x08) ? 0 : r.rd();
  const height = r.rd();
  const widthFactor = (df & 0x10) ? 1 : r.rd();
  const text = x.text();
  if (!(df & 0x20)) r.bs();               /* generation */
  const ha = (df & 0x40) ? 0 : r.bs();
  const va = (df & 0x80) ? 0 : r.bs();
  const ent = finish({
    type: 'text', layer: '0', color: { kind: 'byLayer' },
    position: pt3(ix, iy, elevation),
    alignmentPoint: (ha || va) ? pt3(ax, ay, elevation) : undefined,
    text, height, rotation,
    widthFactor: widthFactor !== 1 ? widthFactor : undefined,
    oblique: oblique || undefined,
    halign: H_ALIGN[ha] ?? 'left',
    valign: V_ALIGN[va] ?? 'baseline',
    ...(textExt ? { extrusion: textExt } : {})
  });
  x.styleHandle = x.handle(x.selfHandle);     /* style */
  return ent;
};

/** Capture the opaque half of a proxy record: the rest of the data area
 *  bit-exact, and the rest of the handle stream code-for-code. Shared by
 *  the entity (0x1F2) and object (0x1F3) forms — the two records differ
 *  only in their common prologue. */
const captureProxyTail = (x: Ctx): {
  data?: string; dataBits?: number; refs?: { code: number; value: string }[];
} => {
  const { r } = x;
  const end = Math.max(r.pos, Math.min(x.dataEnd, r.endBit));
  const nbits = end - r.pos;
  const blob = new Uint8Array((nbits + 7) >> 3);
  for (let i = 0; i < nbits; i++) {
    if (r.b()) blob[i >> 3] |= 0x80 >> (i & 7);
  }
  const refs: { code: number; value: string }[] = [];
  try {
    const hr = x.hr;
    while (hr.pos + 8 <= hr.endBit) {
      const h = hr.h();
      refs.push({ code: h.code, value: h.value.toString(16).toUpperCase() });
    }
  } catch {
    /* a truncated tail keeps the references read so far */
  }
  /* record padding can masquerade as null references at the tail */
  while (refs.length && refs[refs.length - 1].code === 0
         && refs[refs.length - 1].value === '0') refs.pop();
  return {
    data: nbits > 0 ? toBase64(blob) : undefined,
    dataBits: nbits > 0 ? nbits : undefined,
    refs: refs.length ? refs : undefined
  };
};

/** Seal a whole record: the proxy tail plus, on R2007+, the string stream
 *  content bit-exact. This is the universal-passthrough capture — any
 *  record the semantic layer cannot (or fails to) model is retained whole
 *  and re-emitted, so nothing in a drawing is ever lost to ignorance. */
/** The seal's payload as the writer's sealBody lays it out (writer.ts):
 *  from R2004 a 16-bit zero word precedes the data, and from R2007 the
 *  strings are the record's own string stream rather than inline bits. */
const readSealBody = (x: Ctx): {
  dataBits: number; blob: Uint8Array; strBits: number; strBlob: Uint8Array;
} => {
  const { r, v } = x;
  if (v >= 2004) r.rs();
  const dataBits = r.rl();
  const blob = new Uint8Array((dataBits + 7) >> 3);
  for (let i = 0; i < dataBits; i++) {
    if (r.b()) blob[i >> 3] |= 0x80 >> (i & 7);
  }
  /* the seal's own strings follow its data bits in every release; the
     R2007+ string stream of the record is the reference's "cn:<class>"
     field and is left to it */
  const strBits = r.rl();
  const strBlob = new Uint8Array((strBits + 7) >> 3);
  for (let i = 0; i < strBits; i++) {
    if (r.b()) strBlob[i >> 3] |= 0x80 >> (i & 7);
  }
  return { dataBits, blob, strBits, strBlob };
};

const captureSealed = (x: Ctx): {
  data?: string; dataBits?: number; strData?: string; strBits?: number;
  refs?: { code: number; value: string }[];
} => {
  const out: ReturnType<typeof captureSealed> = captureProxyTail(x);
  if (x.sr && x.srBits > 0) {
    const sr = new BitReader(x.r.data, x.srStart, x.srStart + x.srBits);
    const blob = new Uint8Array((x.srBits + 7) >> 3);
    for (let i = 0; i < x.srBits; i++) {
      if (sr.b()) blob[i >> 3] |= 0x80 >> (i & 7);
    }
    out.strData = toBase64(blob);
    out.strBits = x.srBits;
  }
  return out;
};

const decodeEntitySpecific = (
  x: Ctx, typeName: string, raw: RawObject
): Entity | null => {
  const { r, v } = x;
  switch (typeName) {
    case 'TEXT': return decodeTextLike(x, 'text');
    case 'ATTRIB': return decodeTextLike(x, 'attrib');
    case 'ATTDEF': return decodeTextLike(x, 'attdef', raw);

    case 'LINE': {
      if (v >= 2000) {
        const zIsZero = r.b();
        const x1 = r.rd(); const x2 = r.dd(x1);
        const y1 = r.rd(); const y2 = r.dd(y1);
        let z1 = 0, z2 = 0;
        if (!zIsZero) { z1 = r.rd(); z2 = r.dd(z1); }
        r.bt();
        const ext = extrusionOf(r.be());
        return {
          type: 'line', layer: '0', color: { kind: 'byLayer' },
          start: pt3(x1, y1, z1), end: pt3(x2, y2, z2),
          ...(ext ? { extrusion: ext } : {})
        };
      }
      const [sx2, sy2, sz2] = r.bd3();
      const [ex, ey, ez] = r.bd3();
      /* R13/R14 spell thickness/extrusion in full (BD + 3BD); the one-bit
         BT/BE shortcuts arrived with R2000 */
      let lineExt: Point3 | undefined;
      if (v <= 14) { r.bd(); lineExt = extrusionOf(r.bd3()); }
      else { r.bt(); lineExt = extrusionOf(r.be()); }
      return {
        type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: pt3(sx2, sy2, sz2), end: pt3(ex, ey, ez),
        ...(lineExt ? { extrusion: lineExt } : {})
      };
    }

    case 'POINT': {
      const px = r.bd(), py = r.bd(), pz = r.bd();
      const ptExt = v <= 14
        ? (r.bd(), extrusionOf(r.bd3()))
        : (r.bt(), extrusionOf(r.be()));
      r.bd();                             /* x-axis angle */
      return {
        type: 'point', layer: '0', color: { kind: 'byLayer' },
        position: pt3(px, py, pz),
        ...(ptExt ? { extrusion: ptExt } : {})
      };
    }

    case 'CIRCLE': {
      const [cx, cy, cz] = r.bd3();
      const radius = r.bd();
      if (v <= 14) r.bd(); else r.bt();   /* thickness */
      const ext = extrusionOf(v <= 14 ? r.bd3() : r.be());
      return {
        type: 'circle', layer: '0', color: { kind: 'byLayer' },
        center: pt3(cx, cy, cz), radius, ...(ext ? { extrusion: ext } : {})
      };
    }

    case 'ARC': {
      const [cx, cy, cz] = r.bd3();
      const radius = r.bd();
      if (v <= 14) r.bd(); else r.bt();   /* thickness */
      const ext = extrusionOf(v <= 14 ? r.bd3() : r.be());
      const startAngle = r.bd(), endAngle = r.bd();
      return {
        type: 'arc', layer: '0', color: { kind: 'byLayer' },
        center: pt3(cx, cy, cz), radius, startAngle, endAngle,
        ...(ext ? { extrusion: ext } : {})
      };
    }

    case 'ELLIPSE': {
      const [cx, cy, cz] = r.bd3();
      const [mx, my, mz] = r.bd3();
      const ext = extrusionOf(r.bd3());
      const ratio = r.bd();
      const startParam = r.bd(), endParam = r.bd();
      return {
        type: 'ellipse', layer: '0', color: { kind: 'byLayer' },
        center: pt3(cx, cy, cz), majorAxis: pt3(mx, my, mz),
        ratio, startParam, endParam, ...(ext ? { extrusion: ext } : {})
      };
    }

    case 'RAY':
    case 'XLINE': {
      const [px, py, pz] = r.bd3();
      const [dx, dy, dz] = r.bd3();
      return {
        type: typeName === 'RAY' ? 'ray' : 'xline',
        layer: '0', color: { kind: 'byLayer' },
        basePoint: pt3(px, py, pz), direction: pt3(dx, dy, dz)
      };
    }

    case 'SOLID':
    case 'TRACE': {
      if (v <= 14) r.bd(); else r.bt();   /* thickness */
      const elev = r.bd();
      const c1 = r.rd2(), c2 = r.rd2(), c3 = r.rd2(), c4 = r.rd2();
      const sldExt = extrusionOf(v <= 14 ? r.bd3() : r.be());
      return {
        type: 'solid', layer: '0', color: { kind: 'byLayer' },
        corners: [
          pt3(c1[0], c1[1], elev), pt3(c2[0], c2[1], elev),
          pt3(c3[0], c3[1], elev), pt3(c4[0], c4[1], elev)
        ],
        ...(sldExt ? { extrusion: sldExt } : {})
      };
    }

    case 'SPLINE': {
      const scenario = r.bl();
      let flags = scenario;
      if (v >= 2013) {
        const sf = r.bl();
        r.bl();                           /* knot parametrization */
        flags = (sf & 1) ? 2 : 1;
      }
      const degree = r.bl();
      if (flags & 1) {                    /* full spline */
        const rational = r.b(); const closed = r.b(); r.b();
        r.bd(); r.bd();                   /* knot/ctrl tolerances */
        const numKnots = r.bl();
        const numCtrl = r.bl();
        const weighted = r.b();
        if (numKnots > 100000 || numCtrl > 100000) return null;
        const knots: number[] = [];
        for (let i = 0; i < numKnots; i++) knots.push(r.bd());
        const controlPoints: Point3[] = [];
        const weights: number[] = [];
        for (let i = 0; i < numCtrl; i++) {
          const [px, py, pz] = r.bd3();
          controlPoints.push(pt3(px, py, pz));
          if (weighted) weights.push(r.bd());
        }
        void rational;                    /* implied by presence of weights */
        return {
          type: 'spline', layer: '0', color: { kind: 'byLayer' },
          degree, closed: closed === 1, controlPoints, knots,
          weights: weighted ? weights : undefined
        };
      }
      r.bd();                             /* fit tolerance */
      r.bd3(); r.bd3();                   /* tangents */
      const numFit = r.bl();
      if (numFit > 100000) return null;
      const fitPoints: Point3[] = [];
      for (let i = 0; i < numFit; i++) {
        const [px, py, pz] = r.bd3();
        fitPoints.push(pt3(px, py, pz));
      }
      return {
        type: 'spline', layer: '0', color: { kind: 'byLayer' },
        degree, closed: false, controlPoints: [], knots: [], fitPoints
      };
    }

    case 'LWPOLYLINE': {
      const flag = r.bs();
      const constantWidth = (flag & 4) ? r.bd() : undefined;
      const elevation = (flag & 8) ? r.bd() : 0;
      if (flag & 2) r.bd();               /* thickness */
      const lwExt = (flag & 1) ? extrusionOf(r.bd3()) : undefined;
      const n = r.bl();
      if (n > 100000) return null;
      const numBulges = (flag & 16) ? r.bl() : 0;
      const numIds = (v >= 2010 && (flag & 1024)) ? r.bl() : 0;
      const numWidths = (flag & 32) ? r.bl() : 0;
      const vertices: PolylineVertex[] = [];
      let lx = 0, ly = 0;
      for (let i = 0; i < n; i++) {
        if (i === 0 || v <= 14) { lx = r.rd(); ly = r.rd(); }
        else { lx = r.dd(lx); ly = r.dd(ly); }
        vertices.push({ x: lx, y: ly });
      }
      for (let i = 0; i < numBulges; i++) {
        const b = r.bd();
        if (vertices[i] && b) vertices[i].bulge = b;
      }
      /* R2010+ vertex identifiers (DXF 91): a constrained polyline names
         its vertices by them, and the reference audits a constraint whose
         vertex id is gone */
      for (let i = 0; i < numIds; i++) {
        const id = r.bl();
        if (vertices[i] && id) vertices[i].id = id;
      }
      for (let i = 0; i < numWidths; i++) {
        const sw = r.bd(), ew = r.bd();
        if (vertices[i]) {
          if (sw) vertices[i].startWidth = sw;
          if (ew) vertices[i].endWidth = ew;
        }
      }
      return {
        type: 'polyline', layer: '0', color: { kind: 'byLayer' },
        vertices, closed: (flag & 512) !== 0, constantWidth,
        elevation: elevation || undefined,
        ...(flag & 256 ? { plineGen: true } : {}),
        ...(lwExt ? { extrusion: lwExt } : {})
      };
    }

    case 'MTEXT': {
      const [ix, iy, iz] = r.bd3();
      const mtExt = extrusionOf(r.bd3());
      const [xx, xy] = [r.bd(), r.bd()]; r.bd();   /* x-axis dir */
      const rectWidth = r.bd();
      if (v >= 2007) r.bd();              /* rect height */
      const height = r.bd();
      const attachment = r.bs();
      r.bs();                             /* flow direction */
      r.bd(); r.bd();                     /* extents */
      const raw = x.text();
      x.styleHandle = x.handle(x.selfHandle);   /* style */
      if (v >= 2000) { r.bs(); r.bd(); r.b(); }    /* line spacing */
      if (v >= 2004) {
        const bg = r.bl();
        /* the background scale factor (DXF 45) is a BD, not a BL —
           reading a BL swallowed only the low half of the double and
           left the colour that follows misaligned, which sealed every
           background-filled MTEXT near the end of its record */
        if (bg & (v <= 2018 ? 1 : 16)) { r.bd(); x.cmc(); r.bl(); }
      }
      const rotation = Math.atan2(xy, xx);
      return {
        type: 'mtext', layer: '0', color: { kind: 'byLayer' },
        position: pt3(ix, iy, iz),
        text: raw.replace(/\\P/gi, '\n'),
        raw, height, rotation,
        width: rectWidth || undefined,
        attachment: attachment >= 1 && attachment <= 9 ? attachment : undefined,
        ...(mtExt ? { extrusion: mtExt } : {})
      };
    }

    case 'INSERT':
    case 'MINSERT': {
      const [ix, iy, iz] = r.bd3();
      let sx = 1, sy = 1, sz = 1;
      if (v >= 2000) {
        const sf = r.bb();
        if (sf === 3) { /* all 1.0 */ }
        else if (sf === 1) { sy = r.dd(1); sz = r.dd(1); }
        else if (sf === 2) { sx = sy = sz = r.rd(); }
        else { sx = r.rd(); sy = r.dd(sx); sz = r.dd(sx); }
      } else {
        sx = r.bd(); sy = r.bd(); sz = r.bd();
      }
      const rotation = r.bd();
      const insExt = extrusionOf(r.bd3());
      const hasAttribs = r.b() === 1;
      let numOwned = 0;
      if (v >= 2004 && hasAttribs) numOwned = r.bl();
      let columnCount, rowCount, columnSpacing, rowSpacing;
      if (typeName === 'MINSERT') {
        columnCount = r.bs(); rowCount = r.bs();
        columnSpacing = r.bd(); rowSpacing = r.bd();
      }
      const blockHeader = x.handle(raw.handle);
      const attribs: number[] = [];
      let chain: { first: number; last: number } | undefined;
      if (hasAttribs) {
        if (v <= 2000) {
          const first = x.handle(raw.handle);
          const last = x.handle(raw.handle);
          chain = { first, last };
        } else {
          for (let i = 0; i < numOwned; i++) attribs.push(x.handle(raw.handle));
        }
        x.hr.h();                         /* seqend */
      }
      raw.insert = { blockHeader, attribs, hasAttribs, chain };
      return {
        type: 'insert', layer: '0', color: { kind: 'byLayer' },
        blockName: '',                    /* resolved by the assembler */
        position: pt3(ix, iy, iz), scale: pt3(sx, sy, sz), rotation,
        columnCount, rowCount, columnSpacing, rowSpacing,
        ...(insExt ? { extrusion: insExt } : {})
      };
    }

    case 'Vertex2d': {
      /* the 70 byte says what the vertex IS: 1 = inserted by curve
         fitting, 2 = has a tangent, 8 = a spline-fitted vertex, 16 = a
         spline frame point — the assembler sorts them into the polyline */
      const flags = r.rc();
      const [px, py, pz] = r.bd3();
      let sw = r.bd(), ew = 0;
      if (sw < 0) { sw = -sw; ew = sw; } else ew = r.bd();
      const bulge = r.bd();
      const id = v >= 2010 ? r.bl() : 0;
      const tangent = r.bd();
      raw.vertex = {
        x: px, y: py, z: pz, flags,
        bulge: bulge || undefined,
        startWidth: sw || undefined, endWidth: ew || undefined,
        ...(id ? { id } : {}),
        ...(flags & 2 ? { tangent } : {})
      };
      return null;                        /* folded into its polyline */
    }
    case 'Vertex3d':
    case 'VertexMesh':
    case 'VertexPFace': {
      const flags = r.rc();
      const [px, py, pz] = r.bd3();
      raw.vertex = { x: px, y: py, z: pz, flags };
      return null;
    }

    case 'Polyline2d': {
      const flag = r.bs();
      const curveType = r.bs();           /* 75 */
      r.bd(); r.bd();                     /* default widths */
      if (v <= 14) r.bd(); else r.bt();   /* thickness */
      const elevation = r.bd();
      const ext = v <= 14 ? r.bd3() : r.be();
      const numOwned = v >= 2004 ? r.bl() : 0;
      raw.polyline = collectPolylineHandles(x, raw, false, (flag & 1) === 1, numOwned);
      polylineFlags(raw.polyline, flag, curveType);
      if (elevation) raw.polyline.elevation = elevation;
      const pext = extrusionOf(ext);
      if (pext) raw.polyline.extrusion = pext;
      return null;                        /* built after vertices resolve */
    }
    case 'Polyline3d': {
      /* two bytes: the curve type first (spline-fit: 5 = quadratic,
         6 = cubic — not the 70 bit the 2D header uses), then the 70
         flags, where bit 0 is closed */
      const curveType = r.rc();
      const flag = r.rc();
      const numOwned = v >= 2004 ? r.bl() : 0;
      raw.polyline = collectPolylineHandles(x, raw, true, (flag & 1) === 1, numOwned);
      polylineFlags(raw.polyline, flag | (curveType ? 4 : 0), curveType);
      return null;
    }

    case 'BLOCK': {
      raw.blockName = x.text();
      return null;
    }
    case 'ENDBLK':
    case 'SEQEND':
      return null;

    case 'LEADER': {
      r.b();                              /* unknown bit */
      const annotationType = r.bs();
      const pathType = r.bs();
      const n = r.bl();
      if (n > 100000) return null;
      const vertices: Point3[] = [];
      for (let i = 0; i < n; i++) {
        const [px, py, pz] = r.bd3();
        vertices.push(pt3(px, py, pz));
      }
      r.bd3();                            /* origin */
      const ldrExt = extrusionOf(r.bd3());
      r.bd3();                            /* x direction */
      r.bd3();                            /* inspt offset */
      /* Tail layout. All versions keep endptproj (R13c3+); the box
         height/width pair was dropped in R2010+ (verified against an
         AutoCAD-2027-minted 2018 LEADER). Older nasjidwg 2018 files used
         the pre-2010 spelling, so on 2010+ try the real layout first and
         fall back to the legacy one when it does not land on dataEnd. */
      let arrowheadOn = true;
      const tail = (endpt: boolean, boxHW: boolean): void => {
        if (endpt) r.bd3();               /* endptproj */
        if (v <= 14) r.bd();              /* dimgap */
        if (boxHW) { r.bd(); r.bd(); }    /* box height/width */
        r.b();                            /* hookline dir */
        arrowheadOn = r.b() === 1;
        r.bs();                           /* arrowhead type */
        if (v <= 14) {
          r.bd(); r.b(); r.b(); r.bs(); r.bs(); r.b(); r.b();
        } else {
          r.b(); r.b();                   /* two unknown bits */
        }
      };
      if (v >= 2010) {
        const mark = r.pos;
        tail(true, false);                /* real R2010+ spelling */
        if (r.pos !== x.dataEnd) {
          r.pos = mark;
          tail(false, true);              /* legacy nasjidwg spelling */
        }
      } else {
        /* endptproj arrives with R13c3; plain R13 (AC1012) has no such
           point — the vintage reference runs dimgap straight on */
        tail(v > 13, true);
      }
      const annotation = x.hr.h();        /* associated annotation */
      x.hr.h();                           /* dimstyle */
      return {
        type: 'leader', layer: '0', color: { kind: 'byLayer' }, vertices,
        hasArrowhead: arrowheadOn ? undefined : false,
        pathType: pathType || undefined,
        annotationType: annotationType !== 3 ? annotationType : undefined,
        annotation: annotationType !== 3 && annotation.value > 0
          ? annotation.value.toString(16).toUpperCase() : undefined,
        ...(ldrExt ? { extrusion: ldrExt } : {})
      };
    }

    case 'DimOrdinate':
    case 'DimRotated':
    case 'DimAligned':
    case 'DimAngular3Point':
    case 'DimAngular2Line':
    case 'DimRadius':
    case 'DimDiameter':
    case 'ARC_DIMENSION':
      return decodeDimension(x, typeName, raw);

    case '3DFACE': {
      const e: Face3DEntity = {
        type: 'face3d', layer: '0', color: { kind: 'byLayer' },
        corners: [pt3(0, 0, 0), pt3(0, 0, 0), pt3(0, 0, 0), pt3(0, 0, 0)]
      };
      if (v <= 14) {
        for (let i = 0; i < 4; i++) {
          const [px, py, pz] = r.bd3();
          e.corners[i] = pt3(px, py, pz);
        }
        const inv = r.bs();
        if (inv) e.invisibleEdges = inv;
        return e;
      }
      const hasNoFlags = r.b() === 1;
      const zIsZero = r.b() === 1;
      const c1x = r.rd(), c1y = r.rd();
      const c1z = zIsZero ? 0 : r.rd();
      e.corners[0] = pt3(c1x, c1y, c1z);
      let [px, py, pz] = [c1x, c1y, c1z];
      for (let i = 1; i < 4; i++) {
        px = r.dd(px); py = r.dd(py); pz = r.dd(pz);
        e.corners[i] = pt3(px, py, pz);
      }
      if (!hasNoFlags) {
        const inv = r.bs();
        if (inv) e.invisibleEdges = inv;
      }
      return e;
    }

    case 'SHAPE': {
      const [ix, iy, iz] = r.bd3();
      const size = r.bd();
      const rotation = r.bd();
      const widthFactor = r.bd();
      const oblique = r.bd();
      r.bd();                             /* thickness */
      const styleId = r.bs();
      const shpExt = extrusionOf(r.bd3());
      x.hr.h();                           /* style handle */
      return {
        type: 'shape', layer: '0', color: { kind: 'byLayer' },
        position: pt3(ix, iy, iz), size, rotation,
        widthFactor: widthFactor !== 1 ? widthFactor : undefined,
        oblique: oblique || undefined, styleId,
        ...(shpExt ? { extrusion: shpExt } : {})
      };
    }

    case 'TOLERANCE': {
      if (v <= 14) { r.bs(); r.bd(); r.bd(); }   /* unknown, height, dimgap */
      const [ix, iy, iz] = r.bd3();
      const [dx2, dy2, dz2] = r.bd3();
      const tolExt = extrusionOf(r.bd3());
      const text = x.text();
      x.hr.h();                           /* dimstyle */
      return {
        type: 'tolerance', layer: '0', color: { kind: 'byLayer' },
        position: pt3(ix, iy, iz), xDirection: pt3(dx2, dy2, dz2), text,
        ...(tolExt ? { extrusion: tolExt } : {})
      };
    }

    case 'MLINE': {
      const scale = r.bd();
      const justification = r.rc();
      const [bx, by, bz] = r.bd3();
      const mlExt = extrusionOf(r.bd3());
      const flags = r.bs();
      const numLines = r.rc();
      const numVerts = r.bs();
      if (numVerts > 5000 || numLines > 64) return null;
      const vertices: MLineVertex[] = [];
      for (let i = 0; i < numVerts; i++) {
        const [vx, vy, vz] = r.bd3();
        const [dx2, dy2, dz2] = r.bd3();
        const [mx, my, mz] = r.bd3();
        const lines: MLineVertex['lines'] = [];
        for (let j = 0; j < numLines; j++) {
          const nSeg = r.bs();
          if (nSeg > 5000) throw new RangeError('mline segparms');
          const segparms: number[] = [];
          for (let k = 0; k < nSeg; k++) segparms.push(r.bd());
          const nFill = r.bs();
          if (nFill > 5000) throw new RangeError('mline areafill');
          const areaFillParms: number[] = [];
          for (let k = 0; k < nFill; k++) areaFillParms.push(r.bd());
          lines.push({
            segparms,
            areaFillParms: areaFillParms.length ? areaFillParms : undefined
          });
        }
        vertices.push({
          position: pt3(vx, vy, vz),
          direction: pt3(dx2, dy2, dz2),
          miterDirection: pt3(mx, my, mz),
          lines
        });
      }
      /* the style: resolved to its name by the reader (the ACAD_MLINESTYLE
         entry the handle is listed under) */
      raw.mlineStyleHandle = x.handle(raw.handle);
      return {
        type: 'mline', layer: '0', color: { kind: 'byLayer' },
        scale, justification, basePoint: pt3(bx, by, bz),
        closed: (flags & 2) !== 0 || undefined, vertices,
        ...(mlExt ? { extrusion: mlExt } : {})
      };
    }

    case 'VIEWPORT': {
      const [cx, cy, cz] = r.bd3();
      const width = r.bd();
      const height = r.bd();
      const e: ViewportEntity = {
        type: 'viewport', layer: '0', color: { kind: 'byLayer' },
        center: pt3(cx, cy, cz), width, height
      };
      if (v <= 14) { x.hr.h(); return e; } /* vport entity header */
      const [tx, ty, tz] = r.bd3();
      e.viewTarget = pt3(tx, ty, tz);
      const [vx, vy, vz] = r.bd3();
      e.viewDirection = pt3(vx, vy, vz);
      e.twistAngle = r.bd() || undefined;
      e.viewHeight = r.bd() || undefined;
      e.lensLength = r.bd() || undefined;
      r.bd(); r.bd();                     /* front/back clip z */
      if (x.c.dwgVerByte !== 0x1a) {
        r.bd();                           /* snap angle */
        e.viewCenter = { x: r.rd(), y: r.rd() };
        r.rd(); r.rd();                   /* snap base */
      } else {
        e.viewCenter = { x: r.rd(), y: r.rd() };
      }
      r.rd(); r.rd();                     /* snap unit */
      r.rd(); r.rd();                     /* grid unit */
      r.bs();                             /* circle zoom */
      if (v >= 2007) r.bs();              /* grid major */
      const numFrozen = r.bl();
      e.statusFlag = r.bl() || undefined;
      x.text();                           /* style sheet */
      r.rc();                             /* render mode */
      r.b(); r.b();                       /* ucs at origin, UCSVP */
      r.bd3(); r.bd3(); r.bd3();          /* ucs org/xdir/ydir */
      r.bd();                             /* ucs elevation */
      r.bs();                             /* ortho view type */
      if (v >= 2004) r.bs();              /* shadeplot mode */
      if (v >= 2007) {
        r.b(); r.rc(); r.bd(); r.bd();    /* lights, brightness, contrast */
        x.cmc();                          /* ambient color */
      }
      if (numFrozen < 100000) {
        for (let i = 0; i < numFrozen; i++) x.hr.h();  /* frozen layers */
      }
      x.hr.h();                           /* clip boundary */
      if (v <= 2002) x.hr.h();            /* vport entity header */
      x.hr.h(); x.hr.h();                 /* named/base ucs */
      if (v >= 2007) { x.hr.h(); x.hr.h(); x.hr.h(); x.hr.h(); }
      return e;
    }

    case 'PolylineMesh': {
      const flag = r.bs();
      r.bs();                             /* curve type */
      const m = r.bs();
      const n2 = r.bs();
      r.bs(); r.bs();                     /* m/n density */
      const numOwned = v >= 2004 ? r.bl() : 0;
      raw.mesh = {
        kind: 'grid', m, n: n2,
        closedM: (flag & 1) !== 0, closedN: (flag & 32) !== 0,
        vertexHandles: []
      };
      collectMeshHandles(x, raw, numOwned);
      return null;                        /* built after vertices resolve */
    }

    case 'PolylinePFace': {
      const numVerts = r.bs();
      r.bs();                             /* num faces */
      const numOwned = v >= 2004 ? r.bl() : 0;
      raw.mesh = { kind: 'faces', m: numVerts, vertexHandles: [] };
      collectMeshHandles(x, raw, numOwned);
      return null;
    }

    case 'PFaceFace': {
      const idx: number[] = [];
      for (let i = 0; i < 4; i++) idx.push(r.bs());
      raw.pfaceFace = idx;
      return null;                        /* folded into its polyface mesh */
    }

    case 'HATCH':
      return decodeHatch(x);

    case 'POINTCLOUD':
    case 'POINTCLOUDEX': {
      /* the scan itself is an external file; the record places it and
         states its extents, which is what a drawing needs to show it */
      r.bs();                             /* class version */
      const ex = typeName === 'POINTCLOUDEX';
      let fileName: string | undefined;
      let origin: Point3 | undefined;
      let numFiles = 0;
      if (!ex) {
        const [ox, oy, oz] = r.bd3();
        origin = pt3(ox, oy, oz);
        fileName = x.text() || undefined;
        numFiles = r.bl();
        if (numFiles < 0 || numFiles > 100000) throw new RangeError('scan files');
      }
      const cloud: Entity = {
        type: 'pointcloud', layer: '0', color: { kind: 'byLayer' },
        extentsMin: pt3(0, 0, 0), extentsMax: pt3(0, 0, 0)
      };
      if (origin) cloud.origin = origin;
      if (fileName) cloud.fileName = fileName;
      if (ex || !numFiles) {
        const [ax, ay, az] = r.bd3();
        const [bx, by, bz] = r.bd3();
        cloud.extentsMin = pt3(ax, ay, az);
        cloud.extentsMax = pt3(bx, by, bz);
        if (!ex) {
          const lo = r.rl(), hi = r.rl();
          cloud.pointCount = hi * 0x100000000 + (lo >>> 0);
          x.text();                       /* named UCS */
        }
        const [ux, uy, uz] = r.bd3();
        cloud.origin = ex ? pt3(ux, uy, uz) : cloud.origin ?? pt3(ux, uy, uz);
        const [xx, xy, xz] = r.bd3();
        const [yx, yy, yz] = r.bd3();
        const [zx, zy, zz] = r.bd3();
        cloud.xAxis = pt3(xx, xy, xz);
        cloud.yAxis = pt3(yx, yy, yz);
        cloud.zAxis = pt3(zx, zy, zz);
        if (ex) {
          cloud.locked = r.b() === 1;
          x.hr.h();                       /* definition */
          x.hr.h();                       /* reactor */
          cloud.fileName = x.text() || undefined;
          cloud.showIntensity = r.b() === 1;
        }
      }
      /* the styling and cropping tail varies by release; the placement
         above is what a viewer needs and is read in full */
      return cloud;
    }

    case 'OLEFRAME':
    case 'OLE2FRAME': {
      /* the frame geometry lives in the first 128 bytes of the payload, in
         front of the compound document itself */
      const oleType = r.bs();
      const tileMode = v >= 2000 ? r.bs() : undefined;
      const size = r.bl();
      const data = size > 0 && size < 0x4000000 ? r.bytes(size) : undefined;
      const lockAspect = v >= 2000 ? r.rc() === 1 : undefined;
      const corners = oleFrameCorners(data);
      return {
        type: 'ole', layer: '0', color: { kind: 'byLayer' },
        oleType, tileMode, lockAspect: lockAspect || undefined,
        corners, data
      };
    }

    case 'ACAD_PROXY_ENTITY': {
      /* The proxy record is opaque by design: after the class id and the
         version word(s), the owning application's data runs to the end of
         the data area, and its handle references fill the rest of the
         handle stream. All of it is retained exactly — payload bit-exact,
         references code-for-code — so a rewrite reproduces the record and
         the owning application still recognizes its object. The cached
         display list rides the common entity data; the reader attaches
         both its bytes and its decoded primitives. */
      const classId = r.bl();
      const proxyVersion = r.bl();
      const proxyMaint = v >= 2018 ? r.bl() : undefined;
      const fromDxf = v >= 2000 ? r.b() === 1 : undefined;
      const cls = x.c.classes.get(classId);
      if (((proxyVersion & 0xffff0000) >>> 0) === SEAL_MAGIC) {
        /* A nasjidwg seal-wrap: a record whose bits belong to another
           encoding generation, carried through this file inside a proxy —
           the format's own idiom for "data the host release cannot hold".
           Unwrapped here so it can go native again when the target
           generation matches (the A→B→A round trip). */
        const { dataBits, blob, strBits, strBlob } = readSealBody(x);
        const tail = captureProxyTail(x);
        return {
          type: 'unknown', layer: '0', color: { kind: 'byLayer' },
          sourceType: cls?.dxfName ?? typeName,
          appClass: cls
            ? { dxfName: cls.dxfName, cppName: cls.cppName, appName: cls.appName }
            : undefined,
          encoding: proxyVersion & 0xffff,
          data: dataBits > 0 ? toBase64(blob) : undefined,
          dataBits: dataBits > 0 ? dataBits : undefined,
          strData: strBits > 0 ? toBase64(strBlob) : undefined,
          strBits: strBits > 0 ? strBits : undefined,
          refs: tail.refs
        };
      }
      return {
        type: 'proxy', layer: '0', color: { kind: 'byLayer' },
        sourceType: cls?.dxfName ?? typeName,
        graphics: [],
        appClass: cls
          ? { dxfName: cls.dxfName, cppName: cls.cppName, appName: cls.appName }
          : undefined,
        proxyVersion,
        proxyMaint,
        fromDxf,
        ...captureProxyTail(x)
      };
    }

    case 'LIGHT': {
      r.bl();                             /* class version */
      const name = x.text();
      const lightType = r.bl();
      const on = r.b() === 1;
      const { color: lightColor } = x.cmc();
      r.b();                              /* plot glyph */
      const intensity = r.bd();
      const [px, py, pz] = r.bd3();
      const [tx, ty, tz] = r.bd3();
      r.bl();                             /* attenuation type */
      r.b();                              /* use attenuation limits */
      r.bd(); r.bd();                     /* attenuation start/end */
      const hotspotAngle = r.bd();
      const falloffAngle = r.bd();
      const castShadows = r.b() === 1;
      return {
        type: 'light', layer: '0', color: { kind: 'byLayer' },
        name: name || undefined, lightType, on, intensity,
        position: pt3(px, py, pz), target: pt3(tx, ty, tz),
        lightColor,
        hotspotAngle: hotspotAngle || undefined,
        falloffAngle: falloffAngle || undefined,
        castShadows: castShadows || undefined
      };
    }

    case 'MULTILEADER':
      return decodeMLeader(x, raw);

    case 'ACAD_TABLE':
      return decodeTable(x, raw);

    case 'PDFUNDERLAY':
    case 'DGNUNDERLAY':
    case 'DWFUNDERLAY': {
      const e: Entity = {
        type: 'underlay', layer: '0', color: { kind: 'byLayer' },
        underlayKind: typeName === 'PDFUNDERLAY' ? 'pdf'
          : typeName === 'DGNUNDERLAY' ? 'dgn' : 'dwf',
        position: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        rotation: 0
      };
      r.bd3();                            /* normal */
      const [ux, uy, uz] = r.bd3();
      e.position = pt3(ux, uy, uz);
      e.rotation = r.bd();
      e.scale = pt3(r.bd(), r.bd(), r.bd());
      e.flags = r.rc();
      e.contrast = r.rc();
      e.fade = r.rc();
      raw.underlayDefHandle = x.handle(raw.handle);
      const nverts = r.bl();
      if (nverts > 100000) throw new RangeError('underlay clip');
      const clip: Point2[] = [];
      for (let i = 0; i < nverts; i++) clip.push({ x: r.rd(), y: r.rd() });
      if (clip.length) e.clip = clip;
      return e;
    }

    case 'MESH': {
      /* a subdivision surface: control mesh, face list, creased edges */
      r.bs();                             /* record version */
      r.b();                              /* blend crease */
      const numSubdiv = r.bl();
      if (numSubdiv < 0 || numSubdiv > 4000000) throw new RangeError('mesh subdiv');
      for (let i = 0; i < numSubdiv; i++) r.bd3();
      const numVertex = r.bl();
      if (numVertex < 0 || numVertex > 4000000) throw new RangeError('mesh vertices');
      const vertices: Point3[] = [];
      for (let i = 0; i < numVertex; i++) {
        const [vx, vy, vz] = r.bd3();
        vertices.push(pt3(vx, vy, vz));
      }
      const faceListSize = r.bl();
      if (faceListSize < 0 || faceListSize > 8000000) throw new RangeError('mesh faces');
      const flat: number[] = [];
      for (let i = 0; i < faceListSize; i++) flat.push(r.bl());
      /* the list is a run of (count, index...) groups; our faces are
         one-based so every mesh flavour indexes the same way */
      const faces: number[][] = [];
      for (let i = 0; i < flat.length;) {
        const n = flat[i++];
        if (n <= 0 || i + n > flat.length) break;
        faces.push(flat.slice(i, i + n).map((idx) => idx + 1));
        i += n;
      }
      const numEdges = r.bl();
      if (numEdges < 0 || numEdges > 4000000) throw new RangeError('mesh edges');
      const edges: [number, number][] = [];
      for (let i = 0; i < numEdges; i++) edges.push([r.bl() + 1, r.bl() + 1]);
      const numCrease = r.bl();
      if (numCrease < 0 || numCrease > 4000000) throw new RangeError('mesh creases');
      const creases: { from: number; to: number; weight: number }[] = [];
      for (let i = 0; i < numCrease; i++) {
        const weight = r.bd();
        const edge = edges[i];
        if (edge && weight) creases.push({ from: edge[0], to: edge[1], weight });
      }
      const mesh: MeshEntity = {
        type: 'mesh', layer: '0', color: { kind: 'byLayer' },
        meshKind: 'subd', vertices
      };
      if (faces.length) mesh.faces = faces;
      if (numSubdiv) mesh.subdivisionLevel = numSubdiv;
      if (creases.length) mesh.creases = creases;
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
      const SURFACES: Record<string, AcisEntity['surfaceKind']> = {
        PLANESURFACE: 'plane', EXTRUDEDSURFACE: 'extruded',
        LOFTEDSURFACE: 'lofted', REVOLVEDSURFACE: 'revolved',
        SWEPTSURFACE: 'swept', NURBSURFACE: 'nurb'
      };
      const surfaceKind = SURFACES[typeName];
      const kind = surfaceKind ? 'surface'
        : typeName === 'REGION' ? 'region'
        : typeName === '3DSOLID' ? 'solid3d' : 'body';
      const e: Entity = {
        type: 'acis', layer: '0', color: { kind: 'byLayer' }, kind
      };
      if (surfaceKind) e.surfaceKind = surfaceKind;
      if (r.b() === 1) return e;          /* acis empty */
      r.b();                              /* unknown bit */
      const version = r.bs();
      if (version === 1) {
        /* SAT text blocks, ciphered with (159 - c) for c > 32 */
        let sat = '';
        for (;;) {
          const size = r.bl();
          if (size <= 0) break;
          if (size > 0x2000000) throw new RangeError('acis block');
          const block = r.bytes(size);
          for (const c of block) {
            sat += String.fromCharCode(c <= 32 ? c : 159 - c);
          }
        }
        e.sat = sat;
        return e;
      }
      /* version 2 (R2007+): SAB blob, delimited by the ACIS end marker.
         The blob does not always start on a byte boundary (R2004 files
         park it mid-bit), so find the signature at its true bit offset
         and lift the stream out shifted. */
      const limit = Math.min(r.data.length, (r.endBit + 7) >> 3);
      const lift = (fromBit: number): Uint8Array => {
        const o = fromBit >> 3, sh = fromBit & 7;
        const n = Math.max(0, limit - o);
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = sh === 0 ? r.data[o + i]
            : ((r.data[o + i] << sh) | ((r.data[o + i + 1] ?? 0) >> (8 - sh))) & 0xff;
        }
        return out;
      };
      const opens = (buf: Uint8Array, s: string): boolean => {
        for (let i = 0; i < s.length; i++) {
          if (buf[i] !== s.charCodeAt(i)) return false;
        }
        return true;
      };
      let bytes: Uint8Array | null = null;
      let foundBit = r.pos;
      for (let probe = 0; probe <= 64 && !bytes; probe++) {
        const cand = lift(r.pos + probe);
        if (opens(cand, 'ACIS BinaryFile') || opens(cand, 'ASM BinaryFile')) {
          bytes = cand;
          foundBit = r.pos + probe;
        }
      }
      if (!bytes) {
        r.align();
        foundBit = r.pos;
        bytes = r.data.subarray(r.pos >> 3, limit);
      }
      const marker = '\x0e\x03End\x0e\x02of\x0e\x04ACIS\r\x04data';
      const marker2 = '\x0e\x03End\x0e\x02of\x0e\x03ASM\r\x04data';
      let text = '';
      for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      let end = text.indexOf(marker);
      let mlen = marker.length;
      if (end === -1) { end = text.indexOf(marker2); mlen = marker2.length; }
      const size = end === -1 ? bytes.length : end + mlen;
      let b64 = '';
      const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      for (let i = 0; i < size; i += 3) {
        const a = bytes[i], b = bytes[i + 1], c2 = bytes[i + 2];
        b64 += CH[a >> 2] + CH[((a & 3) << 4) | ((b ?? 0) >> 4)]
          + (i + 1 < size ? CH[(((b ?? 0) & 15) << 2) | ((c2 ?? 0) >> 6)] : '=')
          + (i + 2 < size ? CH[(c2 ?? 0) & 63] : '=');
      }
      e.sab = b64;
      r.pos = foundBit + size * 8;
      return e;
    }

    case 'IMAGE':
    case 'WIPEOUT': {
      const classVersion = r.bl();
      if (classVersion > 10) throw new RangeError('image class version');
      const [ix, iy, iz] = r.bd3();
      const [ux, uy, uz] = r.bd3();
      const [wx, wy, wz] = r.bd3();
      const widthPx = r.rd(), heightPx = r.rd();
      raw.imageDefHandle = x.handle(raw.handle);
      r.bs();                             /* display props */
      const clipping = r.b() === 1;
      const brightness = r.rc(), contrast = r.rc(), fade = r.rc();
      x.hr.h();                           /* imagedef reactor */
      const clipInverted = v >= 2010 ? r.b() === 1 : false;
      const clipType = r.bs();
      let clip: Point2[] | undefined;
      const nClip = clipType === 1 ? 2 : r.bl();
      if (nClip <= 10000) {
        clip = [];
        for (let i = 0; i < nClip; i++) clip.push({ x: r.rd(), y: r.rd() });
      }
      return {
        type: 'image', layer: '0', color: { kind: 'byLayer' },
        wipeout: typeName === 'WIPEOUT' || undefined,
        position: pt3(ix, iy, iz),
        uVector: pt3(ux, uy, uz), vVector: pt3(wx, wy, wz),
        widthPx, heightPx,
        clip: clipping ? clip : undefined,
        clipInverted: clipInverted || undefined,
        brightness: brightness !== 50 ? brightness : undefined,
        contrast: contrast !== 50 ? contrast : undefined,
        fade: fade || undefined
      };
    }

    default:
      return {
        type: 'unknown', layer: '0', color: { kind: 'byLayer' },
        sourceType: typeName
      };
  }
};

const collectPolylineHandles = (
  x: Ctx, raw: RawObject, is3d: boolean, closed: boolean, numOwned: number
): NonNullable<RawObject['polyline']> => {
  const pl: NonNullable<RawObject['polyline']> = {
    is3d, closed, vertexHandles: []
  };
  if (x.v <= 2000) {
    pl.first = x.handle(raw.handle);
    pl.last = x.handle(raw.handle);
  } else {
    for (let i = 0; i < numOwned; i++) pl.vertexHandles.push(x.handle(raw.handle));
  }
  x.hr.h();                               /* seqend */
  return pl;
};

/** The header's 70 bits beyond closed, and its 75 curve type. */
const polylineFlags = (
  pl: NonNullable<RawObject['polyline']>, flag: number, curveType: number
): void => {
  if (flag & 2) pl.curveFit = true;
  if (flag & 4) pl.splineFit = true;
  if (flag & 128) pl.plineGen = true;
  if (curveType) pl.curveType = curveType;
};

/** MESH/PFACE vertex ownership: chain form (R13-R2000) or owned vector. */
const collectMeshHandles = (x: Ctx, raw: RawObject, numOwned: number): void => {
  if (x.v <= 2000) {
    x.hr.h(); x.hr.h();                   /* first/last vertex */
  } else if (numOwned < 100000) {
    for (let i = 0; i < numOwned; i++) {
      raw.mesh!.vertexHandles.push(x.handle(raw.handle));
    }
  }
  x.hr.h();                               /* seqend */
};

/* ---- DIMENSION_* ---- */

const DIM_KIND: Record<string, [DimensionKind, number]> = {
  DimRotated: ['linear', 0], DimAligned: ['aligned', 1],
  DimAngular2Line: ['angular2ln', 2], DimDiameter: ['diameter', 3],
  DimRadius: ['radius', 4], DimAngular3Point: ['angular3pt', 5],
  DimOrdinate: ['ordinate', 6], ARC_DIMENSION: ['arc', 0]
};

const decodeDimension = (
  x: Ctx, typeName: string, raw: RawObject
): DimensionEntity => {
  const { r, v } = x;
  const [kind, baseType] = DIM_KIND[typeName];
  if (v >= 2010) r.rc();                  /* class version */
  const dimExt = extrusionOf(r.bd3());
  const tmX = r.rd(), tmY = r.rd();       /* text midpoint (2RD) */
  const elevation = r.bd();
  const flag1 = r.rc();
  const text = x.text();
  const textRotation = r.bd();
  const horizDirection = r.bd();
  r.bd3();                                /* ins scale */
  r.bd();                                 /* ins rotation */
  let attachment: number | undefined;
  let lineSpacingStyle: number | undefined;
  let lineSpacingFactor: number | undefined;
  let measurement: number | undefined;
  if (v >= 2000) {
    attachment = r.bs();
    lineSpacingStyle = r.bs();
    lineSpacingFactor = r.bd();
    measurement = r.bd();
  }
  if (v >= 2007) { r.b(); r.b(); r.b(); } /* unknown, flip arrows */
  const ciX = r.rd(), ciY = r.rd();       /* clone insert point */

  /* DXF 70: base type | 32 (block ref, per flag1 bit 1) | 128 when the text
     is at a non-default position (inverse of flag1 bit 0). */
  const e: DimensionEntity = {
    type: 'dimension', layer: '0', color: { kind: 'byLayer' },
    kind,
    dimensionType: baseType | 32 | ((flag1 & 1) ? 0 : 128),
    definitionPoint: pt3(0, 0, 0),
    textMidpoint: pt3(tmX, tmY, elevation),
    elevation: elevation || undefined,
    text: text || undefined,
    textRotation: textRotation || undefined,
    horizDirection: horizDirection || undefined,
    attachment, lineSpacingStyle, lineSpacingFactor, measurement,
    ...(dimExt ? { extrusion: dimExt } : {})
  };
  if (ciX || ciY) e.insertionPoint = pt3(ciX, ciY, 0);

  const p3 = (): Point3 => { const [a, b, c] = r.bd3(); return pt3(a, b, c); };
  switch (typeName) {
    case 'DimOrdinate': {
      e.definitionPoint = p3();
      e.point13 = p3();
      e.point14 = p3();
      const flag2 = r.rc();
      if (flag2 & 1) e.dimensionType |= 64;
      break;
    }
    case 'DimRotated':
      e.point13 = p3();
      e.point14 = p3();
      e.definitionPoint = p3();
      e.obliqueAngle = r.bd() || undefined;
      e.rotation = r.bd() || undefined;
      break;
    case 'DimAligned':
      e.point13 = p3();
      e.point14 = p3();
      e.definitionPoint = p3();
      e.obliqueAngle = r.bd() || undefined;
      break;
    case 'DimAngular3Point':
      e.definitionPoint = p3();
      e.point13 = p3();
      e.point14 = p3();
      e.point15 = p3();
      break;
    case 'DimAngular2Line':
      /* stream order: 2RD arc point (DXF 16) first, def point (DXF 10)
         LAST — verified against the paired reference export */
      e.point16 = pt3(r.rd(), r.rd(), 0);
      e.point13 = p3();
      e.point14 = p3();
      e.point15 = p3();
      e.definitionPoint = p3();
      break;
    case 'DimRadius':
      e.definitionPoint = p3();
      e.point15 = p3();
      e.leaderLength = r.bd() || undefined;
      break;
    case 'DimDiameter':
      e.point15 = p3();
      e.definitionPoint = p3();
      e.leaderLength = r.bd() || undefined;
      break;
    case 'ARC_DIMENSION':
      e.definitionPoint = p3();
      e.point13 = p3();
      e.point14 = p3();
      e.point15 = p3();
      r.b();                              /* is partial */
      r.bd(); r.bd();                     /* arc start/end param */
      r.b();                              /* has leader */
      e.point16 = p3();
      p3();                               /* leader2 */
      break;
  }
  raw.dimStyleHandle = x.handle(raw.handle);
  raw.dimBlock = x.handle(raw.handle);    /* anonymous geometry block */
  return e;
};

/* ---- HATCH ---- */

const decodeHatch = (x: Ctx): Entity => {
  const { r, v } = x;
  let gradient: HatchGradient | undefined;
  if (v >= 2004) {
    const isGradient = r.bl();
    r.bl();                               /* reserved */
    const gAngle = r.bd();
    const gShift = r.bd();
    const gSingle = r.bl();
    const gTint = r.bd();
    const nColors = r.bl();
    if (isGradient && nColors > 1000) throw new RangeError('hatch colors');
    const colors: HatchGradient['colors'] = [];
    for (let i = 0; i < nColors && i <= 1000; i++) {
      const shift = r.bd();
      const { color } = x.cmc();
      colors.push({ shift, color });
    }
    const gName = x.text();
    if (isGradient) {
      gradient = {
        name: gName, angle: gAngle, shift: gShift, tint: gTint,
        singleColor: gSingle !== 0, colors
      };
    }
  }
  const elevation = r.bd();
  const hatchExt = extrusionOf(r.bd3());
  const name = x.text();
  const solid = r.b() === 1;
  const associative = r.b() === 1;
  const numPaths = r.bl();
  if (numPaths > 10000) throw new RangeError('hatch paths');
  const loops: HatchBoundary[] = [];
  let hasDerived = false;
  const boundaryHandleCounts: number[] = [];
  for (let i = 0; i < numPaths; i++) {
    const flag = r.bl();
    if (flag & 4) hasDerived = true;
    /* the loop-type bits beyond the structural polyline one: audit
       validates them (a style-1/2 hatch with no external loop is
       erased), so they are modeled and written back */
    const lf: HatchLoopFlags = {};
    if (flag & 1) lf.external = true;
    if (flag & 4) lf.derived = true;
    if (flag & 16) lf.outermost = true;
    if (!(flag & 2)) {
      /* edge path: exact segments, kept unsampled */
      const numSegs = r.bl();
      if (numSegs > 10000) throw new RangeError('hatch segs');
      const edges: HatchEdge[] = [];
      for (let s = 0; s < numSegs; s++) {
        const curveType = r.rc();
        if (curveType === 1) {
          edges.push({
            kind: 'line',
            start: { x: r.rd(), y: r.rd() }, end: { x: r.rd(), y: r.rd() }
          });
        } else if (curveType === 2) {
          edges.push({
            kind: 'arc', center: { x: r.rd(), y: r.rd() }, radius: r.bd(),
            startAngle: r.bd(), endAngle: r.bd(), ccw: r.b() === 1
          });
        } else if (curveType === 3) {
          edges.push({
            kind: 'ellipticalArc',
            center: { x: r.rd(), y: r.rd() },
            majorAxis: { x: r.rd(), y: r.rd() },
            ratio: r.bd(), startAngle: r.bd(), endAngle: r.bd(),
            ccw: r.b() === 1
          });
        } else if (curveType === 4) {
          const degree = r.bl();
          const rational = r.b() === 1;
          const periodic = r.b() === 1;
          const numKnots = r.bl();
          const numCtrl = r.bl();
          if (numKnots > 10000 || numCtrl > 10000) {
            throw new RangeError('hatch spline');
          }
          const knots: number[] = [];
          for (let k = 0; k < numKnots; k++) knots.push(r.bd());
          const controlPoints: Point2[] = [];
          const weights: number[] = [];
          for (let k = 0; k < numCtrl; k++) {
            controlPoints.push({ x: r.rd(), y: r.rd() });
            if (rational) weights.push(r.bd());
          }
          let fitPoints: Point2[] | undefined;
          if (v >= 2010) {
            const numFit = r.bl();
            if (numFit > 10000) throw new RangeError('hatch spline fit');
            if (numFit > 0) {
              fitPoints = [];
              for (let k = 0; k < numFit; k++) {
                fitPoints.push({ x: r.rd(), y: r.rd() });
              }
              r.rd(); r.rd();             /* start tangent */
              r.rd(); r.rd();             /* end tangent */
            }
          }
          edges.push({
            kind: 'spline', degree, periodic: periodic || undefined,
            knots, controlPoints,
            weights: rational ? weights : undefined, fitPoints
          });
        } else {
          throw new RangeError('hatch curve type');
        }
      }
      loops.push(Object.assign(simplifyEdgeLoop(edges), lf));
    } else {
      /* polyline path with real bulges */
      const bulges = r.b() === 1;
      const closed = r.b() === 1;
      const nVerts = r.bl();
      if (nVerts > 10000) throw new RangeError('hatch verts');
      const vertices: PolylineVertex[] = [];
      for (let k = 0; k < nVerts; k++) {
        const vert: PolylineVertex = { x: r.rd(), y: r.rd() };
        if (bulges) {
          const b = r.bd();
          if (b) vert.bulge = b;
        }
        vertices.push(vert);
      }
      loops.push({ kind: 'polyline', vertices, closed, ...lf });
    }
    const nBoundary = r.bl();
    if (nBoundary > 10000) throw new RangeError('hatch boundary handles');
    boundaryHandleCounts.push(nBoundary);
  }
  /* boundary handles live in the handle stream, in path order */
  for (let i = 0; i < loops.length; i++) {
    const n = boundaryHandleCounts[i] ?? 0;
    if (!n) continue;
    const hs: string[] = [];
    for (let j = 0; j < n; j++) {
      const h = x.hr.h();
      if (h.value) hs.push(h.value.toString(16).toUpperCase());
    }
    if (hs.length) loops[i].boundaryHandles = hs;
  }
  const styleFlag = r.bs();
  const patternType = r.bs();
  let angle = 0, scale = 1, doubled = false;
  let definitionLines: HatchDefLine[] | undefined;
  if (!solid) {
    angle = r.bd();
    scale = r.bd();
    doubled = r.b() === 1;
    const nDef = r.bs();
    if (nDef > 1000) throw new RangeError('hatch deflines');
    definitionLines = [];
    for (let i = 0; i < nDef; i++) {
      const dAngle = r.bd();
      const base = { x: r.bd(), y: r.bd() };
      const offset = { x: r.bd(), y: r.bd() };
      const nDash = r.bs();
      if (nDash > 1000) throw new RangeError('hatch dashes');
      const dashes: number[] = [];
      for (let k = 0; k < nDash; k++) dashes.push(r.bd());
      definitionLines.push({
        angle: dAngle * (180 / Math.PI), base, offset, dashes
      });
    }
  }
  const pixelSize = hasDerived ? r.bd() : undefined;
  const numSeeds = r.bl();
  let seeds: Point2[] | undefined;
  if (numSeeds > 0 && numSeeds <= 10000) {
    seeds = [];
    for (let i = 0; i < numSeeds; i++) seeds.push({ x: r.rd(), y: r.rd() });
  }
  return {
    type: 'hatch', layer: '0', color: { kind: 'byLayer' },
    patternName: name || (solid ? 'SOLID' : 'ANSI31'),
    solid,
    angle: angle * (180 / Math.PI),
    scale: scale > 0 ? scale : 1,
    loops,
    elevation: elevation || undefined,
    associative: associative || undefined,
    ...(hatchExt ? { extrusion: hatchExt } : {}),
    styleFlag: styleFlag || undefined,
    patternType,
    doubled: doubled || undefined,
    definitionLines: definitionLines?.length ? definitionLines : undefined,
    gradient,
    seeds,
    pixelSize
  };
};

/* ---- MULTILEADER ---- */

const decodeMLeader = (x: Ctx, raw: RawObject): Entity => {
  const { r, v } = x;
  const e: Entity = {
    type: 'mleader', layer: '0', color: { kind: 'byLayer' }, leaders: []
  };
  if (v >= 2010) r.bs();                  /* class version */
  /* In the binary record the leaders come first; the context block that
     an ASCII export prints up front is not stored here. */
  const numLeaders = r.bl();
  if (numLeaders > 10000) throw new RangeError('mleader leaders');
  for (let i = 0; i < numLeaders; i++) {
    const leader: NonNullable<Extract<Entity, { type: 'mleader' }>['leaders']>[number] = {
      lines: []
    };
    const hasLanding = r.b() === 1;
    const hasDogleg = r.b() === 1;
    if (hasLanding) {
      const [ax, ay, az] = r.bd3();
      leader.landing = pt3(ax, ay, az);
    }
    if (hasDogleg) {
      const [dx2, dy2, dz2] = r.bd3();
      leader.doglegVector = pt3(dx2, dy2, dz2);
    }
    const numBreaks = r.bl();
    if (numBreaks > 10000) throw new RangeError('mleader breaks');
    for (let k = 0; k < numBreaks; k++) { r.bd3(); r.bd3(); }
    r.bl();                               /* branch index */
    leader.doglegLength = r.bd() || undefined;
    const numLines = r.bl();
    if (numLines > 10000) throw new RangeError('mleader lines');
    for (let k = 0; k < numLines; k++) {
      const numPts = r.bl();
      if (numPts > 100000) throw new RangeError('mleader points');
      const pts: Point3[] = [];
      for (let j = 0; j < numPts; j++) {
        const [lx, ly, lz] = r.bd3();
        pts.push(pt3(lx, ly, lz));
      }
      const nb = r.bl();
      if (nb > 10000) throw new RangeError('mleader line breaks');
      for (let j = 0; j < nb; j++) { r.bd3(); r.bd3(); }
      r.bl();                             /* line index */
      if (v >= 2010) {
        r.bs();                           /* line type */
        x.cmc();                          /* line colour */
        x.hr.h();                         /* linetype */
        r.bl();                           /* line weight */
        r.bd();                           /* arrow size */
        x.hr.h();                         /* arrow symbol */
        r.bl();                           /* flags */
      }
      if (pts.length) leader.lines.push(pts);
    }
    if (v >= 2010) r.bs();                /* attach dir */
    e.leaders.push(leader);
  }

  /* --- context data (binary layout: after the leaders) --- */
  e.scale = r.bd() || undefined;
  r.bd3();                                /* content base */
  const textHeight = r.bd();
  e.arrowSize = r.bd() || undefined;
  r.bd();                                 /* landing gap */
  r.bs(); r.bs(); r.bs(); r.bs();         /* text left/right/angle/alignment */
  if (r.b() === 1) {
    e.text = x.text() || undefined;
    r.bd3();                              /* normal */
    x.hr.h();                             /* text style */
    const [lx, ly, lz] = r.bd3();
    e.textPosition = pt3(lx, ly, lz);
    r.bd3();                              /* direction */
    e.textRotation = r.bd() || undefined;
    r.bd(); r.bd();                       /* width, height */
    r.bd(); r.bs();                       /* line spacing factor + style */
    x.cmc();                              /* colour */
    r.bs(); r.bs();                       /* alignment, flow */
    x.cmc();                              /* background colour */
    r.bd(); r.bl();                       /* bg scale, transparency */
    r.b(); r.b();                         /* bg fill flags */
    r.bs();                               /* column type */
    r.b();                                /* auto height */
    r.bd(); r.bd();                       /* column width, gutter */
    r.b();                                /* flow reversed */
    const numCols = r.bl();
    if (numCols > 10000) throw new RangeError('mleader columns');
    for (let i = 0; i < numCols; i++) r.bd();
    r.b(); r.b();                         /* word break, unknown */
    e.textHeight = textHeight || undefined;
  } else if (r.b() === 1) {
    raw.mleaderBlock = x.handle(raw.handle);
    r.bd3();                              /* normal */
    const [bx, by, bz] = r.bd3();
    e.blockPosition = pt3(bx, by, bz);
    const [sx, sy, sz] = r.bd3();
    e.blockScale = pt3(sx, sy, sz);
    e.blockRotation = r.bd() || undefined;
    x.cmc();                              /* colour */
    for (let i = 0; i < 16; i++) r.bd();  /* transform matrix */
  }
  r.bd3(); r.bd3(); r.bd3();              /* base, base dir, base vert */
  r.b();                                  /* normal reversed */
  if (v >= 2010) { r.bs(); r.bs(); }      /* text top/bottom */

  raw.mleaderStyle = x.handle(raw.handle);
  r.bl();                                 /* override flags */
  r.bs();                                 /* type */
  x.cmc();                                /* line colour */
  x.hr.h();                               /* line linetype */
  r.bl();                                 /* line weight */
  e.hasLanding = r.b() === 1 || undefined;
  e.hasDogleg = r.b() === 1 || undefined;
  r.bd();                                 /* landing distance */
  x.hr.h();                               /* arrow handle */
  const arrow = r.bd();
  if (arrow) e.arrowSize = arrow;
  /* The rest of the common data, bit-walked against the reference's own
     saves of its multileader sample at 2000, 2004, 2007, 2010, 2013 and
     2018 (every record lands on its last data bit with every handle and
     string consumed): content type, text style, the four text attachment
     shorts, text colour, frame flag, block record, block colour, scale,
     rotation, connection type, annotative flag; before R2010 a list of
     arrowheads (B is-default + H); then the block labels — BL count, and
     per label H attdef, TV text, BS index, BD width — the text-direction
     bit, the IPE alignment and attachment-point shorts, two bits the
     reference closes every release with (0, 1), and from R2010 the three
     attachment-direction shorts (and R2013's trailing flag). R2010+ has
     NO arrowhead list. The labels are the point: a block-content note's
     attribute values live here and nowhere else. A malformed tail keeps
     the leaders and content already decoded. */
  try {
    r.bs();                               /* content type */
    x.hr.h();                             /* text style */
    r.bs(); r.bs(); r.bs(); r.bs();       /* text left/right/angle/align */
    x.cmc();                              /* text colour */
    r.b();                                /* frame text */
    x.hr.h();                             /* block content */
    x.cmc();                              /* block colour */
    r.bd3();                              /* block scale */
    r.bd();                               /* block rotation */
    r.bs();                               /* block connection */
    r.b();                                /* annotative */
    if (v < 2010) {
      const numArrows = r.bl();
      if (numArrows > 10000) throw new RangeError('mleader arrowheads');
      for (let i = 0; i < numArrows; i++) { r.b(); x.hr.h(); }
    }
    const numLabels = r.bl();
    if (numLabels > 10000) throw new RangeError('mleader labels');
    const labels: MLeaderAttribute[] = [];
    for (let i = 0; i < numLabels; i++) {
      const attdef = x.handle(raw.handle);
      const text = x.text();
      const index = r.bs();
      const width = r.bd();
      const label: MLeaderAttribute = { index, text };
      if (attdef) label.attdef = attdef.toString(16).toUpperCase();
      if (width) label.width = width;
      labels.push(label);
    }
    if (labels.length) e.attributes = labels;
  } catch {
    /* the tail is informative only; the note itself is complete */
  }
  return e;
};

/* ---- ACAD_TABLE ---- */

/** The typed value a table cell (or a custom data item) carries. Read for
 *  alignment; the display text is already in the cell itself. */
/** Strings inside a table value are byte-counted UTF-16 in the data stream
 *  itself, not entries in the record's string stream. */
const readTableString = (x: Ctx): string => {
  const { r, v } = x;
  if (v < 2007) return x.text();
  const size = r.bs();                    /* bytes, terminator included */
  if (size <= 0 || size > 0x100000) return '';
  const bytes = r.bytes(size);
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (!code) break;
    out += String.fromCharCode(code);
  }
  return decodeCadText(out);
};

/** A "general" (type 512) value's blob, when it is what the reference's
 *  pre-2010 cells put there: the cell text itself as NUL-terminated UTF-16.
 *  Anything that does not read as text stays opaque. */
const utf16Blob = (bytes: Uint8Array): string | undefined => {
  if (bytes.length < 2 || bytes.length & 1) return undefined;
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (!code) {
      /* only NUL padding may follow the terminator */
      for (let k = i; k < bytes.length; k++) if (bytes[k]) return undefined;
      break;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return undefined;
    out += String.fromCharCode(code);
  }
  return decodeCadText(out);
};

/** A table VALUE. `cellForm` is the pre-2010 cell's spelling, which always
 *  carries both string-stream entries (format string, rendered text) —
 *  verified on the reference's own AC1021 tables, original and re-saved. */
const readTableValue = (x: Ctx, cellForm = false): string | undefined => {
  const { r, v } = x;
  let text: string | undefined;
  let formatFlags = 0;
  if (v >= 2007) formatFlags = r.bl();
  const dataType = r.bl();
  /* bit 0 of the format flags means the value itself is not stored */
  if (!(v >= 2007 && (formatFlags & 1))) {
    switch (dataType) {
      case 0: case 1: r.bl(); break;      /* long */
      case 2: r.bd(); break;              /* double */
      case 4: text = readTableString(x); break;   /* string */
      case 8: {                           /* date */
        const size = r.bl();
        if (size < 0 || size > 0x1000000) throw new RangeError('table date');
        r.bytes(size);
        break;
      }
      case 16: r.bl(); r.rd(); r.rd(); break;              /* 2d point */
      case 32: r.bl(); r.rd(); r.rd(); r.rd(); break;      /* 3d point */
      case 64: x.hr.h(); break;           /* object id */
      case 128: case 256: break;          /* buffer / resbuf: nothing */
      case 512: {                         /* general: a blob — the cell text
                                             as UTF-16 in the reference's
                                             pre-2010 cells, whose rendered
                                             string-stream entry is empty */
        if (v < 2007) break;
        const size = r.bl();
        if (size < 0 || size > 0x1000000) throw new RangeError('table blob');
        text = utf16Blob(r.bytes(size));
        break;
      }
      default: throw new RangeError('table value type ' + dataType);
    }
  }
  if (v >= 2007) {
    const unitType = r.bl();
    x.text();                             /* format string */
    /* the rendered form — what a viewer shows for numbers and dates */
    if (cellForm || unitType !== 12) {
      const shown = x.text();
      if (!text && shown) text = shown;
    }
  }
  return text || undefined;
};

/* ---- the dynamic-block parameter prologue ---- */

/** Every block parameter opens with an evaluation expression whose value
 *  slot is typed by a code. */
const readEvalExpr = (x: Ctx): void => {
  const { r } = x;
  r.bl();                                 /* parent node id */
  r.bl(); r.bl();                         /* version pair */
  const valueCode = r.bs();
  const code = (valueCode << 16) >> 16;   /* signed */
  switch (code) {
    case 40: r.bd(); break;
    case 10: case 11: r.rd(); r.rd(); break;
    case 1: x.text(); break;
    case 90: r.bl(); break;
    case 91: x.hr.h(); break;
    case 70: r.bs(); break;
    default: break;                       /* -9999: no value */
  }
  r.bl();                                 /* node id */
};

/** A parameter's property connections: a count, then (code, name) pairs. */
const readBlockPropInfo = (x: Ctx): void => {
  const { r } = x;
  const count = r.bl();
  if (count < 0 || count > 100000) throw new RangeError('block prop info');
  for (let i = 0; i < count; i++) { r.bl(); x.text(); }
};

/* ---- R2010+ ACAD_TABLE: the linked TABLECONTENT structure ---- */

/** A CMC's colour, with the "no colour" method (0xC8, what an unfilled
 *  cell's background carries) told apart from a real one. */
const cmcOrNone = (x: Ctx): Color | undefined => {
  const { r } = x;
  const pos = r.pos;
  r.bs();
  const method = (r.bl() >>> 24) & 0xff;
  r.pos = pos;
  const c = x.cmc(true).color;
  return method === 0xc8 ? undefined : c;
};

/** Formatting attached to a cell, column or row — the R2010+ content
 *  format. `override` carries the format's own override flags (0x40 = text
 *  style, 0x01/0x02 = value data/unit type, pinned against the reference's
 *  2018 saves of its samples); the rest is what the format states. */
interface ContentFormatData {
  override: number;
  rotation: number;
  alignment: number;
  color?: Color;
  textStyle: number;
  textHeight: number;
}
const readContentFormat = (x: Ctx): ContentFormatData => {
  const { r } = x;
  const override = r.bl();
  r.bl();                                 /* property flags */
  r.bl(); r.bl();                         /* value data type and unit type */
  x.text();                               /* value format string */
  const rotation = r.bd();
  r.bd();                                 /* block scale */
  const alignment = r.bl();
  const color = cmcOrNone(x);
  const textStyle = x.handle(0);
  const textHeight = r.bd();
  return { override, rotation, alignment, color, textStyle, textHeight };
};

/** One overridden grid line of an R2010+ cell style: `mask` names the
 *  edge (1 top, 2 right, 4 bottom, 8 left, 16/32 the inside lines) and
 *  `override` what the cell states for it (0x02 lineweight, 0x08 colour,
 *  0x10 invisibility — the reference writes 0x1A for an edge set through
 *  its dialog). */
interface CellBorderData {
  mask: number; override: number;
  color?: Color; lineweight: number; invisible: boolean;
}
/** An R2010+ cell style's data, when the record carries any. */
interface CellStyleData {
  propOverride: number;
  background?: Color;
  format: ContentFormatData;
  margins?: number[];
  borders: CellBorderData[];
}
/** Bit-walked against the reference's 2018 saves: an aligned cell sets
 *  0x10 in the property override flags and states the alignment in its
 *  own content format; a text-style override shows as 0x40 in the
 *  content's format flags with the style handle in the cell style's
 *  format; an edge override is a border entry with its mask and flags. */
const readCellStyle = (x: Ctx): CellStyleData | undefined => {
  const { r } = x;
  r.bl();                                 /* style type */
  if (!r.bs()) return undefined;          /* no overrides: nothing follows */
  const propOverride = r.bl();
  r.bl();                                 /* merge flags */
  const background = cmcOrNone(x);
  r.bl();                                 /* content layout */
  const format = readContentFormat(x);
  let margins: number[] | undefined;
  if (r.bs()) {
    margins = [];
    for (let i = 0; i < 6; i++) margins.push(r.bd());
  }
  const numBorders = r.bl();
  if (numBorders > 6) throw new RangeError('table cell borders');
  const borders: CellBorderData[] = [];
  for (let i = 0; i < numBorders; i++) {
    const mask = r.bl();
    if (!mask) continue;                  /* index mask */
    const override = r.bl();
    r.bl();                               /* border type */
    const color = cmcOrNone(x);
    const lineweight = r.bl();
    x.hr.h();                             /* linetype */
    const invisible = r.bl() !== 0;
    r.bd();                               /* double line spacing */
    borders.push({ mask, override, color, lineweight, invisible });
  }
  return { propOverride, background, format, margins, borders };
};

/** What an R2010+ cell style says about its cell, in model terms. The
 *  content format flags (`contentOverride`) come from the cell's content
 *  when it carries a format of its own. Returns the text-style handle to
 *  resolve, when the cell overrides it. */
const applyCellStyle = (
  cell: TableCell, style: CellStyleData, content: ContentFormatData | undefined
): number | undefined => {
  const f = style.format;
  /* the cell style: 0x10 alignment (its format's value), 0x200 the
     background colour; the content's own format: 0x04 rotation, 0x20
     colour, 0x80 text height, each with the value beside the flag —
     bit-walked on the reference's 2018 conversion of this library's
     R2000 fixture carrying every override at once */
  if (style.propOverride & 0x10) cell.alignment = f.alignment;
  if (style.propOverride & 0x200 && style.background) cell.fillColor = style.background;
  if (content) {
    if (content.override & 0x04 && content.rotation) cell.rotation = content.rotation;
    if (content.override & 0x20 && content.color) cell.textColor = content.color;
    if (content.override & 0x80 && content.textHeight > 0) cell.textHeight = content.textHeight;
  }
  for (const b of style.borders) {
    if (!b.override) continue;
    const edge: TableBorder = {};
    if (b.override & 0x08 && b.color) edge.color = b.color;
    if (b.override & 0x02) edge.lineweight = b.lineweight;
    if (b.override & 0x10) edge.visible = !b.invisible;
    if (!Object.keys(edge).length) continue;
    const key = b.mask === 1 ? 'top' : b.mask === 2 ? 'right'
      : b.mask === 4 ? 'bottom' : b.mask === 8 ? 'left' : undefined;
    if (!key) continue;
    (cell.borders ??= {})[key] = edge;
  }
  if (content && content.override & 0x40) {
    return content.textStyle || f.textStyle || undefined;
  }
  return undefined;
};

/** Named values a cell, column or row may carry beside its content. */
const readCustomData = (x: Ctx): void => {
  const { r } = x;
  const count = r.bl();
  if (count > 10000) throw new RangeError('table custom data');
  for (let i = 0; i < count; i++) { x.text(); readTableValue(x); }
};

interface TableGrid {
  numRows: number; numColumns: number;
  rowHeights: number[]; columnWidths: number[]; cells: TableCell[];
  /** Horizontal direction vector; only the R2010+ entity's inline tail
   *  carries it. */
  direction?: Point3;
  /** Title/header rows absent from the row styles (ids 1 and 2). */
  titleSuppressed?: boolean;
  headerSuppressed?: boolean;
  /** Handles the assembler resolves, by cell index: block records of
   *  block cells, text styles of cells overriding theirs. */
  cellBlocks?: Map<number, number>;
  cellTextStyles?: Map<number, number>;
}

/** The linked-table structure R2010 introduced, shared by the ACAD_TABLE
 *  entity and the TABLECONTENT object it may point at. */
const readTableContent = (x: Ctx, entityTail = false): TableGrid => {
  const { r } = x;
  x.text();                               /* linked data name */
  x.text();                               /* description */

  const numColumns = r.bl();
  if (numColumns > 10000) throw new RangeError('table columns');
  const columnWidths: number[] = [];
  for (let c = 0; c < numColumns; c++) {
    x.text();                             /* column name */
    r.bl();                               /* custom data flag */
    readCustomData(x);
    readCellStyle(x);
    r.bl();                               /* style id */
    columnWidths.push(r.bd());
  }

  const numRows = r.bl();
  if (numRows > 100000) throw new RangeError('table rows');
  if (numRows * numColumns > 200000) throw new RangeError('table size');
  const rowHeights: number[] = [];
  const cells: TableCell[] = [];
  const cellBlocks = new Map<number, number>();
  const cellTextStyles = new Map<number, number>();
  const rowStyleIds: number[] = [];
  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    const numCells = r.bl();
    if (numCells > 10000) throw new RangeError('table row cells');
    for (let colIdx = 0; colIdx < numCells; colIdx++) {
      const cell: TableCell = {};
      const cellIndex = rowIdx * numColumns + colIdx;
      r.bl();                             /* cell flag */
      x.text();                           /* tooltip */
      r.bl();                             /* custom data flag */
      readCustomData(x);
      if (r.bl()) {                       /* linked to an external source */
        x.hr.h();
        r.bl(); r.bl(); r.bl();
      }
      const numContents = r.bl();
      if (numContents > 10000) throw new RangeError('table cell contents');
      let content: ContentFormatData | undefined;
      for (let k = 0; k < numContents; k++) {
        const contentType = r.bl();
        let blockRef: number | undefined;
        if (contentType === 1) {
          const text = readTableValue(x);
          if (text && !cell.text) cell.text = text;
          cell.contentType = 1;
        } else if (contentType === 2 || contentType === 4) {
          /* the reference writes a block's record handle AFTER the content
             format's (walked against its 2018 saves: the format's text
             style is a soft null, the block a hard pointer) */
          blockRef = -1;
          cell.contentType = contentType === 4 ? 2 : 1;
        }
        const numAttrs = r.bl();
        if (numAttrs > 10000) throw new RangeError('table cell attributes');
        const attrs: NonNullable<TableCell['attributes']> = [];
        for (let a = 0; a < numAttrs; a++) {
          const text = x.text();
          const index = r.bl();
          attrs.push({ index, text });
        }
        if (r.bs()) {
          const cf = readContentFormat(x);
          content = content ? { ...cf, override: content.override | cf.override } : cf;
        }
        /* the handle stream, in the reference's order (walked on its 2018
           save of a schedule of attributed block cells): the content
           format's text style, then the block record, then one ATTDEF per
           attribute value */
        if (blockRef !== undefined) {
          const h = x.handle(0);
          if (contentType === 4 && h) cellBlocks.set(cellIndex, h);
        }
        for (const a of attrs) {
          const attdef = x.handle(0);
          if (attdef) a.attdef = attdef.toString(16).toUpperCase();
        }
        if (attrs.length) cell.attributes = attrs;
      }
      const style = readCellStyle(x);     /* the cell's own formatting */
      if (style) {
        const sh = applyCellStyle(cell, style, content);
        if (sh) cellTextStyles.set(cellIndex, sh);
      }
      r.bl();                             /* style id */
      if (r.bl()) {                       /* cell geometry */
        r.bl();                           /* geometry flag */
        r.bd(); r.bd();                   /* width and height including gap */
        const numGeometry = r.bl();
        if (numGeometry > 10000) throw new RangeError('table cell geometry');
        x.hr.h();                         /* table geometry object */
        for (let g = 0; g < numGeometry; g++) {
          r.bd3(); r.bd3();               /* distances to corner and centre */
          r.bd(); r.bd();                 /* content width and height */
          r.bd(); r.bd();                 /* cell width and height */
          r.bl();
        }
      }
      cells.push(cell);
    }
    /* keep the grid rectangular when a row stores fewer cells */
    for (let pad = numCells; pad < numColumns; pad++) cells.push({});
    r.bl();                               /* row custom data flag */
    readCustomData(x);
    readCellStyle(x);
    rowStyleIds.push(r.bl());             /* style id: 1 title, 2 header, 3 data */
    rowHeights.push(r.bd());              /* row height */
  }

  /* The grid is complete here; what follows is informative, so a short
     read there must not cost the table. After the field references comes
     a cell style for the table as a whole (style type 4 — the "4, 0"
     pair the reference's tables without one show), then the merge list,
     and in the entity's inline copy (entityTail) an unknown long (6, or
     38), the horizontal direction vector and the break data. Walked to
     the last bit against the reference's 2018 saves of five tables
     carrying 1 to 13 merged ranges. */
  let direction: Point3 | undefined;
  try {
    const numFieldRefs = r.bl();
    if (numFieldRefs > 100000) throw new RangeError('table field refs');
    for (let i = 0; i < numFieldRefs; i++) x.hr.h();
    readCellStyle(x);                     /* the table's own style */
    const numMerged = r.bl();
    if (numMerged > 100000) throw new RangeError('table merges');
    for (let i = 0; i < numMerged; i++) {
      const topRow = r.bl(), leftCol = r.bl();
      const bottomRow = r.bl(), rightCol = r.bl();
      const cell = cells[topRow * numColumns + leftCol];
      if (cell) {
        if (rightCol > leftCol) cell.spanColumns = rightCol - leftCol + 1;
        if (bottomRow > topRow) cell.spanRows = bottomRow - topRow + 1;
        for (let rr = topRow; rr <= bottomRow; rr++) {
          for (let cc = leftCol; cc <= rightCol; cc++) {
            const covered = cells[rr * numColumns + cc];
            if (covered && covered !== cell) covered.merged = true;
          }
        }
      }
    }
    if (entityTail) {
      r.bl();                             /* unknown, 6 in real files */
      const [hx, hy, hz] = r.bd3();
      if (isFinite(hx) && isFinite(hy) && isFinite(hz) && (hx || hy || hz)) {
        direction = pt3(hx, hy, hz);
      }
      /* break data follows; nothing the model carries */
    }
  } catch { /* the grid stands on its own */ }
  const grid: TableGrid = { numRows, numColumns, rowHeights, columnWidths, cells };
  if (direction) grid.direction = direction;   /* keep spreads clobber-safe */
  /* a suppressed title or header row simply has no row of its style */
  if (rowStyleIds.length && !rowStyleIds.includes(1)) grid.titleSuppressed = true;
  if (rowStyleIds.length > 1 && !rowStyleIds.includes(2)) grid.headerSuppressed = true;
  if (cellBlocks.size) grid.cellBlocks = cellBlocks;
  if (cellTextStyles.size) grid.cellTextStyles = cellTextStyles;
  return grid;
};

const decodeTable = (x: Ctx, raw: RawObject): Entity => {
  const { r, v } = x;
  if (v >= 2010) {
    /* R2010 dropped the pre-2010 grid record. AutoCAD's own files fold
       the complete TABLECONTENT structure into the entity itself, behind
       a block-reference prologue and twelve constant bits (solved against
       five AutoCAD-2027-minted 2018 tables: content found at prologue+12
       in every one, grid, merges and tail landing exactly). Other
       producers write only the placement here and hang the grid on a
       separate TABLECONTENT object, so a failed inline parse rewinds to
       the placement stub and the assembly step joins the pair. */
    const [tx, ty, tz] = r.bd3();
    const dpos = r.pos, hpos = x.hr.pos, spos = x.sr?.pos;
    try {
      const sf = r.bb();
      if (sf === 1) { r.dd(1); r.dd(1); }
      else if (sf === 2) { r.rd(); }
      else if (sf !== 3) { const sx = r.rd(); r.dd(sx); r.dd(sx); }
      r.bd();                             /* rotation */
      const tblExt = extrusionOf(r.bd3());
      const hasAttribs = r.b() === 1;
      let numOwned = 0;
      if (hasAttribs) numOwned = r.bl();
      /* twelve constant bits at R2013+ (00000000 10 10), eleven at R2010
         (00000000 10 1) — bit-identical prologues otherwise across the
         same drawing saved to 2010, 2013 and 2018 */
      r.rc(); r.bl();
      if (v >= 2013) r.bl(); else r.b();
      raw.tableBlock = x.handle(raw.handle);   /* geometry block header */
      if (hasAttribs) {
        for (let i = 0; i < numOwned && i < 100000; i++) x.hr.h();
        x.hr.h();                         /* seqend */
      }
      const grid = readTableContent(x, true);
      if (grid.numRows <= 0 || grid.numColumns <= 0
          || r.pos > x.dataEnd) throw new RangeError('table inline grid');
      if (grid.cellBlocks) raw.tableCellBlocks = grid.cellBlocks;
      if (grid.cellTextStyles) raw.tableCellTextStyles = grid.cellTextStyles;
      /* the TABLESTYLE is the last hard pointer of the handle stream,
         behind the per-cell geometry and one soft pointer */
      while (x.hr.pos + 8 <= x.hr.endBit) {
        const ref = x.hr.h();
        if (ref.code === 5 && ref.value) raw.tableStyle = ref.value;
      }
      return {
        type: 'table', layer: '0', color: { kind: 'byLayer' },
        position: pt3(tx, ty, tz),
        direction: grid.direction ?? pt3(1, 0, 0),
        numRows: grid.numRows, numColumns: grid.numColumns,
        rowHeights: grid.rowHeights, columnWidths: grid.columnWidths,
        cells: grid.cells,
        ...(grid.titleSuppressed ? { titleSuppressed: true } : {}),
        ...(grid.headerSuppressed ? { headerSuppressed: true } : {}),
        ...(tblExt ? { extrusion: tblExt } : {})
      };
    } catch {
      r.pos = dpos;
      x.hr.pos = hpos;
      if (x.sr && spos !== undefined) x.sr.pos = spos;
    }
    return {
      type: 'table', layer: '0', color: { kind: 'byLayer' },
      position: pt3(tx, ty, tz),
      direction: pt3(1, 0, 0),
      numRows: 0, numColumns: 0,
      rowHeights: [], columnWidths: [], cells: []
    };
  }
  /* AcDbBlockReference part */
  const [ix, iy, iz] = r.bd3();
  const sf = r.bb();
  if (sf === 3) { /* all 1.0 */ }
  else if (sf === 1) { r.dd(1); r.dd(1); }
  else if (sf === 2) { r.rd(); }
  else { const sx = r.rd(); r.dd(sx); r.dd(sx); }
  r.bd();                                 /* rotation */
  const tblExtOld = extrusionOf(r.bd3());
  const hasAttribs = r.b() === 1;
  let numOwned = 0;
  if (v >= 2004 && hasAttribs) numOwned = r.bl();
  raw.tableBlock = x.handle(raw.handle);  /* block header */
  if (hasAttribs) {
    if (v <= 2000) { x.hr.h(); x.hr.h(); }
    else for (let i = 0; i < numOwned && i < 100000; i++) x.hr.h();
    x.hr.h();                             /* seqend */
  }
  /* AcDbTable part */
  raw.tableStyle = x.handle(raw.handle);  /* table style */
  r.bs();                                 /* flag for table value */
  const [dx2, dy2, dz2] = r.bd3();
  const numColumns = r.bl();
  const numRows = r.bl();
  if (numColumns > 10000 || numRows > 100000) throw new RangeError('table size');
  const columnWidths: number[] = [];
  for (let i = 0; i < numColumns; i++) columnWidths.push(r.bd());
  const rowHeights: number[] = [];
  for (let i = 0; i < numRows; i++) rowHeights.push(r.bd());

  const cells: TableCell[] = [];
  const total = numColumns * numRows;
  if (total > 200000) throw new RangeError('table cells');
  const cellBlocks = new Map<number, number>();
  const cellTextStyles = new Map<number, number>();
  /* The pre-2010 cell, verified bit-exact against the reference's own
     tables — a 32x12 schedule, a 28x14 one with a block cell, a 7x8 legend
     and two 17x2 / 16x2 block-and-text grids, each saved by it to 2000,
     2004 and 2007 (the 2007 ones by two different releases of it): every
     record walks to its last data bit with every handle and every string
     consumed.

       BS type (1 text, 2 block), RC flags, B merged, B autofit,
       BL merged width, BL merged height, BD rotation
       text:  H text style; before 2007 the text itself (TV)
       block: H block record, BD scale, B has attributes,
              [BS count, per attribute: H attdef, BS index, TV value]
       B has overrides, [BL flags, RC virtual edge, then per flag bit:
              0x01 BS alignment, 0x02 B fill none, 0x04/0x08 CMC background
              and content colour (the R2004 spelling in every release),
              0x10 H text style, 0x20 BD text height, and the four grid
              edges' CMC colour / BS lineweight / BS visibility]
       R2007: BL extended cell flags (0), then the cell VALUE — BL format
              flags, BL data type, the data (a "general" 512 blob is the
              text as UTF-16; a 4 string is byte-counted UTF-16), BL unit
              type, and the format string and rendered text in the string
              stream.

     Two earlier misreadings are what had sealed these tables: the block
     cell's attribute flag was taken for its override flag (so a block cell
     with overrides skipped straight into them as attributes), and the
     R2007 value was placed ahead of the overrides. `legacy` is the spelling
     nasjidwg's own 2007 writer used before the value was understood (the
     text as a single string-stream entry, then the override flag); files
     written that way still open. */
  const readCell = (index: number, legacy: boolean): TableCell => {
    const cell: TableCell = {};
    const type = r.bs();
    if (type !== 1 && type !== 2) throw new RangeError('table cell type');
    cell.contentType = type;
    r.rc();                               /* flags: the edges overridden
                                             below (1 top, 2 right, 4
                                             bottom, 8 left) */
    if (r.b()) cell.merged = true;
    if (r.b()) cell.autofit = true;
    const spanCols = r.bl();
    const spanRows = r.bl();
    if (spanCols > 1) cell.spanColumns = spanCols;
    if (spanRows > 1) cell.spanRows = spanRows;
    const rotation = r.bd();
    if (rotation) cell.rotation = rotation;
    if (type === 1) {
      x.hr.h();                           /* text style */
      if (v < 2007 || legacy) cell.text = x.text() || undefined;
    } else {
      cellBlocks.set(index, x.handle(raw.handle));   /* block record */
      r.bd();                             /* block scale */
      if (r.b()) {                        /* attribute values follow */
        const numAttrs = r.bs();
        if (numAttrs > 10000) throw new RangeError('table attrs');
        const attrs: NonNullable<TableCell['attributes']> = [];
        for (let k = 0; k < numAttrs; k++) {
          const attdef = x.handle(raw.handle);
          const attIndex = r.bs();
          const text = x.text();
          attrs.push({ attdef: attdef.toString(16).toUpperCase(), index: attIndex, text });
        }
        if (attrs.length) cell.attributes = attrs;
      }
    }
    if (r.b()) {                          /* per-cell overrides */
      const flags = r.bl();
      r.rc();                             /* virtual edge */
      if (flags & 0x01) cell.alignment = r.bs();
      if (flags & 0x02) cell.fillEnabled = r.b() === 0;   /* "fill none" */
      if (flags & 0x04) cell.fillColor = x.cmc(true).color;
      if (flags & 0x08) cell.textColor = x.cmc(true).color;
      if (flags & 0x10) {
        const sh = x.handle(raw.handle);
        if (sh) cellTextStyles.set(index, sh);
      }
      if (flags & 0x20) cell.textHeight = r.bd();
      /* the grid colour/weight/visibility groups, in the spec's order:
         top, right, bottom, left — the DXF 69/65/66/68, 279/275/276/278
         and 289/285/286/288 groups of the reference's own R2000 export
         (pinned on its Text-and-Tables sample: 0x2200 spells left,
         0x4440 top). The visibility short is an invisibility flag: the
         reference's Standard style writes 0 for its visible borders. */
      const edges: ('top' | 'right' | 'bottom' | 'left')[] = ['top', 'right', 'bottom', 'left'];
      edges.forEach((edge, i) => {
        const colourBit = 0x40 << i, lwBit = 0x400 << i, visBit = 0x4000 << i;
        if (!(flags & (colourBit | lwBit | visBit))) return;
        const b: TableBorder = {};
        if (flags & colourBit) b.color = x.cmc(true).color;
        if (flags & lwBit) b.lineweight = r.bs();
        if (flags & visBit) b.visible = r.bs() === 0;
        (cell.borders ??= {})[edge] = b;
      });
    }
    if (v >= 2007 && !legacy) {
      r.bl();                             /* extended cell flags */
      const text = readTableValue(x, true);
      if (text) cell.text = text;
    }
    return cell;
  };
  /* What closes the record: four override groups, each a presence bit and
     — when set — a flag long with one field per bit. The table group's
     0x01 (title suppressed) carries a B and 0x02 (header suppressed) is
     the flag bit alone; both pinned against the reference (flags 3 and 2
     leave 15 and 14 bits). The rest follow the specification's order and
     nothing the model carries, so a short read here never costs the grid. */
  const tableOv: Pick<Extract<Entity, { type: 'table' }>,
    'titleSuppressed' | 'headerSuppressed' | 'flowDirection'
    | 'horizontalMargin' | 'verticalMargin'> = {};
  const readTail = (): void => {
    if (r.b()) {                          /* table overrides */
      const flags = r.bl();
      if (flags & 0x000001) { if (r.b()) tableOv.titleSuppressed = true; }
      if (flags & 0x000002) tableOv.headerSuppressed = true;
      if (flags & 0x000004) tableOv.flowDirection = r.bs();
      if (flags & 0x000008) tableOv.horizontalMargin = r.bd();
      if (flags & 0x000010) tableOv.verticalMargin = r.bd();
      for (const bit of [0x20, 0x40, 0x80]) if (flags & bit) x.cmc(true);
      for (const bit of [0x100, 0x200, 0x400]) if (flags & bit) r.b();
      for (const bit of [0x800, 0x1000, 0x2000]) if (flags & bit) x.cmc(true);
      for (const bit of [0x4000, 0x8000, 0x10000]) if (flags & bit) r.bs();
      for (const bit of [0x20000, 0x40000, 0x80000]) if (flags & bit) x.hr.h();
      for (const bit of [0x100000, 0x200000, 0x400000]) if (flags & bit) r.bd();
    }
    if (r.b()) {                          /* border colour overrides */
      const flags = r.bl();
      for (let bit = 1; bit <= 0x8000; bit <<= 1) if (flags & bit) x.cmc(true);
    }
    if (r.b()) {                          /* border lineweight overrides */
      const flags = r.bl();
      for (let bit = 1; bit <= 0x8000; bit <<= 1) if (flags & bit) r.bs();
    }
    if (r.b()) {                          /* border visibility overrides */
      const flags = r.bl();
      for (let bit = 1; bit <= 0x8000; bit <<= 1) if (flags & bit) r.bs();
    }
  };
  const readCells = (legacy: boolean): void => {
    cells.length = 0;
    cellBlocks.clear();
    for (let i = 0; i < total; i++) cells.push(readCell(i, legacy));
    if (r.pos > x.dataEnd) throw new RangeError('table cells overrun');
    /* files nasjidwg wrote before learning of the tail end at the cells */
    if (r.pos === x.dataEnd) return;
    const tpos = r.pos, thpos = x.hr.pos;
    try { readTail(); } catch { r.pos = tpos; x.hr.pos = thpos; }
  };
  if (v === 2007) {
    const dpos = r.pos, hpos = x.hr.pos, spos = x.sr?.pos;
    try {
      readCells(false);
    } catch {
      r.pos = dpos;
      x.hr.pos = hpos;
      if (x.sr && spos !== undefined) x.sr.pos = spos;
      readCells(true);
    }
  } else {
    readCells(false);
  }
  if (cellBlocks.size) raw.tableCellBlocks = cellBlocks;
  if (cellTextStyles.size) raw.tableCellTextStyles = cellTextStyles;
  return {
    type: 'table', layer: '0', color: { kind: 'byLayer' },
    position: pt3(ix, iy, iz),
    /* a desynchronised pre-2010 grid can hand back NaN here; the X axis is
       the only defensible fallback (readTableContent already guards) */
    direction: isFinite(dx2) && isFinite(dy2) && isFinite(dz2)
      ? pt3(dx2, dy2, dz2) : pt3(1, 0, 0),
    numRows, numColumns, rowHeights, columnWidths, cells,
    ...tableOv,
    ...(tblExtOld ? { extrusion: tblExtOld } : {})
  };
};

/** A lone full circle/ellipse edge collapses to the exact boundary kind the
 *  rest of the library speaks; anything else keeps its edge list. */
const simplifyEdgeLoop = (edges: HatchEdge[]): HatchBoundary => {
  if (edges.length === 1) {
    const e = edges[0];
    const TAU = Math.PI * 2;
    const full = (a0: number, a1: number): boolean =>
      Math.abs(Math.abs(a1 - a0) - TAU) < 1e-9 || a0 === a1;
    if (e.kind === 'arc' && full(e.startAngle, e.endAngle)) {
      return { kind: 'circle', center: e.center, radius: e.radius };
    }
    if (e.kind === 'ellipticalArc' && full(e.startAngle, e.endAngle)) {
      return {
        kind: 'ellipse', center: e.center,
        majorAxis: e.majorAxis, ratio: e.ratio
      };
    }
  }
  return { kind: 'edges', edges };
};

/* ------------------------------------------------------------------ *
 * table / object decoders
 * ------------------------------------------------------------------ */

/* ---- TABLESTYLE / MLEADERSTYLE ---- */

/** A decoder that stops short of, or runs past, the record's data end
 *  did not read the record it thought it was reading: the caller seals
 *  the record instead of trusting a partial decode. */
const requireDataEnd = (x: Ctx, what: string): void => {
  if (x.r.pos > x.dataEnd || x.dataEnd - x.r.pos >= 8) {
    throw new RangeError(`${what}: ${x.r.pos} of ${x.dataEnd} data bits`);
  }
};

/** TABLESTYLE before R2010: the description, the table-level switches
 *  and the data, title and header cell styles in that order — text style
 *  (a handle), height, alignment, text and fill colour, the fill switch,
 *  six borders (lineweight, visibility, colour) and, from R2007, the
 *  value's data/unit type and format string. The colours take the 2004
 *  CMC layout in every release, R2000 included, and the 2000/2004
 *  description carries a trailing NUL — both walked bit-exact against
 *  the reference's own 2000, 2004 and 2007 saves of its tables sample. */
const readTableStyleLegacy = (x: Ctx, owner: number): RawTableStyle => {
  const { r, v } = x;
  const description = x.text().replace(/\0+$/, '');
  const flowDirection = r.bs();
  const flags = r.bs();
  const horizontalMargin = r.bd();
  const verticalMargin = r.bd();
  const titleSuppressed = r.b() === 1;
  const headerSuppressed = r.b() === 1;
  const cell = (): RawTableStyleCell => {
    const textStyleHandle = x.hr.hAbs(owner);
    const textHeight = r.bd();
    const alignment = r.bs();
    const textColor = x.cmc(true).color;
    const fillColor = x.cmc(true).color;
    const fillOn = r.b() === 1;
    const borders: NonNullable<RawTableStyleCell['borders']> = [];
    for (let i = 0; i < 6; i++) {
      const lineweight = r.bs();
      const visible = r.b() === 1;
      const color = x.cmc(true).color;
      borders.push({ lineweight, visible, color });
    }
    const c: RawTableStyleCell = {
      textStyleHandle, textHeight, alignment, textColor, fillColor, fillOn, borders
    };
    if (v >= 2007) {
      c.dataType = r.bl();
      c.unitType = r.bl();
      c.format = x.text() || undefined;
    }
    return c;
  };
  const data = cell();
  const title = cell();
  const header = cell();
  requireDataEnd(x, 'TABLESTYLE');
  return {
    description: description || undefined, flowDirection, flags,
    horizontalMargin, verticalMargin, titleSuppressed, headerSuppressed,
    data, title, header
  };
};

/** One cell style of the R2010+ TABLESTYLE: the table's cell-style
 *  grammar (type, data flag, override and merge flags, background, content
 *  layout, content format, margins, borders) — token-walked to the bit
 *  against the reference's 2010, 2013 and 2018 saves of three drawings.
 *  A border's BL after its linetype counts INVISIBILITY (1 = hidden):
 *  the same style's pre-2010 record says visible = 1 where this says 0. */
const readTableStyleCell2010 = (
  x: Ctx, owner: number
): RawTableStyleCell & { margins?: number[]; overrides?: number } => {
  const { r } = x;
  r.bl();                                 /* style type: 1 table, 5 cell */
  const hasMerge = r.bs();
  const overrides = r.bl();               /* property override flags */
  if (hasMerge) r.bl();                   /* merge flags */
  const bg = x.cmc(true);
  r.bl();                                 /* content layout */
  r.bl(); r.bl();                         /* format override + property flags */
  const dataType = r.bl();
  const unitType = r.bl();
  const format = x.text();
  r.bd(); r.bd();                         /* rotation, block scale */
  const alignment = r.bl();
  const textColor = x.cmc(true).color;
  const textStyleHandle = x.hr.hAbs(owner);
  const textHeight = r.bd();
  let margins: number[] | undefined;
  if (r.bs()) {
    margins = [];
    for (let i = 0; i < 6; i++) margins.push(r.bd());
  }
  const numBorders = r.bl();
  if (numBorders > 6) throw new RangeError('table style borders');
  const borders: NonNullable<RawTableStyleCell['borders']> = [];
  for (let i = 0; i < numBorders; i++) {
    if (!r.bl()) continue;                /* edge mask */
    r.bl(); r.bl();                       /* overrides, border type */
    const color = x.cmc(true).color;
    const lineweight = r.bl();
    const ltypeHandle = x.hr.hAbs(owner);
    const visible = r.bl() === 0;
    r.bd();                               /* double-line spacing */
    borders.push({ lineweight, visible, color, ltypeHandle });
  }
  /* the fill: a 0xC8 "none" method means no fill; the legacy record
     spells the same as fill colour 7 with the switch off */
  const fillOn = bg.color.kind !== 'byBlock' || bg.index !== 0;
  const c: RawTableStyleCell & { margins?: number[]; overrides?: number } = {
    textStyleHandle, textHeight, alignment, textColor,
    fillColor: fillOn ? bg.color : { kind: 'aci', index: 7 }, fillOn,
    borders: borders.length === 6 ? borders : undefined,
    dataType, unitType, format: format || undefined, overrides
  };
  if (margins) c.margins = margins;
  return c;
};

/** TABLESTYLE from R2010: a byte, the name, the flag word (the pre-2010
 *  group 71), then the table's own cell style (id 101, class 5, named
 *  "Table": the margins live in it as top/left/bottom/right plus two
 *  spacings, and a flow direction of "up" as override bit 0x10000) and a
 *  map of named cell styles, each an id, the cell style, the id again, a
 *  class word and the name: _TITLE, _HEADER and _DATA. A hard-owner NULL
 *  precedes the first text style in the handle stream. The title and
 *  header suppression switches are not stored in this record (the
 *  reference keeps them elsewhere). */
const readTableStyle2010 = (x: Ctx, owner: number): RawTableStyle => {
  const { r } = x;
  r.rc();                                 /* unknown, 0 */
  const description = x.text();
  const flags = r.bl();
  x.hr.h();                               /* unknown hard owner (NULL) */
  r.bl(); r.bl();                         /* default cell style id / class */
  const table = readTableStyleCell2010(x, owner);
  x.text();                               /* default cell style name */
  r.bl(); r.bl();                         /* constants 4, 2 */
  const count = r.bl();
  if (count > 64) throw new RangeError('table style cell styles');
  const out: RawTableStyle = {
    description: description || undefined,
    flowDirection: (table.overrides ?? 0) & 0x10000 ? 1 : 0, flags,
    horizontalMargin: table.margins?.[1],
    verticalMargin: table.margins?.[0],
    titleSuppressed: false, headerSuppressed: false
  };
  for (let i = 0; i < count; i++) {
    r.bl();                               /* id */
    const cell = readTableStyleCell2010(x, owner);
    delete cell.margins;
    delete cell.overrides;
    const id = r.bl();
    r.bl();                               /* class: 1 title/header, 2 data */
    const name = x.text().toUpperCase();
    if (name === '_TITLE' || (!name && id === 1)) out.title = cell;
    else if (name === '_HEADER' || (!name && id === 2)) out.header = cell;
    else if (name === '_DATA' || (!name && id === 3)) out.data = cell;
  }
  requireDataEnd(x, 'TABLESTYLE');
  return out;
};

/** MLEADERSTYLE (an R2008 class; the reference writes it into 2000 and
 *  2004 saves too): the writer's own field order, walked bit-exact
 *  against the reference's 2000 … 2018 saves of its multileader sample.
 *  R2010 prefixes a class version and appends the attachment trio,
 *  R2013 one more flag. */
const readMLeaderStyle = (x: Ctx, owner: number): RawMLeaderStyle => {
  const { r, v } = x;
  const s: RawMLeaderStyle = {};
  if (v >= 2010) r.bs();                  /* class version (2) */
  s.contentType = r.bs();
  s.drawMLeaderOrder = r.bs();
  s.drawLeaderOrder = r.bs();
  s.maxLeaderPoints = r.bl();
  s.firstSegmentAngle = r.bd();
  s.secondSegmentAngle = r.bd();
  s.leaderType = r.bs();
  s.lineColor = x.cmc().color;
  s.ltypeHandle = x.hr.hAbs(owner);
  s.lineweight = r.bl();
  s.landing = r.b() === 1;
  s.landingGap = r.bd();
  s.dogleg = r.b() === 1;
  s.doglegLength = r.bd();
  s.description = x.text() || undefined;
  s.arrowHandle = x.hr.hAbs(owner);
  s.arrowSize = r.bd();
  s.defaultText = x.text() || undefined;
  s.textStyleHandle = x.hr.hAbs(owner);
  s.textLeftAttachment = r.bs();
  s.textRightAttachment = r.bs();
  s.textAngleType = r.bs();
  s.textAlignment = r.bs();
  s.textColor = x.cmc().color;
  s.textHeight = r.bd();
  s.textFrame = r.b() === 1;
  s.alwaysAlignLeft = r.b() === 1;
  s.alignSpace = r.bd();
  s.blockHandle = x.hr.hAbs(owner);
  s.blockColor = x.cmc().color;
  const [sx, sy, sz] = r.bd3();
  s.blockScale = pt3(sx, sy, sz);
  s.useBlockScale = r.b() === 1;
  s.blockRotation = r.bd();
  s.useBlockRotation = r.b() === 1;
  s.blockConnection = r.bs();
  s.scale = r.bd();
  s.propertyChanged = r.b() === 1;
  s.annotative = r.b() === 1;
  s.breakSize = r.bd();
  if (v >= 2010) {
    s.attachmentDirection = r.bs();
    s.bottomAttachment = r.bs();
    s.topAttachment = r.bs();
  }
  if (v >= 2013) r.b();                   /* extended text flag */
  requireDataEnd(x, 'MLEADERSTYLE');
  return s;
};

const decodeObjectSpecific = (x: Ctx, typeName: string, raw: RawObject): void => {
  const { r, v } = x;
  switch (typeName) {
    case 'TABLESTYLE': {
      raw.tableStyleObj = v >= 2010
        ? readTableStyle2010(x, raw.handle)
        : readTableStyleLegacy(x, raw.handle);
      return;
    }

    case 'MLEADERSTYLE': {
      raw.mleaderStyleObj = readMLeaderStyle(x, raw.handle);
      return;
    }

    case 'ACAD_PROXY_OBJECT': {
      /* The dictionary-owned twin of the proxy entity: same prologue, same
         opaque tail, retained the same way so it can be written back. */
      const classId = r.bl();
      const proxyVersion = r.bl();
      const proxyMaint = v >= 2018 ? r.bl() : undefined;
      const fromDxf = v >= 2000 ? r.b() === 1 : undefined;
      const cls = x.c.classes.get(classId);
      if (((proxyVersion & 0xffff0000) >>> 0) === SEAL_MAGIC) {
        /* seal-wrap: unwrap to a sealed unknown object (see entity twin) */
        const { dataBits, blob, strBits, strBlob } = readSealBody(x);
        const tail = captureProxyTail(x);
        raw.unknownObject = {
          sourceType: cls?.dxfName ?? typeName,
          appClass: cls
            ? { dxfName: cls.dxfName, cppName: cls.cppName, appName: cls.appName }
            : undefined,
          encoding: proxyVersion & 0xffff,
          data: dataBits > 0 ? toBase64(blob) : undefined,
          dataBits: dataBits > 0 ? dataBits : undefined,
          strData: strBits > 0 ? toBase64(strBlob) : undefined,
          strBits: strBits > 0 ? strBits : undefined,
          refs: tail.refs
        };
        return;
      }
      raw.proxyObject = {
        sourceType: cls?.dxfName ?? typeName,
        appClass: cls
          ? { dxfName: cls.dxfName, cppName: cls.cppName, appName: cls.appName }
          : undefined,
        proxyVersion, proxyMaint, fromDxf,
        ...captureProxyTail(x),
        /* the record's own EED rides along: for some applications it is
           the whole object (the reference's dbConnect link records) */
        ...(x.xdata ? { xdata: x.xdata } : {})
      };
      return;
    }
    case 'BLOCKLINEARPARAMETER':
    case 'BLOCKROTATIONPARAMETER':
    case 'BLOCKFLIPPARAMETER':
    case 'BLOCKALIGNMENTPARAMETER':
    case 'BLOCKBASEPOINTPARAMETER':
    case 'BLOCKXYPARAMETER':
    case 'BLOCKPOLARPARAMETER':
    case 'BLOCKPOINTPARAMETER':
    case 'BLOCKLOOKUPPARAMETER': {
      const p3 = (): Point3 => {
        const [px, py, pz] = r.bd3();
        return pt3(px, py, pz);
      };
      const valueSet = (): NonNullable<BlockParameter['valueSet']> => {
        const type = r.bl();
        const minimum = r.bd(), maximum = r.bd(), increment = r.bd();
        const n = r.bs();
        if (n < 0 || n > 10000) throw new RangeError('value set');
        const allowed: number[] = [];
        for (let i = 0; i < n; i++) allowed.push(r.bd());
        return { type, minimum, maximum, increment, allowed };
      };
      /* the AcDbEvalExpr / AcDbBlockElement / AcDbBlockParameter run */
      readEvalExpr(x);
      const elementName = x.text();
      r.bl(); r.bl();                     /* element version pair */
      r.bl();                             /* extended-data marker */
      r.b(); r.b();                       /* show properties, chain actions */
      const param: BlockParameter = {
        kind: typeName === 'BLOCKLINEARPARAMETER' ? 'linear'
          : typeName === 'BLOCKROTATIONPARAMETER' ? 'rotation'
          : typeName === 'BLOCKFLIPPARAMETER' ? 'flip'
          : typeName === 'BLOCKALIGNMENTPARAMETER' ? 'alignment'
          : typeName === 'BLOCKXYPARAMETER' ? 'xy'
          : typeName === 'BLOCKPOLARPARAMETER' ? 'polar'
          : typeName === 'BLOCKPOINTPARAMETER' ? 'point'
          : typeName === 'BLOCKLOOKUPPARAMETER' ? 'lookup' : 'basePoint',
        name: elementName || undefined
      };
      const onePoint = param.kind === 'basePoint' || param.kind === 'point'
        || param.kind === 'lookup';
      if (onePoint) {
        /* the one-point form: location, two properties, one grip */
        param.firstPoint = p3();
        readBlockPropInfo(x);
        readBlockPropInfo(x);
        r.bl();                           /* grip id */
        switch (param.kind) {
          case 'basePoint':
            p3(); p3();                   /* base + offset points */
            break;
          case 'point':
            param.label = x.text() || undefined;
            param.description = x.text() || undefined;
            p3();                         /* label position */
            break;
          default:                        /* lookup */
            r.bl();                       /* action id */
            param.label = x.text() || undefined;
            param.description = x.text() || undefined;
        }
      } else {
        /* the two-point form: both ends, four properties, four grips */
        param.firstPoint = p3();
        param.secondPoint = p3();
        for (let i = 0; i < 4; i++) readBlockPropInfo(x);
        r.bl(); r.bl(); r.bl(); r.bl();   /* grip ids */
        r.bs();                           /* base location */
        switch (param.kind) {
          case 'linear':
            param.label = x.text() || undefined;
            param.description = x.text() || undefined;
            r.bd();                       /* label offset */
            param.valueSet = valueSet();
            break;
          case 'rotation':
            param.point = p3();
            param.label = x.text() || undefined;
            param.description = x.text() || undefined;
            r.bd();                       /* label offset */
            param.valueSet = valueSet();
            break;
          case 'flip':
            param.label = x.text() || undefined;
            param.description = x.text() || undefined;
            param.baseStateName = x.text() || undefined;
            param.flippedStateName = x.text() || undefined;
            p3();                         /* label position */
            r.bl(); x.text();             /* updated-flip connection */
            break;
          case 'alignment':
            param.perpendicular = r.b() === 1;
            break;
          case 'xy':
            param.label2 = x.text() || undefined;      /* Y label first */
            param.label = x.text() || undefined;
            param.description2 = x.text() || undefined;
            param.description = x.text() || undefined;
            r.bd(); r.bd();               /* label offsets */
            param.valueSet = valueSet();
            param.valueSet2 = valueSet();
            break;
          case 'polar':
            param.label = x.text() || undefined;
            param.description = x.text() || undefined;
            param.label2 = x.text() || undefined;      /* angle name */
            param.description2 = x.text() || undefined;
            r.bd();                       /* label offset */
            param.valueSet = valueSet();
            param.valueSet2 = valueSet();
            break;
          default:
            break;
        }
      }
      if (param.valueSet && !param.valueSet.allowed.length
          && param.valueSet.type === 0) {
        delete param.valueSet;            /* unconstrained: nothing to keep */
      }
      raw.blockParam = param;
      return;
    }

    case 'BLOCKMOVEACTION':
    case 'BLOCKROTATEACTION':
    case 'BLOCKSCALEACTION':
    case 'BLOCKSTRETCHACTION':
    case 'BLOCKPOLARSTRETCHACTION':
    case 'BLOCKFLIPACTION':
    case 'BLOCKARRAYACTION':
    case 'BLOCKLOOKUPACTION': {
      /* the class already names the kind; the body adds nothing a viewer
         draws */
      raw.blockAction = typeName
        .replace(/^BLOCK/, '').replace(/ACTION$/, '').toLowerCase();
      return;
    }

    case 'BLOCKVISIBILITYPARAMETER': {
      /* the one member of the dynamic-block family that changes what a
         viewer draws: which entities each named state shows */
      readEvalExpr(x);
      const elementName = x.text();       /* the parameter's element name */
      r.bl(); r.bl();                     /* element version pair */
      r.bl();                             /* extended-data marker */
      r.b(); r.b();                       /* show properties, chain actions */
      r.bd3();                            /* definition point */
      readBlockPropInfo(x);
      readBlockPropInfo(x);
      r.bl();                             /* property-info count */
      r.b();                              /* is initialized */
      const name = x.text() || elementName;
      const prompt = x.text();
      r.b();                              /* unknown */
      const numMembers = r.bl();
      if (numMembers < 0 || numMembers > 1000000) {
        throw new RangeError('visibility members');
      }
      const members: number[] = [];
      for (let i = 0; i < numMembers; i++) members.push(x.handle(raw.handle));
      const numStates = r.bl();
      if (numStates < 0 || numStates > 100000) {
        throw new RangeError('visibility states');
      }
      const states: { name: string; visible: number[] }[] = [];
      for (let i = 0; i < numStates; i++) {
        const stateName = x.text();
        const visible: number[] = [];
        const nVisible = r.bl();
        if (nVisible < 0 || nVisible > 1000000) {
          throw new RangeError('visibility state members');
        }
        for (let k = 0; k < nVisible; k++) visible.push(x.handle(raw.handle));
        const nParams = r.bl();
        if (nParams < 0 || nParams > 1000000) {
          throw new RangeError('visibility state params');
        }
        for (let k = 0; k < nParams; k++) x.handle(raw.handle);
        states.push({ name: stateName, visible });
      }
      raw.visibility = { name, prompt, members, states };
      return;
    }

    case 'TABLECONTENT': {
      /* the grid an R2010+ ACAD_TABLE points at */
      raw.tableContent = readTableContent(x);
      if (raw.tableContent.cellBlocks) raw.tableCellBlocks = raw.tableContent.cellBlocks;
      if (raw.tableContent.cellTextStyles) raw.tableCellTextStyles = raw.tableContent.cellTextStyles;
      return;
    }

    case 'PDFDEFINITION':
    case 'DGNDEFINITION':
    case 'DWFDEFINITION': {
      raw.underlayDef = { path: x.text(), itemName: x.text() };
      return;
    }

    case 'GEODATA': {
      /* how design coordinates sit on the earth */
      const version = r.bl();
      x.handle(raw.handle);               /* host block */
      const geo: GeoData = {
        version,
        coordinatesType: r.bs(),
        designPoint: { x: 0, y: 0, z: 0 },
        referencePoint: { x: 0, y: 0, z: 0 }
      };
      const p3 = (): Point3 => {
        const [px, py, pz] = r.bd3();
        return pt3(px, py, pz);
      };
      if (version <= 1) {                 /* the 2009 form */
        geo.referencePoint = p3();
        geo.horizontalUnits = r.bl();
        geo.verticalUnits = geo.horizontalUnits;
        geo.designPoint = p3();
        p3();                             /* obsolete */
        geo.upDirection = p3();
        /* north stored as a clockwise angle off (0,1) */
        const a = Math.PI / 2 - r.bd();
        geo.northDirection = { x: Math.cos(a), y: Math.sin(a) };
        p3();                             /* obsolete */
        geo.coordinateSystem = x.text() || undefined;
        geo.geoRssTag = x.text() || undefined;
        geo.horizontalUnitScale = r.bd();
        geo.verticalUnitScale = geo.horizontalUnitScale;
        x.text(); x.text();               /* obsolete datum + WKT */
      } else {                            /* 2010 and 2013 forms */
        geo.designPoint = p3();
        geo.referencePoint = p3();
        geo.horizontalUnitScale = r.bd();
        geo.horizontalUnits = r.bl();
        geo.verticalUnitScale = r.bd();
        geo.verticalUnits = r.bl();
        geo.upDirection = p3();
        geo.northDirection = { x: r.rd(), y: r.rd() };
        geo.scaleEstimation = r.bl();
        geo.userScaleFactor = r.bd();
        geo.seaLevelCorrection = r.b() === 1;
        geo.seaLevelElevation = r.bd();
        geo.projectionRadius = r.bd();
        geo.coordinateSystem = x.text() || undefined;
        geo.geoRssTag = x.text() || undefined;
      }
      /* observation tags + geo mesh, consumed but not modeled */
      x.text(); x.text(); x.text();
      const npts = r.bl();
      if (npts >= 0 && npts <= 100000) {
        for (let i = 0; i < npts; i++) { r.rd(); r.rd(); r.rd(); r.rd(); }
        const nfaces = r.bl();
        if (nfaces >= 0 && nfaces <= 100000) {
          for (let i = 0; i < nfaces; i++) { r.bl(); r.bl(); r.bl(); }
        }
      }
      const m = /<georss:point>\s*([-\d.eE+]+)\s+([-\d.eE+]+)/.exec(geo.geoRssTag ?? '');
      if (m) { geo.latitude = parseFloat(m[1]); geo.longitude = parseFloat(m[2]); }
      raw.geoData = geo;
      return;
    }

    case 'LAYER': {
      const name = x.tableFlags();
      const t: TableRecord = { kind: 'layer', name };
      if (x.lastXrefDependent) t.xrefDependent = true;
      raw.table = t;
      if (v <= 14) {
        t.frozen = r.b() === 1; t.off = r.b() === 1;
        r.b(); t.locked = r.b() === 1;
        t.plot = true;
      } else {
        const f = r.bs();
        t.frozen = (f & 1) !== 0;
        t.off = (f & 2) !== 0;
        t.locked = (f & 8) !== 0;
        t.plot = (f & 16) !== 0;
        t.lineweight = lwToMm((f & 0x03e0) >> 5);
      }
      const { color, index } = x.cmc();
      t.colorIndex = index;
      if (color.kind === 'rgb') t.rgb = color.rgb;
      if (index < 0) t.off = true;
      /* handles: [2000+] plotstyle, [2007+] material, ltype, [2013+] visualstyle */
      if (v >= 2000) x.hr.h();
      if (v >= 2007) x.hr.h();
      t.ltypeHandle = x.handle(raw.handle);
      return;
    }

    case 'STYLE': {
      const name = x.tableFlags();
      const stXref = x.lastXrefDependent;
      const isShape = r.b() === 1;
      r.b();                              /* is_vertical */
      const fixedHeight = r.bd();
      const widthFactor = r.bd();
      const oblique = r.bd();
      r.rc(); r.bd();                     /* generation, last height */
      const font = x.text();
      const bigFont = x.text();
      /* A TrueType style names its FILE above and its TYPEFACE in the
         record's EED, which is carried through whole: at this depth an
         xdata group knows only its APPID's HANDLE, and the reader is the
         first place that can say which of them is ACAD. */
      raw.table = {
        kind: 'style', name, font: font || undefined,
        bigFont: bigFont || undefined,
        fixedHeight: fixedHeight || undefined,
        widthFactor: widthFactor !== 1 ? widthFactor : undefined,
        oblique: oblique || undefined,
        shapeFile: isShape || undefined,
        xrefDependent: stXref || undefined,
        xdata: x.xdata
      };
      return;
    }

    case 'LTYPE': {
      const name = x.tableFlags();
      const ltXref = x.lastXrefDependent;
      const description = x.text();
      r.bd();                             /* total pattern length */
      r.rc();                             /* alignment */
      const numDashes = r.rc();
      const pattern: number[] = [];
      let hasText = false;
      for (let i = 0; i < numDashes; i++) {
        pattern.push(r.bd());
        r.bs();                           /* complex shapecode */
        x.hr.h();                         /* shape/text style per dash */
        r.rd(); r.rd();                   /* x/y offsets */
        r.bd(); r.bd();                   /* scale, rotation */
        const sf = r.bs();
        if (sf & 2) hasText = true;
      }
      if (v <= 2004) r.bytes(256);        /* strings area */
      else if (hasText) r.bytes(512);
      raw.table = { kind: 'ltype', name, description, pattern, xrefDependent: ltXref || undefined };
      return;
    }

    case 'BlockRecord': {
      const name = x.tableFlags();
      /* the record's EED stays with it: a dynamic block's definition is
         stored as an anonymous "*U" whose true name lives in xdata, and
         the reader — the first place that knows the APPID names — is
         where the promotion happens */
      const t: TableRecord = { kind: 'blockHeader', name, xdata: x.xdata };
      raw.table = t;
      t.anonymous = r.b() === 1;
      r.b();                              /* has attdefs */
      const isXref = r.b() === 1;
      const isOverlaid = r.b() === 1;
      if (v >= 2000) r.b();               /* xref loaded */
      let numOwned = 0;
      if (v >= 2004 && !isXref && !isOverlaid) numOwned = r.bl();
      const [bx, by, bz] = r.bd3();
      t.basePoint = pt3(bx, by, bz);
      const xrefPath = x.text();
      if (isXref || isOverlaid) { t.xrefPath = xrefPath; t.xrefOverlay = isOverlaid; }
      let numInserts = 0;
      if (v >= 2000) {
        /* stored as a run of nonzero bytes closed by a zero byte */
        while (r.rc() !== 0) numInserts++;
        x.text();                         /* description */
        const previewSize = r.bl();
        if (previewSize > 0 && previewSize < 0xa00000) r.bytes(previewSize);
      }
      if (v >= 2007) { r.bs(); r.b(); r.rc(); }    /* units, explodable, scaling */
      /* handles: block entity, entity chain / owned vector, endblk, inserts, layout */
      x.hr.h();                           /* block begin entity */
      if (v <= 2000 && !isXref && !isOverlaid) {
        t.firstEntity = x.handle(raw.handle);
        t.lastEntity = x.handle(raw.handle);
      }
      if (v >= 2004) {
        t.ownedHandles = [];
        if (numOwned < 0xf00000) {
          for (let i = 0; i < numOwned; i++) t.ownedHandles.push(x.handle(raw.handle));
        }
      }
      x.hr.h();                           /* endblk */
      if (v >= 2000) {
        for (let i = 0; i < numInserts && i < 0xf00000; i++) x.hr.h();
        x.hr.h();                         /* layout */
      }
      return;
    }

    case 'BlockTable': {
      const num = r.bl();
      /* control objects: handle stream continues right here (pre-R2007) */
      const chr = v < 2007 ? x.r : x.hr;
      const t: TableRecord = { kind: 'blockControl' };
      raw.table = t;
      chr.h();                            /* owner */
      for (let i = 0; i < x.numReactors; i++) chr.h();
      if (v < 2004 || !x.xdicMissing) chr.h();
      const entries: number[] = [];
      for (let i = 0; i < num && i < 100000; i++) {
        entries.push(resolveHandle(chr.h(), raw.handle));
      }
      t.ownedHandles = entries;
      t.modelSpace = resolveHandle(chr.h(), raw.handle);
      t.paperSpace = resolveHandle(chr.h(), raw.handle);
      return;
    }

    case 'LinetypeTable': {
      /* the linetype table's entry list, in the control's order: what
         a pre-2018 MLINESTYLE element's linetype index counts through
         (the reference's own 2000/2004 re-saves of a style whose
         elements name DASHED and HIDDEN, the third and fourth records
         after ByLayer/ByBlock, carry 1 and 2 — the index into this
         list; 32767 BYLAYER, 32766 BYBLOCK) */
      const num = r.bl();
      const chr = v < 2007 ? x.r : x.hr;
      chr.h();                            /* owner */
      for (let i = 0; i < x.numReactors; i++) chr.h();
      if (v < 2004 || !x.xdicMissing) chr.h();
      const entries: number[] = [];
      for (let i = 0; i < num && i < 100000; i++) {
        entries.push(resolveHandle(chr.h(), raw.handle));
      }
      raw.table = { kind: 'tableControl', ownedHandles: entries };
      return;
    }

    case 'APPID': {
      const name = x.tableFlags();
      raw.table = { kind: 'appid', name };
      return;
    }

    case 'DIMSTYLE': {
      /* name only; the ~80 style variables are version-layout-heavy and
         resolved lazily later — the name is what dimensions reference */
      const name = x.tableFlags();
      raw.table = { kind: 'dimstyle', name };
      return;
    }

    case 'DICTIONARY':
    /* the dictionary with a default (the plot style name dictionary): a
       DICTIONARY body, then the default record's handle closing the
       handle stream (the reference's own DXF: AcDbDictionary, then
       AcDbDictionaryWithDefault with its 340) */
    case 'ACDBDICTIONARYWDFLT': {
      const num = r.bl();
      if (num > 100000) return;
      const cloning = v >= 2000 ? r.bs() : undefined;   /* cloning */
      /* the hard-owner RC arrives with R13c3; plain R13 (AC1012) runs the
         entry names straight on from the count. Reading it there shifts
         every following string by a byte and loses the dictionary. */
      const hardOwner = v >= 14 ? r.rc() !== 0 : undefined;
      const names: string[] = [];
      for (let i = 0; i < num; i++) names.push(x.text());
      const handles: number[] = [];
      const codes: number[] = [];
      for (let i = 0; i < num; i++) {
        /* the code is kept with the target: a sealed extension
           dictionary is re-encoded from its entries on a rewrite, and
           spells each one the way the source did (soft or hard owner) */
        const ref = x.hr.h();
        codes.push(ref.code);
        handles.push(
          ref.code === 0x6 ? raw.handle + 1
            : ref.code === 0x8 ? raw.handle - 1
              : ref.code === 0xA ? raw.handle + ref.value
                : ref.code === 0xC ? raw.handle - ref.value
                  : ref.value);
      }
      raw.dictionary = { names, handles, codes, cloning, hardOwner };
      if (typeName === 'ACDBDICTIONARYWDFLT') {
        raw.dictionary.defaultHandle = x.handle(raw.handle);
      }
      return;
    }

    case 'GROUP': {
      /* The record's one string is the DESCRIPTION (DXF group 300); the
         group's NAME is its entry key in the ACAD_GROUP dictionary, which
         the reader resolves afterwards (verified against AutoCAD 2027's
         DXFOUT: an unnamed group reads back as *A1 + description). */
      const description = x.text();
      const unnamed = r.bs();
      const selectable = r.bs();
      const num = r.bl();
      if (num > 100000) return;
      const members: number[] = [];
      for (let i = 0; i < num; i++) members.push(x.handle(raw.handle));
      raw.group = {
        name: unnamed ? '*A' : '',
        description: description || undefined,
        selectable: selectable !== 0, members
      };
      return;
    }

    case 'MLINESTYLE': {
      const name = x.text();
      const description = x.text();
      const flags = r.bs();
      const { color: fillColor } = x.cmc();
      const startAngle = r.bd();
      const endAngle = r.bd();
      const num = r.rc();
      if (num > 64) return;
      const elements: NonNullable<RawObject['mlineStyle']>['elements'] = [];
      for (let i = 0; i < num; i++) {
        const offset = r.bd();
        const { color } = x.cmc();
        /* Each element's linetype travels as a BSd index in the data
           stream up to R2013, and only becomes a handle-stream reference
           in R2018. Reading handles too early left the handle stream
           short and threw, which sealed the record: every R2007/R2010/
           R2013 file came back with no MLINESTYLE at all. */
        const el: (typeof elements)[number] = { offset, color };
        if (v < 2018) el.ltypeIndex = r.bs();   /* linetype index */
        elements.push(el);
      }
      if (v >= 2018) {
        for (let i = 0; i < num; i++) {
          const lt = x.handle(raw.handle);      /* per-element ltype */
          if (lt) elements[i].ltypeHandle = lt;
        }
      }
      raw.mlineStyle = {
        name, description: description || undefined, flags,
        fillColor, startAngle, endAngle, elements
      };
      return;
    }

    case 'LAYOUT': {
      /* AcDbPlotSettings comes first; only the fields we model are kept */
      x.text();                           /* printer config file */
      const paperSize = x.text();
      r.bs();                             /* plot flags */
      for (let i = 0; i < 6; i++) r.bd(); /* margins + paper size */
      x.text();                           /* canonical media name */
      r.bd(); r.bd();                     /* plot origin */
      r.bs(); r.bs(); r.bs();             /* unit, rotation, type */
      r.bd(); r.bd(); r.bd(); r.bd();     /* window ll/ur */
      if (v <= 2002) x.text();            /* plot view name */
      else x.hr.h();                      /* plot view handle */
      r.bd(); r.bd();                     /* paper/drawing units */
      const stylesheet = x.text();
      r.bs();                             /* std scale type */
      r.bd();                             /* std scale factor */
      r.bd(); r.bd();                     /* paper image origin */
      if (v >= 2004) { r.bs(); r.bs(); r.bs(); }
      if (v >= 2007) x.hr.h();            /* shadeplot */
      /* AcDbLayout */
      const name = x.text();
      const tabOrder = r.bs();
      r.bs();                             /* layout flags */
      const [ix, iy, iz] = r.bd3();
      const limMin = { x: r.rd(), y: r.rd() };
      const limMax = { x: r.rd(), y: r.rd() };
      r.bd3();                            /* ucs origin */
      r.bd3(); r.bd3();                   /* ucs x/y dir */
      r.bd();                             /* elevation */
      r.bs();                             /* ortho view type */
      const [minx, miny, minz] = r.bd3();
      const [maxx, maxy, maxz] = r.bd3();
      raw.layout = {
        name, tabOrder,
        limMin, limMax,
        extMin: pt3(minx, miny, minz),
        extMax: pt3(maxx, maxy, maxz),
        insBase: pt3(ix, iy, iz),
        paperSize: paperSize || undefined,
        plotStyleSheet: stylesheet || undefined
      };
      if (v >= 2004) r.bl();              /* viewport count */
      /* handle stream: block header first, then viewport and the UCSs */
      raw.layout.blockHandle = x.handle(raw.handle);
      return;
    }

    case 'UCS': {
      /* R2000 added the elevation, the orthographic view type, the
         remembered origin per orthographic type (a counted run of BS
         type + 3BD), and in the handle stream — after the xref slot —
         the base UCS and a second, always-null UCS pointer. Bit-walked
         on the reference's own 2000, 2004, 2007 and 2018 saves of its
         Tower sample (records ZX and ZY): the data closes `BD 0, BS 0,
         BS 0` and the handles run `4:control 5:0 5:0 5:0`. */
      const name = x.tableFlags();
      const [ox, oy, oz] = r.bd3();
      const [xx, xy, xz] = r.bd3();
      const [yx, yy, yz] = r.bd3();
      raw.table = { kind: 'ucs', name };
      raw.ucs = {
        name, origin: pt3(ox, oy, oz),
        xAxis: pt3(xx, xy, xz), yAxis: pt3(yx, yy, yz)
      };
      if (v >= 2000) {
        raw.ucs.elevation = r.bd();
        raw.ucs.orthoViewType = r.bs();
        const n = r.bs();
        if (n < 0 || n > 64) return;
        const origins: { type: number; origin: Point3 }[] = [];
        for (let i = 0; i < n; i++) {
          const type = r.bs();
          const [px, py, pz] = r.bd3();
          origins.push({ type, origin: pt3(px, py, pz) });
        }
        if (origins.length) raw.ucs.orthoOrigins = origins;
        const base = x.handle(raw.handle);   /* base UCS (346) */
        if (base) raw.ucs.baseUcsHandle = base;
        x.hr.h();                           /* named UCS: always null */
      }
      return;
    }

    case 'DICTIONARYVAR': {
      /* the schema byte (DXF 280, 0 in every file seen), the value as
         text (DXF 1) */
      const schema = r.rc();
      const value = x.text();
      raw.dictionaryVar = { schema, value };
      return;
    }

    case 'VIEW': {
      /* The record in the VPORT's order: height, width, centre, TARGET
       * then direction, twist, lens length, the two clip distances, the
       * four mode bits (three of them VIEWMODE, the fourth always set),
       * the R2000+ render mode, the R2007+ lighting block, the paper
       * space flag and the R2000+ associated UCS. Graded against the
       * reference's own table of its sheet-set samples ((tblnext "VIEW"):
       * 11 = direction (0,0,1), 12 = target (0,0,0), 42 = 50) — the
       * earlier walk read the target as the direction and the twist as
       * the lens length. */
      const name = x.tableFlags();
      const height = r.bd();
      const width = r.bd();
      const cx = r.rd(), cy = r.rd();
      const [tx, ty, tz] = r.bd3();
      const [dx2, dy2, dz2] = r.bd3();
      const twist = r.bd();
      const lensLength = r.bd();
      const frontClip = r.bd();
      const backClip = r.bd();
      const viewMode = r.b() | (r.b() << 1) | (r.b() << 2);
      r.b();                              /* the fourth bit: always 1 */
      const renderMode = v >= 2000 ? r.rc() : undefined;
      if (v >= 2007) {
        r.b();                            /* use default lights */
        r.rc();                           /* default lighting type */
        r.bd(); r.bd();                   /* brightness, contrast */
        x.cmc();                          /* ambient colour */
      }
      const paperSpace = r.b() === 1;
      const view: View = {
        name, center: { x: cx, y: cy }, height, width,
        direction: pt3(dx2, dy2, dz2), target: pt3(tx, ty, tz),
        lensLength: lensLength || undefined,
        twist, frontClip, backClip, viewMode
      };
      if (renderMode !== undefined) view.renderMode = renderMode;
      if (paperSpace) view.paperSpace = true;
      if (v >= 2000 && r.b() === 1) {     /* associated UCS */
        const [ox, oy, oz] = r.bd3();
        const [uxx, uxy, uxz] = r.bd3();
        const [uyx, uyy, uyz] = r.bd3();
        view.ucsOrigin = pt3(ox, oy, oz);
        view.ucsXAxis = pt3(uxx, uxy, uxz);
        view.ucsYAxis = pt3(uyx, uyy, uyz);
        view.ucsElevation = r.bd();
        view.ucsOrthoType = r.bs();
      }
      raw.table = { kind: 'view', name };
      raw.view = view;
      return;
    }

    case 'VPORT': {
      /* The record in its true order, pinned bit for bit against a real
       * AC1014 drawing whose every value AutoCAD's own DXFOUT reports:
       * the height's double sits at a known bit, and walking
       * BD height, BD aspect, 2RD centre, 3BD target, 3BD dir, BD twist,
       * BD lens, BD front, BD back, 4BITS view mode, 2RD lower left,
       * 2RD upper right, B, BS, B, BB, B, 2RD grid, B, B, BS, BD,
       * 2RD snap base lands on the snap spacing's double exactly.
       *
       * The earlier walk read the target into `direction` and the
       * direction into `target`, never read VIEWTWIST at all, and so
       * drifted one BD from there on — which is why snapBase and
       * gridSpacing used to come back as 6e-294 and 1e-314. A drawing
       * laid out at an angle needs the twist: without it the model draws
       * rotated, and DXF group 51 goes out a confident zero. */
      const name = x.tableFlags();
      const height = r.bd();
      /* The double after the height is the view WIDTH, not the ratio.
       * DXF group 41 is width / height: AutoCAD 2027's own table reports
       * 41 = 2.3517 for a record storing 8.0457 beside a 3.4212 height
       * (2.3517 x 3.4212 = 8.0457, and LibreDWG divides here too), so
       * the ratio the model speaks is derived at this boundary. */
      const viewWidth = r.bd();
      const aspectRatio = Number.isFinite(viewWidth) && Number.isFinite(height)
        && height > 0 && viewWidth > 0 ? viewWidth / height : undefined;
      const cx = r.rd(), cy = r.rd();
      const [tx, ty, tz] = r.bd3();       /* target comes BEFORE direction */
      const [dx2, dy2, dz2] = r.bd3();
      const twist = r.bd();
      const lensLength = r.bd();
      const frontClip = r.bd();
      const backClip = r.bd();
      /* The mode field is four bits, and only the first three of them are
       * VIEWMODE — low bit first: perspective (DXF 1), front clip (2),
       * back clip (4). Graded against AutoCAD's own DXFOUT: a drawing
       * with DVIEW front clipping on reads 0,1,0 here and AutoCAD writes
       * 71 = 2, while six otherwise-identical files read 0,0,0 and get
       * 71 = 0. The fourth bit is 1 in every genuine file measured and is
       * NOT view mode — turning front clipping on does not make AutoCAD
       * report bit 16, in either DXF flavour. UCSFOLLOW is not in here
       * either; it is the separate flag below, which AutoCAD folds into
       * group 71 as bit 8 on export. */
      const viewMode = r.b() | (r.b() << 1) | (r.b() << 2);
      r.b();                              /* the fourth bit: always 1 */
      const renderMode = v >= 2000 ? r.rc() : undefined;
      if (v >= 2007) {
        r.b();                            /* use default lights */
        r.rc();                           /* default lighting type */
        r.bd(); r.bd();                   /* brightness, contrast */
        x.cmc();                          /* ambient colour */
      }
      const llx = r.rd(), lly = r.rd();
      const urx = r.rd(), ury = r.rd();
      const ucsFollow = r.b() === 1;
      const circleSides = r.bs();
      const fastZoom = r.b() === 1;
      /* two flags, low bit first: icon on, then icon at origin. Graded on
         three drawings saved with UCSICON 3, 1 and 0 — read the other way
         round the middle two swap. */
      const ucsIcon = r.b() | (r.b() << 1);
      const gridOn = r.b() === 1;
      const gsx = r.rd(), gsy = r.rd();
      const snapOn = r.b() === 1;
      const snapStyle = r.b();
      const snapIsoPair = r.bs();
      const snapAngle = r.bd();
      const sbx = r.rd(), sby = r.rd();
      const ssx = r.rd(), ssy = r.rd();
      const vport: VPort = {
        name,
        lowerLeft: { x: llx, y: lly }, upperRight: { x: urx, y: ury },
        center: { x: cx, y: cy },
        height, aspectRatio,
        direction: pt3(dx2, dy2, dz2), target: pt3(tx, ty, tz),
        twist, lensLength, frontClip, backClip, viewMode,
        circleSides, fastZoom, ucsIcon, ucsFollow, gridOn,
        snapOn, snapStyle, snapIsoPair, snapAngle,
        snapBase: { x: sbx, y: sby }, snapSpacing: { x: ssx, y: ssy },
        gridSpacing: { x: gsx, y: gsy }
      };
      if (renderMode !== undefined) vport.renderMode = renderMode;
      if (v >= 2000) {
        /* R2000 gave every viewport its own UCS. The flag ahead of it is
           UCSICON's third bit: AutoCAD reports group 74 as 5 rather than 1
           when it is set, which is how it was told apart from the
           "unknown" it had been read as. */
        vport.ucsIcon = ucsIcon | (r.b() << 2);
        vport.ucsPerViewport = r.b() === 1;
        const [ox, oy, oz] = r.bd3();
        const [uxx, uxy, uxz] = r.bd3();
        const [uyx, uyy, uyz] = r.bd3();
        vport.ucsOrigin = pt3(ox, oy, oz);
        vport.ucsXAxis = pt3(uxx, uxy, uxz);
        vport.ucsYAxis = pt3(uyx, uyy, uyz);
        vport.ucsElevation = r.bd();
        vport.ucsOrthoType = r.bs();
      }
      raw.table = { kind: 'vport', name };
      raw.vport = vport;
      return;
    }

    case 'XRECORD': {
      /* a byte-counted run of (RS group code, typed value) pairs */
      const size = r.bl();
      if (size < 0 || size > 0x1000000) return;
      const start = r.pos;
      /* the declared size is not always honest: clamp it to the record so
         an over-long claim stops the run cleanly instead of overrunning
         and losing every value already parsed */
      const end = Math.min(start + size * 8, r.endBit);
      const values: XdataValue[] = [];
      while (r.pos + 16 <= end) {
        const code = r.rs();
        if (code < 0 || code >= 2000) break;
        const kind = resbufKind(code);
        if (kind === 'string') {
          const len = r.rs();
          if (v >= 2007) {
            if (r.pos + len * 16 > end) break;
            let s = '';
            for (let i = 0; i < len; i++) s += String.fromCharCode(r.rs());
            values.push({ code, value: decodeCadText(s.replace(/\0+$/, '')) });
          } else {
            r.rc();                       /* codepage */
            if (len < 0 || r.pos + len * 8 > end) break;
            values.push({
              code,
              value: decodeCadText(decodeCodepage(r.bytes(len), x.c.codepage))
            });
          }
        } else if (kind === 'real') {
          values.push({ code, value: r.rd() });
        } else if (kind === 'point') {
          values.push({ code, point: { x: r.rd(), y: r.rd(), z: r.rd() } });
        } else if (kind === 'int8' || kind === 'bool') {
          values.push({ code, value: r.rc() });
        } else if (kind === 'int16') {
          const n = r.rs();
          values.push({ code, value: n >= 0x8000 ? n - 0x10000 : n });
        } else if (kind === 'int32') {
          const n = r.rl();
          values.push({ code, value: n > 0x7fffffff ? n - 0x100000000 : n });
        } else if (kind === 'int64') {
          values.push({ code, value: r.rll() });
        } else if (kind === 'binary') {
          const len = r.rc();
          if (r.pos + len * 8 > end) break;
          let hex = '';
          for (const b of r.bytes(len)) {
            hex += b.toString(16).padStart(2, '0').toUpperCase();
          }
          values.push({ code, value: hex });
        } else if (kind === 'handle') {
          /* absolute reference: little-endian 64-bit */
          values.push({ code, value: r.rll().toString(16).toUpperCase() });
        } else {
          break;                          /* unknown group: stop cleanly */
        }
      }
      /* land on the declared end, but never past the record's own data:
         an overstated size used to walk the cursor off the end and throw
         away every value already parsed */
      r.pos = Math.min(end, x.dataEnd, r.endBit);
      if (v >= 2000 && r.pos + 2 <= Math.min(x.dataEnd, r.endBit)) {
        r.bs();                           /* cloning flag */
      }
      raw.xrecord = { values };
      return;
    }

    case 'IMAGEDEF': {
      const classVersion = r.bl();
      if (classVersion > 10) return;
      r.rd(); r.rd();                     /* image size in pixels */
      raw.imageDef = { path: x.text() || undefined };
      return;
    }

    case 'SORTENTSTABLE': {
      /* Draw order. DATA: BL count, then count sort handles inline (plain
         absolute refs); HANDLE stream (after the common owner/reactors/
         xdict run): the owning BLOCK_RECORD, then count entity handles.
         Entry i pairs ents[i] with sort key sorts[i]; drawing order is
         ascending key, and an entity no entry names sorts under its own
         handle. Verified pair-for-pair against AutoCAD's own DXF export
         of a 193,382-entry table. */
      const num = r.bl();
      if (num < 0 || num > 5000000) throw new RangeError('sortents count');
      const sorts: number[] = [];
      for (let i = 0; i < num; i++) sorts.push(r.hValue());
      const blockOwner = x.hr.hAbs(raw.handle);
      const ents: number[] = [];
      for (let i = 0; i < num; i++) ents.push(x.hr.hAbs(raw.handle));
      raw.sortents = { blockOwner, ents, sorts };
      return;
    }

    default:
      return;                             /* other objects: identity only */
  }
};

/* ------------------------------------------------------------------ *
 * entry point
 * ------------------------------------------------------------------ */

/** Decode one object body (the bytes after its MS size field).
 *  `bitsizeOverride` carries the R2010+ handle-stream split. */
export const decodeObjectBody = (
  body: Uint8Array, ctx: DecodeContext, bitsizeOverride?: number
): RawObject | null => {
  const r = new BitReader(body);
  let type: number;
  if (ctx.v >= 2010) {
    const bb = r.bb();                    /* BOT-encoded object type */
    if (bb === 0) type = r.rc();
    else if (bb === 1) type = r.rc() + 0x1f0;
    else type = r.rs();
  } else {
    type = r.bs();
  }

  let bitsize: number;
  if (ctx.v >= 2000 && ctx.v <= 2007) bitsize = r.rl();
  else if (ctx.v >= 2010) bitsize = bitsizeOverride ?? body.length * 8;
  else bitsize = body.length * 8;         /* R13/R14: read inside the record */
  if (bitsize > body.length * 8) bitsize = body.length * 8;

  let typeName = FIXED_TYPES[type];
  let isEntity = typeName ? ENTITY_TYPE(type) : false;
  if (!typeName) {
    const cls = ctx.classes.get(type);
    typeName = cls?.dxfName ?? `CLASS_${type}`;
    isEntity = cls?.isEntity ?? false;
  }

  const hr = new BitReader(body, bitsize);
  const ss = ctx.v >= 2007 ? stringStream(body, bitsize) : null;
  const sr = ss ? ss.r : null;
  /* Where the data area truly ends: at the string stream's first bit when
   * one exists (sr.pos is untouched here), else just short of the R2007+
   * strings-present flag bit, else at the handle stream. */
  const dataEnd = sr ? sr.pos
    : ctx.v >= 2007 ? Math.max(0, bitsize - 1) : bitsize;
  const x = new Ctx(ctx, r, hr, sr, dataEnd);
  if (ss) { x.srStart = ss.r.pos; x.srBits = ss.bits; }

  const raw: RawObject = { handle: 0, typeName, isEntity };

  if (isEntity) {
    const common = x.commonEntity();
    raw.handle = common.handle;
    raw.entmode = common.entmode;
    raw.hasDsData = x.hasDsData || undefined;
    raw.proxyGraphics = x.proxyGraphics;
    raw.owner = x.ownerHandle;
    if (x.xdictHandle) raw.xdict = x.xdictHandle;
    raw.layerHandle = x.layerHandle;
    raw.ltypeFlags = common.ltypeFlags;
    raw.ltypeHandle = x.ltypeHandle;
    raw.prev = x.prevHandle;
    raw.next = x.nextHandle;
    let entity: Entity | null = null;
    /* Snapshot the three streams before the type-specific decode. A record
       the semantic layer cannot model — an unknown class, or a known type
       whose decode fails — rewinds here and is retained SEALED: payload
       bit-exact, string stream verbatim, remaining handle references
       code-for-code. Ignorance downgrades the view, never loses the data. */
    const dpos = r.pos;
    const hpos = x.hr.pos;
    const spos = x.sr?.pos;
    let failed = false;
    try {
      entity = decodeEntitySpecific(x, typeName, raw);
    } catch {
      failed = true;
    }
    const structural = STRUCTURAL_TYPES.has(typeName) || typeName.startsWith('VERTEX_');
    const bareUnknown = entity?.type === 'unknown' && entity.data === undefined;
    if ((failed || bareUnknown) && !structural) {
      r.pos = dpos;
      x.hr.pos = hpos;
      if (x.sr && spos !== undefined) x.sr.pos = spos;
      const cls = ctx.classes.get(type);
      entity = {
        type: 'unknown', layer: '0', color: { kind: 'byLayer' },
        sourceType: cls?.dxfName ?? typeName,
        appClass: cls
          ? { dxfName: cls.dxfName, cppName: cls.cppName, appName: cls.appName }
          : undefined,
        typeCode: FIXED_TYPES[type] ? type : undefined,
        encoding: encodingGroup(ctx.v),
        ...captureSealed(x)
      };
    } else if (failed) {
      entity = null;                      /* structural member: folds later */
    }
    if (entity) {
      /* the type-specific decode is what reads the style reference */
      raw.styleHandle = x.styleHandle;
      entity.handle = raw.handle.toString(16).toUpperCase();
      if (x.xdictHandle) entity.xdict = x.xdictHandle.toString(16).toUpperCase();
      if (x.reactors) entity.reactors = x.reactors.map((h) => h.toString(16).toUpperCase());
      entity.color = common.color;
      if (common.ltypeScale !== 1) entity.linetypeScale = common.ltypeScale;
      if (common.lineweight !== undefined) entity.lineweight = common.lineweight;
      if (common.invisible) entity.invisible = true;
      if (x.xdata) entity.xdata = x.xdata;
      raw.entity = entity;
    } else if (raw.polyline || raw.mesh) {
      /* the header of a heavy polyline or mesh becomes an entity only
         once its vertices are folded in; its own colour, scale, weight
         and EED wait here for that */
      raw.folded = {
        color: common.color, ltypeScale: common.ltypeScale,
        lineweight: common.lineweight, invisible: common.invisible,
        xdata: x.xdata
      };
    }
    return raw;
  }

  const isControl = CONTROL_TYPES.has(type);
  const common = x.commonObject(isControl);
  raw.handle = common.handle;
  raw.owner = x.ownerHandle;
  if (x.xdictHandle) raw.xdict = x.xdictHandle;
  if (x.reactors) raw.reactors = x.reactors;
  const dpos = r.pos;
  const hpos = x.hr.pos;
  const spos = x.sr?.pos;
  let failed = false;
  try {
    decodeObjectSpecific(x, typeName, raw);
  } catch {
    /* keep whatever partial table record was built before the failure —
       a block header with just a name still anchors its entities */
    failed = true;
  }
  /* Universal passthrough for the object side: a class object no decoder
     modeled, or a failed decode with nothing salvaged, is retained sealed
     the same way unknown entities are. */
  const cls = ctx.classes.get(type);
  const modeled = raw.dictionary || raw.layout || raw.group || raw.xrecord
    || raw.imageDef || raw.underlayDef || raw.visibility || raw.blockParam
    || raw.blockAction || raw.tableContent || raw.geoData || raw.mlineStyle
    || raw.table || raw.proxyObject || raw.ucs || raw.view || raw.vport
    || raw.sortents || raw.tableStyleObj || raw.mleaderStyleObj
    || raw.dictionaryVar;
  if ((failed && !modeled) || (cls && !modeled && !isControl)
    || (!modeled && !isControl && SEAL_FIXED.has(typeName))) {
    r.pos = dpos;
    x.hr.pos = hpos;
    if (x.sr && spos !== undefined) x.sr.pos = spos;
    raw.unknownObject = {
      sourceType: cls?.dxfName ?? typeName,
      appClass: cls
        ? { dxfName: cls.dxfName, cppName: cls.cppName, appName: cls.appName }
        : undefined,
      typeCode: FIXED_TYPES[type] ? type : undefined,
      encoding: encodingGroup(ctx.v),
      ...captureSealed(x),
      /* the seal starts past the common prologue, so the EED read there
         is carried beside it — a record may be nothing but its EED */
      ...(x.xdata ? { xdata: x.xdata } : {})
    };
  } else if (!failed && modeled && DUAL_SEALED.has(typeName)) {
    /* Modeled AND sealed: the records of an ownership chain the writer
       re-attaches rather than re-creates — an extension dictionary and
       the XRECORDs it lists, the nodes of a dynamic block's evaluation
       graph. The decoded view feeds the model (dictionary names, xrecord
       values, the block's parameters and states); the seal is what goes
       back out under the original owner. The reader keeps the seal only
       where the chain is not its own to rebuild (see reader.ts). */
    r.pos = dpos;
    x.hr.pos = hpos;
    if (x.sr && spos !== undefined) x.sr.pos = spos;
    raw.unknownObject = {
      sourceType: cls?.dxfName ?? typeName,
      appClass: cls
        ? { dxfName: cls.dxfName, cppName: cls.cppName, appName: cls.appName }
        : undefined,
      typeCode: FIXED_TYPES[type] ? type : undefined,
      encoding: encodingGroup(ctx.v),
      ...captureSealed(x),
      ...(x.xdata ? { xdata: x.xdata } : {})
    };
  }
  return raw;
};
