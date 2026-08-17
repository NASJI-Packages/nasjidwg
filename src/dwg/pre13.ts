/* nasjidwg — pre-R13 DWG reader (AC1.50 … AC1009, i.e. R2.0 to R12).
 *
 * These releases predate the bit-packed object format entirely: the file
 * is a fixed header, five to seven fixed-record tables, and three flat
 * runs of entities (model space, block definitions, "extras"). Records are
 * byte-aligned little-endian, and every entity is a one-byte type plus a
 * flag byte whose bits announce which optional fields follow.
 */

import type {
  Drawing, Entity, FileVersion, Layer, Linetype, MeshEntity, Point2, Point3,
  PolylineVertex, TextStyle, XdataGroup, XdataValue
} from '../core/model.js';
import { emptyDrawing } from '../core/model.js';
import { decodeCadText } from '../text/escapes.js';
import { decodeCodepage } from './bitstream.js';
import { detectVersion } from './fileheader.js';

/** How the pre-R13 releases order, for the layout decisions below. */
const ORDER: FileVersion[] = [
  'R1.1', 'R1.2', 'R1.3', 'R1.4', 'R2.0', 'R2.10', 'R2.21', 'R2.22',
  'R2.4', 'R2.5', 'R2.6', 'R9', 'R10', 'R12'
];

export const preR13Version = (data: Uint8Array): FileVersion => {
  const v = detectVersion(data);
  return ORDER.includes(v) ? v : 'R12';
};

/* ------------------------------------------------------------------ */

/** Byte cursor over the file. */
class Cur {
  pos = 0;
  private dv: DataView;
  constructor(readonly data: Uint8Array) {
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get end(): number { return this.data.length; }
  need(n: number): void {
    if (this.pos + n > this.data.length) throw new RangeError('pre-R13: past end');
  }
  rc(): number { this.need(1); return this.data[this.pos++]; }
  rs(): number { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  rsu(): number { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  rl(): number { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  rd(): number { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  pt2(): [number, number] { return [this.rd(), this.rd()]; }
  pt3(): Point3 { return { x: this.rd(), y: this.rd(), z: this.rd() }; }
  /** Length-prefixed string (a 16-bit count before R13). */
  tv(codepage?: string): string { return this.name(this.rsu(), codepage); }
  /** Fixed-length NUL-padded name field. */
  name(n: number, codepage?: string): string {
    this.need(n);
    const raw = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    let len = raw.length;
    while (len > 0 && raw[len - 1] === 0) len--;
    return decodeCadText(decodeCodepage(raw.subarray(0, len), codepage));
  }
}

interface TableInfo { size: number; count: number; address: number }

const readTableInfo = (c: Cur): TableInfo => {
  const size = c.rsu();
  const count = c.rs();
  c.rsu();                                /* flags */
  const address = c.rl();
  return { size, count, address };
};

/* entity type numbers (the same list every pre-R13 release uses) */
const T_LINE = 1, T_POINT = 2, T_CIRCLE = 3, T_SHAPE = 4,
  T_REPEAT = 5, T_ENDREP = 6,
  T_TEXT = 7, T_ARC = 8, T_TRACE = 9, T_LOAD = 10, T_SOLID = 11,
  T_BLOCK = 12, T_ENDBLK = 13, T_INSERT = 14, T_ATTDEF = 15, T_ATTRIB = 16,
  T_SEQEND = 17, T_JUMP = 18, T_POLYLINE = 19, T_VERTEX = 20, T_3DLINE = 21,
  T_3DFACE = 22, T_DIMENSION = 23, T_VIEWPORT = 24;

const TYPE_NAMES: Record<number, string> = {
  [T_LINE]: 'LINE', [T_POINT]: 'POINT', [T_CIRCLE]: 'CIRCLE',
  [T_SHAPE]: 'SHAPE', 5: 'REPEAT', 6: 'ENDREP', [T_TEXT]: 'TEXT',
  [T_ARC]: 'ARC', [T_TRACE]: 'TRACE', 10: 'LOAD', [T_SOLID]: 'SOLID',
  [T_BLOCK]: 'BLOCK', [T_ENDBLK]: 'ENDBLK', [T_INSERT]: 'INSERT',
  [T_ATTDEF]: 'ATTDEF', [T_ATTRIB]: 'ATTRIB', [T_SEQEND]: 'SEQEND',
  18: 'JUMP', [T_POLYLINE]: 'POLYLINE', [T_VERTEX]: 'VERTEX',
  [T_3DLINE]: '3DLINE', [T_3DFACE]: '3DFACE', [T_DIMENSION]: 'DIMENSION',
  [T_VIEWPORT]: 'VIEWPORT'
};

/* common flag bits */
const F_COLOR = 1, F_LTYPE = 2, F_ELEVATION = 4, F_THICKNESS = 8,
  F_HANDLING = 32, F_PSPACE = 64, F_ATTRIBS = 128;
const X_EED = 2, X_VIEWPORT = 4;

/* polyline flag bits (the same set DXF group 70 uses) */
const P_CLOSED = 1, P_3D = 8, P_MESH = 16, P_PFACE = 64;
/* vertex flag bits */
const V_3D = 32, V_MESH = 64, V_PFACE = 128;

interface Common {
  type: number;
  /** Set for records the drawing deleted but the file still carries. */
  erased: boolean;
  /** Total record length from its first byte, including any trailing CRC. */
  size: number;
  flag: number;
  layerIndex: number;
  colorIndex?: number;
  ltypeIndex?: number;
  elevation: number;
  thickness?: number;
  paperSpace: boolean;
  opts: number;
  handle?: string;
  xdata?: XdataGroup[];
}

/** Parse one pre-R13 extended-data block (the R13+ item codes, byte-aligned). */
const parseEedBlock = (raw: Uint8Array, codepage: string): XdataGroup[] => {
  const c = new Cur(raw);
  const values: XdataValue[] = [];
  let appName: string | undefined;
  try {
    while (c.pos < raw.length) {
      const code = c.rc();
      switch (code) {
        case 0: case 1: {                 /* 1000 string / 1001 app name */
          const s = c.name(c.rc(), codepage);
          if (code === 1 && appName === undefined) appName = s;
          else values.push({ code: 1000 + code, value: s });
          break;
        }
        case 2:                           /* 1002 { or } */
          values.push({ code: 1002, value: c.rc() === 0 ? '{' : '}' });
          break;
        case 3: case 5:                   /* layer / entity reference */
          values.push({ code: 1000 + code, value: c.rl() + ':' + c.rl() });
          break;
        case 4: {                         /* 1004 binary chunk */
          const n = c.rc();
          let hex = '';
          for (let i = 0; i < n; i++) hex += c.rc().toString(16).padStart(2, '0');
          values.push({ code: 1004, value: hex.toUpperCase() });
          break;
        }
        case 10: case 11: case 12: case 13:
          values.push({ code: 1000 + code, point: c.pt3() });
          break;
        case 40: case 41: case 42:
          values.push({ code: 1000 + code, value: c.rd() });
          break;
        case 70: values.push({ code: 1070, value: c.rs() }); break;
        case 71: values.push({ code: 1071, value: c.rl() | 0 }); break;
        default: return values.length || appName
          ? [{ appName, values }] : [];    /* unknown item: keep what we have */
      }
    }
  } catch { /* truncated block: keep what was read */ }
  return values.length || appName ? [{ appName, values }] : [];
};

/** Read a pre-R13 file into a Drawing. */
export const readPreR13 = (data: Uint8Array): Drawing => {
  const version = preR13Version(data);
  /* release ordering — several field widths and 2D/3D choices depend on it */
  const ord = ORDER.indexOf(version);
  const isR2plus = ord >= 4;              /* R2.0 introduced the flag word */
  const isR10plus = ord >= 12;            /* R10 put z inline on 3D types */
  const isR11plus = ord >= 13;            /* AC1009 widened a few fields */

  const drawing = emptyDrawing();
  drawing.header.version = version;
  const warnings = drawing.warnings;

  /* the header record begins right after the 11-byte version block */
  const c = new Cur(data);
  c.pos = 0x0B;
  c.rc();                                 /* maintenance release */

  let entitiesStart = 0, entitiesEnd = 0;
  let blocksStart = 0, blocksSize = 0, extrasStart = 0, extrasSize = 0;
  let numSections = 0, numHeaderVars = 0;
  if (isR2plus) {
    c.rc();                               /* zero_one_or_three */
    c.rsu();                              /* number of entity sections */
    numSections = c.rsu();
    numHeaderVars = c.rsu();
    c.rc();                               /* dwg version */
    entitiesStart = c.rl();
    entitiesEnd = c.rl();
    blocksStart = c.rl();
    /* the top byte of these lengths tags which run they describe */
    blocksSize = c.rl() & 0xffffff;
    extrasStart = c.rl();
    extrasSize = c.rl() & 0xffffff;
  } else {
    /* the first releases have no section table at all: the drawing
       variables follow the version block and the entities follow them */
    c.pt3();                              /* INSBASE */
    entitiesEnd = c.rl();                 /* total drawing size */
    c.rsu();                              /* entity count */
    c.pt3(); c.pt3();                     /* EXTMIN, EXTMAX */
    c.pt2(); c.pt2();                     /* LIMMIN, LIMMAX */
    c.pt3(); c.rd();                      /* VIEWCTR, VIEWSIZE */
    c.rsu(); c.rd();                      /* SNAPMODE, snap x */
    c.rsu(); c.rd();                      /* GRIDMODE, grid x */
    c.rsu(); c.rsu(); c.rsu();            /* ORTHOMODE, REGENMODE, FILLMODE */
    c.rd(); c.rd();                       /* TEXTSIZE, TRACEWID */
    c.rsu(); c.rsu();                     /* CLAYER, CECOLOR */
    for (let i = 0; i < 128; i++) c.rsu();  /* per-layer colours */
    if (ord >= 1) {                       /* R1.2 added these two */
      c.rd(); c.rd();                     /* DIMARROW, aspect ratio */
      if (ord >= 2) {                     /* R1.3 and R1.4 continue */
        c.rsu(); c.rsu();                 /* LUNITS, LUPREC */
        if (ord >= 3) { c.rsu(); c.rsu(); }   /* R1.4: DIMTOL, DIMLIM */
        c.rsu(); c.pt2();                 /* AXISMODE, AXISUNIT */
        c.rd(); c.rd();                   /* SKETCHINC, FILLETRAD */
      }
    }
    entitiesStart = c.pos;
    if (!entitiesEnd || entitiesEnd > data.length) entitiesEnd = data.length;
  }

  /* the fixed-record tables, in their fixed order */
  const tables: Record<string, TableInfo> = {};
  const order = ['BLOCK', 'LAYER', 'STYLE', 'LTYPE', 'VIEW',
    'UCS', 'VPORT', 'APPID', 'DIMSTYLE', 'VX'];
  for (let i = 0; i < Math.min(numSections, order.length); i++) {
    try {
      tables[order[i]] = readTableInfo(c);
    } catch { break; }
  }
  /* AC1009 embeds the last five table directories at fixed offsets among
     the drawing variables rather than in the run above */
  if (isR11plus) {
    const EMBEDDED: Array<[string, number]> = [
      ['UCS', 0x3EF], ['VPORT', 0x500], ['APPID', 0x512],
      ['DIMSTYLE', 0x522], ['VX', 0x69F]
    ];
    for (const [name, at] of EMBEDDED) {
      if (tables[name] || at + 10 > data.length) continue;
      const t = new Cur(data);
      t.pos = at;
      try { tables[name] = readTableInfo(t); } catch { /* damaged header */ }
    }
  }

  const codepage = 'ANSI_1252';

  /* The drawing variables follow the table directory as a flat, ordered
     run. How far it goes is announced by the header-variable count. */
  const vars: Record<string, unknown> = {};
  if (isR2plus) {
    try {
      const pt2 = (): Point2 => { const [x, y] = c.pt2(); return { x, y }; };
      vars.INSBASE = c.pt3();
      if (isR10plus) vars.PLINEGEN = c.rsu();
      else vars.numEntities = c.rsu();
      /* same guard the R13+ path applies: pre-R13 files carry the +-1e20
         "extents never set" sentinel, and it must not reach the model */
      const sane = (p: { x: number; y: number; z?: number }): boolean =>
        [p.x, p.y, p.z ?? 0].every(
          (q) => Number.isFinite(q) && Math.abs(q) < 1e19);
      const exMin = c.pt3(), exMax = c.pt3();
      if (sane(exMin) && sane(exMax)) {
        drawing.header.extMin = exMin;
        drawing.header.extMax = exMax;
      }
      const liMin = pt2(), liMax = pt2();
      if (sane(liMin) && sane(liMax)) {
        drawing.header.limMin = liMin;
        drawing.header.limMax = liMax;
      }
      vars.VIEWCTR = c.pt3();
      vars.VIEWSIZE = c.rd();
      vars.SNAPMODE = c.rsu();
      vars.SNAPUNIT = pt2();
      vars.SNAPBASE = pt2();
      vars.SNAPANG = c.rd();
      vars.SNAPSTYLE = c.rsu();
      vars.SNAPISOPAIR = c.rsu();
      vars.GRIDMODE = c.rsu();
      vars.GRIDUNIT = pt2();
      vars.ORTHOMODE = c.rsu();
      vars.REGENMODE = c.rsu();
      vars.FILLMODE = c.rsu();
      vars.QTEXTMODE = c.rsu();
      vars.DRAGMODE = c.rsu();
      drawing.header.linetypeScale = c.rd();
      vars.TEXTSIZE = c.rd();
      vars.TRACEWID = c.rd();
      const clayer = c.rs();
      c.rl(); c.rl();                     /* colour carried over from older files */
      c.rsu();                            /* unknown */
      if (isR10plus) {
        vars.PSLTSCALE = c.rsu();
        vars.TREEDEPTH = c.rsu();
        c.rsu();
      } else { c.rsu(); c.rsu(); c.rsu(); }
      c.rd();                             /* aspect ratio (derived) */
      vars.LUNITS = c.rsu();
      vars.LUPREC = c.rsu();
      vars.AXISMODE = c.rsu();
      vars.AXISUNIT = pt2();
      vars.SKETCHINC = c.rd();
      vars.FILLETRAD = c.rd();
      vars.AUNITS = c.rsu();
      vars.AUPREC = c.rsu();
      const textStyle = c.rs();
      vars.OSMODE = c.rsu();
      vars.ATTMODE = c.rsu();
      vars.MENU = c.name(15, codepage);
      for (const key of ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE',
        'DIMTP', 'DIMTM', 'DIMTXT', 'DIMCEN', 'DIMTSZ']) vars[key] = c.rd();
      for (const key of ['DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1',
        'DIMSE2', 'DIMTAD']) vars[key] = c.rc();
      if (numHeaderVars > 74) {
        vars.LIMCHECK = c.rc();
        c.pos += 46;                      /* menu name overflow */
        vars.ELEVATION = c.rd();
        vars.THICKNESS = c.rd();
        vars.VIEWDIR = c.pt3();
        c.pt3(); c.pt3(); c.pt3();        /* view direction basis */
        c.pt3(); c.pt3(); c.pt3();        /* and its alternate */
        c.rsu();                          /* 3d flag */
        vars.BLIPMODE = c.rsu();
      }
      /* resolved once the tables are read, below */
      vars.$CLAYER = clayer;
      vars.$TEXTSTYLE = textStyle;
    } catch {
      warnings.push('drawing variables could not be read fully.');
    }
  }

  /* ---- LAYER table: index -> name, and the layer list ---- */
  const layerByIndex = new Map<number, string>();
  const readTable = <T>(
    info: TableInfo | undefined, each: (rec: Cur, index: number) => T | null
  ): T[] => {
    const out: T[] = [];
    if (!info || info.count <= 0 || info.size <= 0) return out;
    for (let i = 0; i < info.count; i++) {
      const at = info.address + i * info.size;
      if (at + info.size > data.length) break;
      const rec = new Cur(data);
      rec.pos = at;
      try {
        const v = each(rec, i);
        if (v) out.push(v);
      } catch { /* skip a damaged record, keep the table */ }
    }
    return out;
  };

  /** Flag byte + 32-byte name + (from R11) a use count. */
  const recordHead = (rec: Cur): { flag: number; name: string } => {
    const flag = rec.rc();
    const name = rec.name(32, codepage);
    if (isR11plus) rec.rs();              /* use count — R11 only */
    return { flag, name };
  };

  const layerLtype = new Map<string, number>();
  drawing.layers = readTable<Layer>(tables.LAYER, (rec, i) => {
    const { flag, name } = recordHead(rec);
    if (!name) return null;
    const colorIndex = rec.rs();          /* negative means the layer is off */
    layerLtype.set(name, rec.rs());
    layerByIndex.set(i, name);
    return {
      name,
      color: { kind: 'aci', index: Math.abs(colorIndex) || 7 },
      on: colorIndex >= 0,
      frozen: (flag & 1) !== 0,
      locked: (flag & 4) !== 0
    };
  });
  if (!drawing.layers.length) drawing.layers = emptyDrawing().layers;

  drawing.textStyles = readTable<TextStyle>(tables.STYLE, (rec) => {
    const { name } = recordHead(rec);
    if (!name) return null;
    const fixedHeight = rec.rd();
    const widthFactor = rec.rd();
    rec.rd();                             /* oblique angle */
    rec.rc();                             /* generation flags */
    rec.rd();                             /* last height used */
    const font = rec.name(64, codepage);
    const bigFont = ord >= 8 ? rec.name(64, codepage) : '';
    return {
      name,
      font: font || undefined,
      bigFont: bigFont || undefined,
      fixedHeight: fixedHeight || undefined,
      widthFactor: widthFactor !== 1 ? widthFactor : undefined
    };
  });
  if (!drawing.textStyles.length) drawing.textStyles = [{ name: 'Standard' }];

  const ltypeByIndex = new Map<number, string>();
  drawing.linetypes = readTable<Linetype>(tables.LTYPE, (rec, i) => {
    const { name } = recordHead(rec);
    if (!name) return null;
    const description = rec.name(48, codepage);
    if (isR11plus) { rec.rc(); rec.rc(); }  /* alignment 'A' + dash count */
    rec.rd();                             /* total pattern length */
    /* the dash array is a fixed run of twelve, zero-padded */
    const pattern: number[] = [];
    for (let k = 0; k < 12; k++) pattern.push(rec.rd());
    while (pattern.length && pattern[pattern.length - 1] === 0) pattern.pop();
    ltypeByIndex.set(i, name);
    return { name, description: description || undefined, pattern };
  });
  if (!drawing.linetypes.length) {
    drawing.linetypes = [{ name: 'Continuous', description: 'Solid line', pattern: [] }];
  }
  for (const layer of drawing.layers) {
    const lt = ltypeByIndex.get(layerLtype.get(layer.name) ?? -1);
    if (lt) layer.linetype = lt;
  }

  /* ---- the remaining named tables ---- */
  const viewSize = tables.VIEW?.size ?? 0;
  drawing.views = readTable(tables.VIEW, (rec) => {
    const { name } = recordHead(rec);
    if (!name) return null;
    const height = rec.rd();
    const [cx, cy] = rec.pt2();
    if (viewSize === 58) rec.rc();
    const width = viewSize > 58 ? rec.rd() : height;
    const direction = viewSize > 66 ? rec.pt3() : undefined;
    return { name, center: { x: cx, y: cy }, height, width, direction };
  });
  drawing.ucs = readTable(tables.UCS, (rec) => {
    const { name } = recordHead(rec);
    if (!name) return null;
    return { name, origin: rec.pt3(), xAxis: rec.pt3(), yAxis: rec.pt3() };
  });
  drawing.vports = readTable(tables.VPORT, (rec) => {
    const { name } = recordHead(rec);
    if (!name) return null;
    const [lx, ly] = rec.pt2();
    const [ux, uy] = rec.pt2();
    const viewTarget = rec.pt3();
    const viewDirection = rec.pt3();
    rec.rd();                             /* view twist */
    const height = rec.rd();
    const [vx, vy] = rec.pt2();
    const aspectRatio = rec.rd();
    return {
      name,
      lowerLeft: { x: lx, y: ly }, upperRight: { x: ux, y: uy },
      center: { x: vx, y: vy }, height, aspectRatio,
      target: viewTarget, direction: viewDirection
    };
  });
  drawing.appIds = readTable(tables.APPID, (rec) => recordHead(rec).name || null);
  drawing.dimStyles = readTable(tables.DIMSTYLE, (rec) => {
    const { name } = recordHead(rec);
    if (!name) return null;
    const NUMS = ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE', 'DIMRND',
      'DIMDLE', 'DIMTP', 'DIMTM', 'DIMTXT', 'DIMCEN', 'DIMTSZ', 'DIMALTF',
      'DIMLFAC', 'DIMTVP'];
    const FLAGS = ['DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1', 'DIMSE2',
      'DIMTAD', 'DIMZIN', 'DIMALT', 'DIMALTD', 'DIMTOFL', 'DIMSAH', 'DIMTIX',
      'DIMSOXD'];
    const vars: Record<string, number | string | boolean> = {};
    for (const key of NUMS) vars[key] = rec.rd();
    for (const key of FLAGS) vars[key] = rec.rc();
    vars.DIMPOST = rec.name(16, codepage);
    vars.DIMAPOST = rec.name(16, codepage);
    vars.DIMBLK = rec.name(16, codepage);
    vars.DIMBLK1 = rec.name(16, codepage);
    vars.DIMBLK2 = rec.name(66, codepage);
    vars.DIMCLRD = rec.rs();
    vars.DIMCLRE = rec.rs();
    vars.DIMCLRT = rec.rs();
    vars.DIMUPT = rec.rc();
    vars.DIMTFAC = rec.rd();
    vars.DIMGAP = rec.rd();
    return { name, vars };
  });

  /* ---- block table: name -> the offset of its entities ---- */
  interface BlockRec { name: string; base: Point3; offset: number }
  /* Index positions matter here: INSERT and DIMENSION name their block by
     table position, so a nameless record still occupies its slot. */
  const blockRecs = readTable<BlockRec>(tables.BLOCK, (rec, i) => {
    const { flag, name } = recordHead(rec);
    /* offsets are relative to the start of the block entity run; the top
       byte, when present, only tags which run it is */
    const offset = rec.rl() & 0x3fffffff;
    /* anonymous blocks are all stored as "*D"; their table position is what
       tells them apart */
    const unique = name && (flag & 1) ? name + i : name;
    return { name: unique, base: { x: 0, y: 0, z: 0 }, offset };
  });

  /* the two table references in the header resolve now that the tables are in */
  if (Object.keys(vars).length) {
    const clayer = layerByIndex.get(vars.$CLAYER as number);
    if (clayer) vars.CLAYER = clayer;
    const style = drawing.textStyles[vars.$TEXTSTYLE as number];
    if (style) vars.TEXTSTYLE = style.name;
    delete vars.$CLAYER;
    delete vars.$TEXTSTYLE;
    drawing.header.vars = vars;
  }

  /* ---- entity reading ---- */
  /* table references are zero-based indices into the fixed-record tables */
  const layerName = (idx: number): string =>
    layerByIndex.get(idx) ?? drawing.layers[0].name;

  const readCommon = (e: Cur): Common => {
    /* type, flags, record length, layer, then a per-type option word; the
       flag bits announce which of the shared optional fields follow */
    if (!isR2plus) {
      /* the oldest form: a 16-bit type and a layer, nothing else */
      const raw = e.rsu();
      return {
        /* deleted records negate the type in its low byte */
        type: Math.abs((raw << 24) >> 24), erased: raw > 127, size: 0, flag: 0,
        layerIndex: e.rs(), elevation: 0, paperSpace: false, opts: 0
      };
    }
    const rawType = e.rc();
    const type = rawType & 0x7f;          /* the high bit marks an erased record */
    const erased = rawType > 127;
    const flag = e.rc();
    const size = e.rsu();                 /* whole record, incl. its CRC */
    if (type === T_JUMP) {                /* links carry no layer or options */
      return {
        type, erased, size, flag, layerIndex: 0, elevation: 0,
        paperSpace: false, opts: 0
      };
    }
    const layerIndex = e.rs();
    const opts = e.rsu();
    const out: Common = {
      type, erased, size, flag, layerIndex, elevation: 0,
      paperSpace: (flag & F_PSPACE) !== 0, opts
    };
    const extra = (flag & F_PSPACE) ? e.rc() : 0;
    if (extra & X_EED) {
      const n = e.rsu();                  /* one sized block, not a chain */
      if (n > 0 && e.pos + n <= e.end) {
        const groups = parseEedBlock(e.data.subarray(e.pos, e.pos + n), codepage);
        if (groups.length) out.xdata = groups;
        e.pos += n;
      }
    }
    if (flag & F_COLOR) out.colorIndex = (e.rc() << 24) >> 24;   /* signed */
    if (flag & F_LTYPE) out.ltypeIndex = isR11plus ? e.rs() : e.rc();
    /* from R10 the four fully-3D types carry their z inline instead */
    if ((flag & F_ELEVATION)
        && (!isR10plus
            || (type !== T_LINE && type !== T_POINT && type !== T_3DFACE
                && type !== T_3DLINE))) {
      out.elevation = e.rd();
    }
    if (flag & F_THICKNESS) out.thickness = e.rd();
    if (flag & F_HANDLING) {
      const b = e.rc();                   /* code in the high nibble, length low */
      const n = b & 0x0f;
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + e.rc();
      if (v) out.handle = v.toString(16).toUpperCase();
    }
    if (extra & X_VIEWPORT) e.rs();
    return out;
  };

  const applyCommon = (ent: Entity, common: Common): Entity => {
    ent.layer = layerName(common.layerIndex);
    if (common.colorIndex !== undefined && common.colorIndex !== 0) {
      const aci = Math.abs(common.colorIndex);
      if (aci >= 1 && aci <= 255) ent.color = { kind: 'aci', index: aci };
      if (common.colorIndex < 0) ent.invisible = true;
    }
    if (common.ltypeIndex !== undefined) {
      const lt = ltypeByIndex.get(common.ltypeIndex);
      if (lt) ent.linetype = lt;
    }
    if (common.handle) ent.handle = common.handle;
    if (common.xdata) ent.xdata = common.xdata;
    return ent;
  };

  interface Pending {
    kind: 'polyline' | 'mesh' | 'pface';
    poly?: Entity & { type: 'polyline' };
    mesh?: MeshEntity;
    verts: PolylineVertex[];
  }

  interface Ctx {
    entities: Entity[];
    pendingPolyline: Pending | null;
    pendingInsert: (Entity & { type: 'insert' }) | null;
    blockName: string | null;
    /** First byte of the run — block offsets are relative to it. */
    runStart: number;
  }

  /* A record list can hop between the three runs: a JUMP record names the
     address where the list continues. The top byte of that address, when
     set, selects the run and the rest is an offset into it. */
  const runs: Array<[number, number]> = [
    [entitiesStart, entitiesEnd],
    [blocksStart, blocksStart + blocksSize],
    [extrasStart, extrasStart + extrasSize]
  ];
  const resolveJump = (raw: number): [number, number] | null => {
    const tag = raw >>> 24;
    const target = tag
      ? (raw & 0xffffff) + (tag === 0x40 ? blocksStart
        : tag === 0x80 ? extrasStart : entitiesStart)
      : raw;
    for (const [from, to] of runs) {
      if (target >= from && target < to && to <= data.length) return [target, to];
    }
    return null;
  };
  /** Records already decoded, so a jump chain cannot revisit them. */
  const seen = new Set<number>();

  const readEntityRun = (
    start: number, end: number, out: Entity[], intoBlocks: boolean
  ): void => {
    if (start <= 0 || start >= data.length) return;
    let stop = Math.min(end, data.length);
    const e = new Cur(data);
    e.pos = start;
    const ctx: Ctx = {
      entities: out, pendingPolyline: null, pendingInsert: null,
      blockName: null, runStart: start
    };
    let guard = 0;
    while (e.pos < stop && guard++ < 500000) {
      const at = e.pos;
      if (seen.has(at)) break;
      seen.add(at);
      let common: Common;
      try {
        common = readCommon(e);
      } catch { break; }
      if (common.type === 0 || !(common.type in TYPE_NAMES)) break;
      if (common.type === T_JUMP) {
        let target: [number, number] | null = null;
        try { target = resolveJump(e.rl()); } catch { /* truncated */ }
        if (!target) break;
        [e.pos, stop] = target;
        continue;
      }
      let ent: Entity | null = null;
      try {
        ent = readEntityBody(e, common, ctx, intoBlocks, at);
      } catch {
        ent = {
          type: 'unknown', layer: '0', color: { kind: 'byLayer' },
          sourceType: TYPE_NAMES[common.type] ?? ('TYPE_' + common.type)
        };
      }
      /* deleted records stay in the file; they are not part of the drawing */
      if (common.erased) ent = null;
      if (ent) {
        applyCommon(ent, common);
        const target = ctx.blockName
          ? (drawing.blocks[ctx.blockName]?.entities ?? out)
          : out;
        if (common.paperSpace && !ctx.blockName) {
          (drawing.paperSpace ??= []).push(ent);
        } else {
          target.push(ent);
        }
      }
      /* every record states its own length, so the next one is found even
         when a body decoded only partially */
      if (common.size > 8 && at + common.size <= stop) e.pos = at + common.size;
      else if (e.pos <= at) break;        /* no progress: stop cleanly */
    }
  };

  /** A 2D point lifted to 3D with the record's elevation. */
  const p2 = (e: Cur, z: number): Point3 => {
    const [x, y] = e.pt2();
    return { x, y, z };
  };

  const readEntityBody = (
    e: Cur, common: Common, ctx: Ctx, intoBlocks: boolean, at: number
  ): Entity | null => {
    const opts = common.opts;
    const z = common.elevation;
    const hasElev = (common.flag & F_ELEVATION) !== 0;
    const base = { layer: '0', color: { kind: 'byLayer' } } as const;
    switch (common.type) {
      case T_LINE: {
        /* from R10 an unflagged line carries full 3D ends inline */
        const flat = !isR10plus || hasElev;
        const start = flat ? p2(e, z) : e.pt3();
        const end = flat ? p2(e, z) : e.pt3();
        if (opts & 1) e.pt3();            /* extrusion */
        return { ...base, type: 'line', start, end };
      }
      case T_3DLINE: {
        let start: Point3, end: Point3;
        if (isR10plus) {
          const flat = hasElev;
          start = flat ? p2(e, 0) : e.pt3();
          end = flat ? p2(e, 0) : e.pt3();
          if (opts & 1) e.pt3();
        } else {
          start = (opts & 1) ? e.pt3() : p2(e, z);
          end = (opts & 2) ? e.pt3() : p2(e, z);
        }
        return { ...base, type: 'line', start, end };
      }
      case T_POINT: {
        const [x, y] = e.pt2();
        const pz = (isR10plus && !hasElev) ? e.rd() : z;
        if (opts & 1) e.pt3();            /* extrusion */
        if (opts & 2) e.rd();             /* x angle */
        return { ...base, type: 'point', position: { x, y, z: pz } };
      }
      case T_CIRCLE: {
        const [x, y] = e.pt2();
        const radius = e.rd();
        if (opts & 1) e.pt3();            /* extrusion */
        const cz = (opts & 2) ? e.rd() : z;
        return { ...base, type: 'circle', center: { x, y, z: cz }, radius };
      }
      case T_ARC: {
        const [x, y] = e.pt2();
        const radius = e.rd();
        const startAngle = e.rd();
        const endAngle = e.rd();
        if (opts & 1) e.pt3();
        const cz = (opts & 2) ? e.rd() : z;
        return {
          ...base, type: 'arc', center: { x, y, z: cz }, radius,
          startAngle, endAngle
        };
      }
      case T_TRACE:
      case T_SOLID: {
        const c = [e.pt2(), e.pt2(), e.pt2(), e.pt2()];
        if (opts & 1) e.pt3();            /* extrusion */
        const sz = (opts & 2) ? e.rd() : z;
        return {
          ...base, type: 'solid',
          corners: [
            { x: c[0][0], y: c[0][1], z: sz }, { x: c[1][0], y: c[1][1], z: sz },
            { x: c[2][0], y: c[2][1], z: sz }, { x: c[3][0], y: c[3][1], z: sz }
          ]
        };
      }
      case T_3DFACE: {
        let corners: [Point3, Point3, Point3, Point3];
        if (!isR10plus) {
          /* each corner independently announces whether it carries a z */
          corners = [
            (opts & 1) ? e.pt3() : p2(e, z), (opts & 2) ? e.pt3() : p2(e, z),
            (opts & 4) ? e.pt3() : p2(e, z), (opts & 8) ? e.pt3() : p2(e, z)
          ];
          return { ...base, type: 'face3d', corners };
        }
        corners = hasElev
          ? [p2(e, 0), p2(e, 0), p2(e, 0), p2(e, 0)]
          : [e.pt3(), e.pt3(), e.pt3(), e.pt3()];
        const face: Entity = { ...base, type: 'face3d', corners };
        if (opts & 1) {
          const inv = e.rs();
          if (inv) face.invisibleEdges = inv;
        }
        return face;
      }
      case T_TEXT:
      case T_ATTRIB:
      case T_ATTDEF: {
        const [x, y] = e.pt2();
        const height = e.rd();
        if (!isR2plus) e.rd();            /* the oldest form put oblique here */
        const text = e.tv(codepage);
        if (common.type === T_ATTDEF) e.tv(codepage);          /* prompt */
        if (common.type !== T_TEXT) { e.tv(codepage); e.rc(); } /* tag, flags */
        /* attributes use the same option bits shifted one place up */
        const shift = common.type === T_TEXT ? 0 : 1;
        const has = (bit: number): number => opts & (bit << shift);
        const rotation = has(1) ? e.rd() : 0;
        const widthFactor = has(2) ? e.rd() : 1;
        const oblique = has(4) ? e.rd() : 0;
        const styleIndex = has(8) ? e.rc() : -1;
        if (has(16)) e.rc();              /* generation */
        const halign = has(32) ? e.rc() : 0;
        let ax = x, ay = y;
        if (has(64)) [ax, ay] = e.pt2();
        if (has(128)) e.pt3();            /* extrusion */
        const valign = has(256) ? e.rc() : 0;
        const H = ['left', 'center', 'right', 'aligned', 'middle', 'fit'] as const;
        const V = ['baseline', 'bottom', 'middle', 'top'] as const;
        const ent: Entity = {
          ...base, type: 'text',
          position: { x, y, z },
          alignmentPoint: (halign || valign) ? { x: ax, y: ay, z } : undefined,
          text, height, rotation,
          widthFactor: Math.abs(widthFactor - 1) > 1e-9 ? widthFactor : undefined,
          oblique: oblique || undefined,
          style: styleIndex >= 0
            ? drawing.textStyles[styleIndex]?.name : undefined,
          halign: H[halign] ?? 'left',
          valign: V[valign] ?? 'baseline'
        };
        if (common.type === T_ATTRIB && ctx.pendingInsert) {
          applyCommon(ent, common);
          (ctx.pendingInsert.attributes ??= []).push(ent);
          return null;                    /* carried by its INSERT */
        }
        return ent;
      }
      case T_SHAPE: {
        const [x, y] = e.pt2();
        const size = e.rd();
        let rotation = 0, styleId: number;
        if (!isR2plus) { rotation = e.rd(); styleId = e.rs(); }
        else {
          styleId = e.rc();
          if (opts & 1) rotation = e.rd();
          if (opts & 2) e.rc();           /* shape file entry */
          if (opts & 4) e.rd();           /* width factor */
          if (opts & 8) e.rd();           /* oblique */
        }
        return {
          ...base, type: 'shape', position: { x, y, z }, size, rotation, styleId
        };
      }
      case T_BLOCK: {
        let name = '';
        if (!isR2plus) { name = e.tv(codepage); e.pt2(); }
        else {
          e.pt2();                        /* base point (also in the table) */
          if (opts & 2) e.tv(codepage);   /* xref path */
          if (opts & 4) name = e.tv(codepage);
        }
        /* the table record that points here is authoritative: it is the one
           that distinguishes same-named anonymous blocks */
        const rel = at - ctx.runStart;
        name = blockRecs.find((b) => b.name && b.offset === rel)?.name ?? name;
        ctx.blockName = name || null;
        if (name && intoBlocks && !(name in drawing.blocks)) {
          const rec = blockRecs.find((b) => b.name === name);
          drawing.blocks[name] = {
            name, basePoint: rec?.base ?? { x: 0, y: 0, z: 0 }, entities: []
          };
        }
        return null;
      }
      case T_ENDBLK:
        ctx.blockName = null;
        ctx.pendingPolyline = null;
        ctx.pendingInsert = null;
        return null;
      case T_SEQEND:
        if (isR2plus) e.rl();             /* address of the owner record */
        ctx.pendingPolyline = null;
        ctx.pendingInsert = null;
        return null;
      case T_INSERT: {
        if (!isR2plus) {
          /* the oldest form names its block inline and always has a scale */
          const blockName = e.tv(codepage);
          const [ix, iy] = e.pt2();
          const [sx, sy] = e.pt2();
          return {
            ...base, type: 'insert', blockName,
            position: { x: ix, y: iy, z },
            scale: { x: sx, y: sy, z: sx },
            rotation: e.rd()
          };
        }
        const blockIndex = e.rs();
        const [x, y] = e.pt2();
        const scale = { x: 1, y: 1, z: 1 };
        if (opts & 1) scale.x = e.rd();
        if (opts & 2) scale.y = e.rd();
        const rotation = (opts & 4) ? e.rd() : 0;
        if (opts & 8) scale.z = e.rd();
        const columnCount = (opts & 16) ? e.rsu() : undefined;
        const rowCount = (opts & 32) ? e.rsu() : undefined;
        const columnSpacing = (opts & 64) ? e.rd() : undefined;
        const rowSpacing = (opts & 128) ? e.rd() : undefined;
        if (opts & 256) e.pt3();          /* extrusion */
        const rec = blockRecs[blockIndex];
        const ins: Entity = {
          ...base, type: 'insert',
          blockName: rec?.name ?? '',
          position: { x, y, z },
          scale, rotation,
          columnCount, rowCount, columnSpacing, rowSpacing
        };
        ctx.pendingInsert = (common.flag & F_ATTRIBS)
          ? ins as Entity & { type: 'insert' } : null;
        return ins;
      }
      case T_POLYLINE: {
        const pflag = (opts & 1) ? e.rc() : 0;
        if (opts & 2) e.rd();             /* default start width */
        if (opts & 4) e.rd();             /* default end width */
        if (opts & 8) e.pt3();            /* extrusion */
        let mSize: number | undefined, nSize: number | undefined;
        if (pflag & P_MESH) {
          if (opts & 16) mSize = e.rsu();
          if (opts & 32) nSize = e.rsu();
          if (opts & 64) e.rs();          /* m surface density */
          if (opts & 128) e.rs();         /* n surface density */
          if (opts & 256) e.rs();         /* curve type */
        } else if (pflag & P_PFACE) {
          if (opts & 16) mSize = e.rsu(); /* vertex count */
          if (opts & 32) nSize = e.rsu(); /* face count */
        } else {
          if (opts & 16) e.rs();
          if (opts & 32) e.rs();
          if (opts & 256) e.rs();         /* curve type */
        }
        if (pflag & (P_MESH | P_PFACE)) {
          const mesh: MeshEntity = {
            ...base, type: 'mesh',
            meshKind: (pflag & P_PFACE) ? 'faces' : 'grid',
            vertices: []
          };
          if (pflag & P_MESH) {
            mesh.mSize = mSize;
            mesh.nSize = nSize;
            if (pflag & 1) mesh.closedM = true;
            if (pflag & 32) mesh.closedN = true;
          }
          ctx.pendingPolyline = {
            kind: (pflag & P_PFACE) ? 'pface' : 'mesh', mesh, verts: []
          };
          return mesh;
        }
        const pl: Entity = {
          ...base, type: 'polyline', vertices: [],
          closed: (pflag & P_CLOSED) !== 0,
          elevation: (pflag & P_3D) ? undefined : (z || undefined)
        };
        ctx.pendingPolyline = {
          kind: 'polyline',
          poly: pl as Entity & { type: 'polyline' },
          verts: (pl as Entity & { type: 'polyline' }).vertices
        };
        return pl;
      }
      case T_VERTEX: {
        /* mesh face records carry indices instead of a location */
        const pt = (opts & 0x4000) ? null : e.pt2();
        const sw = (opts & 1) ? e.rd() : 0;
        const ew = (opts & 2) ? e.rd() : 0;
        const bulge = (opts & 4) ? e.rd() : 0;
        const vflag = (opts & 8) ? e.rc() : 0;
        if (opts & 16) e.rd();            /* tangent direction */
        const face: number[] = [];
        if (opts & 0x20) face.push(e.rs());
        if (opts & 0x40) face.push(e.rs());
        if (opts & 0x80) face.push(e.rs());
        if (opts & 0x100) face.push(e.rs());
        const pend = ctx.pendingPolyline;
        if (!pend) return null;
        if (pend.mesh) {
          if ((vflag & V_PFACE) && !(vflag & V_MESH)) {
            const idx = face.filter((n) => n !== 0);
            if (idx.length) (pend.mesh.faces ??= []).push(idx);
          } else if (pt) {
            pend.mesh.vertices.push({ x: pt[0], y: pt[1], z });
          }
          return null;
        }
        if (pt) {
          const v: PolylineVertex = { x: pt[0], y: pt[1] };
          if (sw) v.startWidth = sw;
          if (ew) v.endWidth = ew;
          if (bulge) v.bulge = bulge;
          void V_3D;
          pend.verts.push(v);
        }
        return null;                      /* folded into its polyline */
      }
      case T_DIMENSION: {
        const blockRec = blockRecs[e.rs()];   /* holds the drawn geometry */
        const definitionPoint = isR10plus ? e.pt3() : p2(e, z);
        const [tx, ty] = e.pt2();
        const dim: Entity = {
          ...base, type: 'dimension',
          dimensionType: 0,
          definitionPoint,
          textMidpoint: { x: tx, y: ty, z },
          elevation: z || undefined,
          blockName: blockRec?.name
        };
        if (opts & 1) dim.insertionPoint = p2(e, z);
        const dflag = (opts & 2) ? e.rc() : 0;
        if (opts & 4) dim.text = e.tv(codepage);
        const kindNo = dflag & 15;
        const KINDS = ['linear', 'aligned', 'angular2ln', 'diameter',
          'radius', 'angular3pt', 'ordinate'] as const;
        dim.kind = KINDS[kindNo];
        dim.dimensionType = kindNo;
        if (dflag & 128) dim.dimensionType |= 128;    /* text moved */
        /* the point set that follows depends on the kind */
        const wide = (): Point3 => isR10plus ? e.pt3() : p2(e, z);
        switch (kindNo) {
          case 0:                                     /* linear */
            if (opts & 8) dim.point13 = wide();
            if (opts & 16) dim.point14 = wide();
            if (opts & 0x100) dim.rotation = e.rd();
            if (opts & 0x200) dim.obliqueAngle = e.rd();
            if (opts & 0x400) dim.textRotation = e.rd();
            if (opts & 0x4000) e.pt3();
            break;
          case 1:                                     /* aligned */
            if (opts & 8) dim.point13 = wide();
            if (opts & 16) dim.point14 = wide();
            if (opts & 0x100) dim.obliqueAngle = e.rd();
            if (opts & 0x400) dim.textRotation = e.rd();
            break;
          case 2:                                     /* angular, two lines */
            if (opts & 8) dim.point13 = wide();
            if (opts & 16) dim.point14 = wide();
            if (opts & 32) dim.point15 = wide();
            if (opts & 64) dim.point16 = p2(e, z);
            if (opts & 0x400) dim.textRotation = e.rd();
            break;
          case 3:                                     /* diameter */
          case 4:                                     /* radius */
            if (opts & 32) {
              dim.point15 = (isR10plus && !(kindNo === 3 && hasElev))
                ? e.pt3() : p2(e, z);
            }
            if (opts & 128) dim.leaderLength = e.rd();
            if (opts & 0x400) dim.textRotation = e.rd();
            if (opts & 0x4000) e.pt3();
            break;
          case 5:                                     /* angular, three points */
            if (opts & 8) dim.point13 = wide();
            if (opts & 16) dim.point14 = wide();
            if (opts & 32) dim.point15 = wide();
            if (opts & 64) dim.point16 = p2(e, z);
            if (opts & 0x400) dim.textRotation = e.rd();
            break;
          case 6:                                     /* ordinate */
            if (opts & 8) dim.point13 = wide();
            if (opts & 16) dim.point14 = wide();
            if (dflag & 64) dim.dimensionType |= 64;  /* x-type ordinate */
            if (opts & 0x400) dim.textRotation = e.rd();
            break;
          default:
            break;
        }
        if (opts & 0x8000) {
          const s = drawing.dimStyles?.[e.rs()];
          if (s) dim.style = s.name;
        }
        return dim;
      }
      case T_VIEWPORT: {
        const center = e.pt3();
        const width = e.rd();
        const height = e.rd();
        const id = e.rs();
        return {
          ...base, type: 'viewport', center, width, height, statusFlag: id
        };
      }
      /* The array construct and the shape-file load record have no modern
         equivalent; they are retained with their source type so nothing is
         silently lost. Their payload is still consumed so the record list
         stays in step. */
      case T_ENDREP:
        e.rsu(); e.rsu(); e.rd(); e.rd();  /* columns, rows, spacings */
        return { ...base, type: 'unknown', sourceType: 'ENDREP' };
      case T_LOAD:
        e.tv(codepage);                   /* shape file to load */
        return { ...base, type: 'unknown', sourceType: 'LOAD' };
      default:
        return {
          ...base, type: 'unknown',
          sourceType: TYPE_NAMES[common.type] ?? ('TYPE_' + common.type)
        };
    }
  };

  /* model space, then block definitions, then the extras run */
  try {
    /* before R2.0 the block definitions live inline in the one entity run */
    readEntityRun(entitiesStart, entitiesEnd, drawing.entities, !isR2plus);
  } catch (err) {
    warnings.push('entity section: ' + (err instanceof Error ? err.message : String(err)));
  }
  try {
    if (blocksStart && blocksSize) {
      readEntityRun(blocksStart, blocksStart + blocksSize, drawing.entities, true);
    }
  } catch { warnings.push('block section could not be read fully.'); }
  try {
    if (extrasStart && extrasSize) {
      readEntityRun(extrasStart, extrasStart + extrasSize, drawing.entities, false);
    }
  } catch { warnings.push('extras section could not be read fully.'); }

  /* drop polylines that never got vertices */
  drawing.entities = drawing.entities.filter(
    (ent) => ent.type !== 'polyline' || ent.vertices.length >= 2);
  for (const def of Object.values(drawing.blocks)) {
    def.entities = def.entities.filter(
      (ent) => ent.type !== 'polyline' || ent.vertices.length >= 2);
  }

  const unknowns = new Map<string, number>();
  for (const ent of drawing.entities) {
    if (ent.type === 'unknown') {
      unknowns.set(ent.sourceType, (unknowns.get(ent.sourceType) ?? 0) + 1);
    }
  }
  for (const [name, count] of unknowns) {
    warnings.push(
      `${count} ${name} entit${count === 1 ? 'y' : 'ies'} kept without geometry (not modeled yet).`);
  }
  return drawing;
};
