/* nasjidwg — file metadata: the embedded preview image and the document
 * summary properties.
 *
 * The preview block sits at the address named in the file header (R13-
 * R2000 and R2004+ alike) and holds a small table of images: type 1 is a
 * header block, 2 a BMP, 3 a WMF, 6 a PNG. SummaryInfo is its own logical
 * section from R2004 on; before that the same values live in the DWGPROPS
 * XRECORD (which the reader retains).
 */

import { BitReader } from './bitstream.js';

export interface Thumbnail {
  format: 'bmp' | 'wmf' | 'png';
  /** Raw image bytes, ready to write to disk or wrap in a data URL. */
  data: Uint8Array;
}

export interface SummaryInfo {
  title?: string;
  subject?: string;
  author?: string;
  keywords?: string;
  comments?: string;
  lastSavedBy?: string;
  revisionNumber?: string;
  hyperlinkBase?: string;
  /** Custom property tag/value pairs. */
  custom?: { tag: string; value: string }[];
}

const PREVIEW_SENTINEL = [
  0x1F, 0x25, 0x6D, 0x07, 0xD4, 0x36, 0x28, 0x28,
  0x9D, 0x57, 0xCA, 0x3F, 0x9D, 0x44, 0x10, 0x2B
];

/** Extract the embedded preview image, if the file carries one. */
export const readThumbnail = (
  data: Uint8Array, address: number
): Thumbnail | null => {
  try {
    if (address <= 0 || address + 21 > data.length) return null;
    /* the address points at the sentinel */
    for (let i = 0; i < 16; i++) {
      if (data[address + i] !== PREVIEW_SENTINEL[i]) return null;
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = address + 16;
    const overall = dv.getUint32(p, true);
    p += 4;
    if (overall < 5 || address + 20 + overall > data.length) return null;
    const numHeaders = data[p++];
    if (numHeaders === 0 || numHeaders > 16) return null;

    /* Each table row is (type, address, size). Type 1 rows describe a
       leading header block whose bytes sit before the images, so the image
       data begins after the table plus the accumulated header sizes. */
    let headerSize = 0;
    let imageSize = 0;
    let format: Thumbnail['format'] | null = null;
    for (let i = 0; i < numHeaders && p + 9 <= data.length; i++) {
      const type = data[p++];
      p += 4;                              /* address (unused for locating) */
      const size = dv.getUint32(p, true); p += 4;
      if (type === 1) headerSize += size;
      else if (type === 2 && !format) { format = 'bmp'; imageSize = size; }
      else if (type === 3 && !format) { format = 'wmf'; imageSize = size; }
      else if (type === 6 && !format) { format = 'png'; imageSize = size; }
    }
    if (!format || imageSize <= 0) return null;

    const start = p + headerSize;
    if (start < 0 || start + imageSize > data.length) return null;
    const body = data.subarray(start, start + imageSize);
    if (format !== 'bmp') return { format, data: body.slice() };

    const out = new Uint8Array(14 + body.length);
    const odv = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4D;          /* 'BM' */
    odv.setUint32(2, out.length, true);
    /* pixel data starts after the DIB header and its color table */
    const dibSize = body.length >= 4 ? new DataView(
      body.buffer, body.byteOffset, body.byteLength).getUint32(0, true) : 40;
    const bitCount = body.length >= 16 ? new DataView(
      body.buffer, body.byteOffset, body.byteLength).getUint16(14, true) : 24;
    const paletteEntries = bitCount <= 8 ? (1 << bitCount) : 0;
    odv.setUint32(10, 14 + dibSize + paletteEntries * 4, true);
    out.set(body, 14);
    return { format: 'bmp', data: out };
  } catch {
    return null;
  }
};

/** Extract the ACIS/ASM binary blobs stored in the AcDs data section
 *  (R2013+ moves 3DSOLID/REGION/BODY payloads out of the object records).
 *  Returned in file order, base64-encoded. */
export const readAcDsSabBlobs = (section: Uint8Array): string[] => {
  const out: string[] = [];
  let text = '';
  for (let i = 0; i < section.length; i++) {
    text += String.fromCharCode(section[i]);
  }
  const END_ASM = '\x0e\x03End\x0e\x02of\x0e\x03ASM\r\x04data';
  const END_ACIS = '\x0e\x03End\x0e\x02of\x0e\x04ACIS\r\x04data';
  /* single-identifier spelling, seen in pre-ASM kernels (and in blobs we
     carried through the AcDs slot ourselves) */
  const END_IDENT = '\x0d\x10End-of-ACIS-data';
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const startRe = /(?:ACIS|ASM) BinaryFile/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(text)) !== null) {
    const start = m.index;
    let end = -1, endLen = 0;
    for (const mark of [END_ASM, END_ACIS, END_IDENT]) {
      const at = text.indexOf(mark, start);
      if (at !== -1 && (end === -1 || at < end)) { end = at; endLen = mark.length; }
    }
    if (end === -1) break;
    const size = end + endLen - start;
    let b64 = '';
    for (let i = 0; i < size; i += 3) {
      const a = section[start + i];
      const b = section[start + i + 1];
      const c = section[start + i + 2];
      b64 += CH[a >> 2] + CH[((a & 3) << 4) | ((b ?? 0) >> 4)]
        + (i + 1 < size ? CH[(((b ?? 0) & 15) << 2) | ((c ?? 0) >> 6)] : '=')
        + (i + 2 < size ? CH[(c ?? 0) & 63] : '=');
    }
    out.push(b64);
    startRe.lastIndex = start + size;
  }
  return out;
};

/** Parse the AcDb:SummaryInfo section (R2004+). Strings are codepage bytes
 *  in R2004 and UTF-16 from R2007 on; both count the NUL in their length. */
export const readSummaryInfo = (
  section: Uint8Array, utf16: boolean
): SummaryInfo | null => {
  try {
    const r = new BitReader(section);
    const t16 = (): string => {
      const len = r.rs();
      if (len < 0 || len > 0x10000) throw new RangeError('summary string');
      let s = '';
      for (let i = 0; i < len; i++) {
        s += String.fromCharCode(utf16 ? r.rs() : r.rc());
      }
      return s.replace(/\0+$/, '');
    };
    const info: SummaryInfo = {};
    const set = (k: keyof SummaryInfo, v: string): void => {
      if (v) (info as Record<string, unknown>)[k] = v;
    };
    set('title', t16());
    set('subject', t16());
    set('author', t16());
    set('keywords', t16());
    set('comments', t16());
    set('lastSavedBy', t16());
    set('revisionNumber', t16());
    set('hyperlinkBase', t16());
    r.rl(); r.rl();                        /* TDINDWG */
    r.rl(); r.rl();                        /* TDCREATE */
    r.rl(); r.rl();                        /* TDUPDATE */
    const numProps = r.rs();
    if (numProps > 0 && numProps < 1000) {
      const custom: { tag: string; value: string }[] = [];
      for (let i = 0; i < numProps; i++) {
        const tag = t16();
        const value = t16();
        if (tag) custom.push({ tag, value });
      }
      if (custom.length) info.custom = custom;
    }
    return Object.keys(info).length ? info : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ *
 * AcDs writer (R2013+): the solid-modeling payload container.
 *
 * AC1027/AC1032 keep 3DSOLID/REGION/BODY ACIS data in the
 * AcDb:AcDsPrototype_1b section instead of the entity record. The
 * section is a small filesystem, and everything below emits it field
 * by field from its grammar — nothing here is a copy of bytes some
 * other program wrote.
 *
 * A 0x80-byte file header ('jard') is followed by segments, each one
 * starting on a 0x80 boundary with a 48-byte header
 *
 *   u16 0xD5AC | char[6] name | u64 id | u64 size | u32 save counter
 *   | u32 0 | u32 tally | u32 record tally | u64 0
 *
 * and then its payload. Nine segment names exist; the six a first save
 * needs are written here:
 *
 *   segidx  the segment table: [u64 offset, u32 size] per segment id,
 *           indexed by id. The file header carries this one's offset
 *           (the bootstrap) and the ids of the other index segments.
 *   datidx  where each schema's data record sits: [u64 count] then
 *           [u32 segment id, u32 record offset, u32 schema index].
 *   schdat  schema declarations (below).
 *   schidx  the catalogue: where every schema and every shared
 *           property-attribute cell lives, plus the schema names.
 *   _data_  a directory of 20-byte record headers
 *           [u32 20, u32 1, u64 handle, u32 data offset]; at the next
 *           16-byte boundary the data cells follow, each a u32 length
 *           and its bytes. The SAB payload rides in one of those.
 *   search  handle -> record lookup, one table per schema.
 *
 * The three left out are re-save bookkeeping: 'prvsav' (a copy of the
 * previous save's file header), 'freesp' (the free-block list, which a
 * fresh contiguous layout has nothing to put in) and the second
 * '_data_' page a re-save leaves behind. AutoCAD's own first-save
 * headers name no freesp segment either.
 *
 * A schema is a named record layout: a count of index cells, the cells
 * themselves, then its properties, each [u32 flags, u32 name index,
 * u32 type, u16 value count, u64 values...] where the values and index
 * cells are positions in the catalogue's cell table. The ASM schema is
 * two properties — the record id (type 10) and the binary payload
 * (type 15). The four attribute schemas the cells are tagged with have
 * to be declared alongside it (they are what gives a cell its meaning),
 * and the catalogue keeps AutoCAD's own schema order, so the payload
 * schema is the last of six.
 *
 * All of it is proven against AutoCAD 2027: a 2018 solid whose SAB
 * rides this section opens with AUDIT at 0 errors, and the same section
 * with the segment tallies cleared opens but leaves the solid unbound
 * ("could not be repaired"), which is how those fields were found.
 *
 * Limit (deliberate, ledgered): one solid per drawing gets AcDs data,
 * because the caller hands us one blob. The container itself would
 * take any number of records.
 * ------------------------------------------------------------------ */

/* Structural constants of the container. */
const DS_PAGE = 0x80;                     /* segment alignment */
const DS_SEG_HDR = 48;                    /* bytes before a payload */
const DS_SEG_MAGIC = 0xd5ac;
const DS_REC_HDR = 20;                    /* one _data_ directory entry */
/** The attribute cells every schema-data segment carries, [u32 size,
 *  u32 value] each, tagged 1..4 in the catalogue: a schema names two of
 *  them for itself and two for its id property. */
const DS_CELLS = [1, 1, 1, 0] as const;
/** Property types: the record id, the binary payload, a plain flag
 *  attribute, and the handle attribute. */
const DS_TYPE_ID = 10;
const DS_TYPE_BLOB = 15;
const DS_TYPE_FLAG = 1;
const DS_TYPE_HANDLE = 7;
/** The catalogue AutoCAD's AcDs machinery expects, in its own order:
 *  the thumbnail slot, the four attribute schemas the cells are tagged
 *  with, and last the schema that carries a solid's ASM payload. Only
 *  the last one is given data here — no preview image is written into
 *  this section (the drawing's preview is its own section). */
const DS_SCHEMAS = ['AcDb_Thumbnail_Schema',
  'AcDbDs::TreatedAsObjectDataSchema', 'AcDbDs::LegacySchema',
  'AcDbDs::IndexedPropertySchema', 'AcDbDs::HandleAttributeSchema',
  'AcDb3DSolid_ASM_Data'] as const;
const DS_ASM_SCHEMA = DS_SCHEMAS.length - 1;
/** Segment ids. The segment table is indexed by id, so they stay small
 *  and dense; 0 means "no such segment" in the file header. */
const DS_SEGIDX = 1, DS_DATIDX = 2, DS_SCHDAT = 3, DS_SCHASM = 4;
const DS_SCHIDX = 5, DS_DATA = 6, DS_SEARCH = 7;
const DS_NEXT_ID = 8;
/** Every segment header carries a tally of what the segment holds, and
 *  AutoCAD reads it: leave it clear and the schema catalogue comes up
 *  empty (the section still parses, but no solid finds its record);
 *  overstate it and the drawing is refused outright. The tallies below
 *  are the ones AutoCAD itself writes for exactly this content — the
 *  catalogue here is fixed, so they are constants — and a data segment
 *  counts four before its records. */
const DS_TALLY_SCHDAT = 14;               /* the five standard schemas */
const DS_TALLY_SCHASM = 9;                /* the payload schema alone */
const DS_TALLY_SCHIDX = 15;               /* the catalogue itself */
const DS_TALLY_DATA = 4;                  /* plus one per record */

/** Little-endian byte sink for the AcDs structures. */
interface DsSink {
  readonly b: number[];
  u8: (v: number) => void;
  u16: (v: number) => void;
  u32: (v: number) => void;
  u64: (v: number) => void;
  /** NUL-terminated ASCII, as every name in the section is stored */
  str: (s: string) => void;
  bytes: (a: Uint8Array) => void;
  align: (to: number) => void;
}

const dsSink = (): DsSink => {
  const b: number[] = [];
  const u8 = (v: number): void => { b.push(v & 0xff); };
  const u16 = (v: number): void => { b.push(v & 0xff, (v >>> 8) & 0xff); };
  const u32 = (v: number): void => {
    u16(v & 0xffff); u16(Math.floor(v / 0x10000) & 0xffff);
  };
  const u64 = (v: number): void => {
    u32(v >>> 0); u32(Math.floor(v / 0x100000000));
  };
  return {
    b, u8, u16, u32, u64,
    str: (s: string): void => {
      for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xff);
      b.push(0);
    },
    bytes: (a: Uint8Array): void => {
      for (let i = 0; i < a.length; i++) b.push(a[i]);
    },
    align: (to: number): void => { while (b.length % to) b.push(0); }
  };
};

interface DsSeg {
  name: string; id: number; body: number[]; at: number; size: number;
  /** the tally AutoCAD keeps of what the segment holds (see DS_TALLY) */
  tally: number;
}

/** One property of a schema: flags, the pooled name, its type, and the
 *  attribute cells that qualify it. */
const dsProp = (
  w: DsSink, flags: number, name: number, type: number, cells: number[]
): void => {
  w.u32(flags); w.u32(name); w.u32(type);
  w.u16(cells.length);
  for (const c of cells) w.u64(c);
};

/** A data schema: two index cells of its own, a record-id property
 *  keyed by the remaining two, and the payload property. `cell` is the
 *  catalogue position of this segment's first attribute cell. */
const dsDataSchema = (w: DsSink, cell: number, blobName: number): void => {
  w.u16(2); w.u64(cell); w.u64(cell + 1);
  w.u16(2);
  dsProp(w, 0, 0, DS_TYPE_ID, [cell + 2, cell + 3]);
  dsProp(w, 0, blobName, DS_TYPE_BLOB, []);
};

/** Build the AcDb:AcDsPrototype_1b section carrying one solid's SAB. */
export const buildAcDs = (
  solidHandle: number, sab: Uint8Array
): Uint8Array | null => {
  if (sab.length === 0) return null;

  /* --- schdat #1: the thumbnail slot and the attribute schemas ---- */
  const schdat = dsSink();
  const schemaAt: number[] = [];
  const schemaIn: number[] = [];
  for (const v of DS_CELLS) { schdat.u32(8); schdat.u32(v); }
  schemaAt.push(schdat.b.length); schemaIn.push(DS_SCHDAT);
  dsDataSchema(schdat, 0, 1);             /* schema 0: Thumbnail_Data */
  for (let i = 0; i < 3; i++) {           /* schemas 1..3: plain flags */
    schemaAt.push(schdat.b.length); schemaIn.push(DS_SCHDAT);
    schdat.u16(0); schdat.u16(1);
    dsProp(schdat, 0, 2 + i, DS_TYPE_FLAG, []);
  }
  schemaAt.push(schdat.b.length); schemaIn.push(DS_SCHDAT);
  schdat.u16(0); schdat.u16(1);           /* schema 4: the handle one, */
  schdat.u32(8); schdat.u32(5); schdat.u32(DS_TYPE_HANDLE);
  schdat.u16(1);                          /* which carries a value */
  schdat.u16(0); schdat.u16(1); schdat.u8(0);
  schdat.align(4);
  const names1 = ['AcDbDs::ID', 'Thumbnail_Data',
    'AcDbDs::TreatedAsObjectData', 'AcDbDs::Legacy', 'AcDs:Indexable',
    'AcDbDs::HandleAttribute'];
  schdat.u32(names1.length);
  for (const n of names1) schdat.str(n);

  /* --- schdat #2: the solid payload schema, with its own cells ---- */
  const schasm = dsSink();
  for (const v of DS_CELLS) { schasm.u32(8); schasm.u32(v); }
  schemaAt.push(schasm.b.length); schemaIn.push(DS_SCHASM);
  dsDataSchema(schasm, DS_CELLS.length, 1);
  const names2 = ['AcDbDs::ID', 'ASM_Data'];
  schasm.u32(names2.length);
  for (const n of names2) schasm.str(n);

  /* --- schidx: the catalogue ------------------------------------- */
  const schidx = dsSink();
  schidx.u64(DS_SCHEMAS.length);
  for (let i = 0; i < DS_SCHEMAS.length; i++) {
    schidx.u32(i); schidx.u32(schemaIn[i]); schidx.u32(schemaAt[i]);
  }
  schidx.u64(0);                          /* catalogue stamp: unused */
  schidx.u64(DS_CELLS.length * 2);
  for (const seg of [DS_SCHDAT, DS_SCHASM]) {
    for (let i = 0; i < DS_CELLS.length; i++) {
      schidx.u32(seg); schidx.u32(i * 8); schidx.u32(i + 1);
    }
  }
  schidx.u32(DS_SCHEMAS.length);
  for (const n of DS_SCHEMAS) schidx.str(n);

  /* --- _data_: the record directory, then the payload cells ------ */
  const data = dsSink();
  data.u32(DS_REC_HDR);                   /* directory entry size */
  data.u32(1);                            /* one data cell in it */
  data.u64(solidHandle);                  /* the solid this belongs to */
  data.u32(0);                            /* cell offset: the first */
  data.align(16);
  data.u32(sab.length);
  data.bytes(sab);

  /* --- datidx: which record carries the schema's data ------------ */
  const datidx = dsSink();
  datidx.u64(1);
  datidx.u32(DS_DATA); datidx.u32(0); datidx.u32(DS_ASM_SCHEMA);

  /* --- search: handle -> record, one table per schema ------------ */
  const search = dsSink();
  search.u32(1);                          /* one table */
  search.u32(DS_ASM_SCHEMA);
  search.u64(1); search.u64(0);           /* the records it holds: #0 */
  search.u64(1); search.u32(1);           /* one handle key… */
  search.u64(solidHandle);
  search.u64(1); search.u64(0);           /* …naming record #0 */

  /* --- lay the segments out on 0x80 boundaries ------------------- */
  const grow = (payload: number): number =>
    Math.ceil((DS_SEG_HDR + payload) / DS_PAGE) * DS_PAGE;
  const segs: DsSeg[] = [];
  let at = DS_PAGE;                       /* the file header comes first */
  const place = (
    name: string, id: number, body: number[], tally: number
  ): void => {
    const size = grow(body.length);
    segs.push({ name, id, body, at, size, tally });
    at += size;
  };
  /* segidx first: it indexes every id, itself included */
  place('segidx', DS_SEGIDX, new Array<number>(DS_NEXT_ID * 12).fill(0), 0);
  place('datidx', DS_DATIDX, datidx.b, 0);
  place('schdat', DS_SCHDAT, schdat.b, DS_TALLY_SCHDAT);
  place('schdat', DS_SCHASM, schasm.b, DS_TALLY_SCHASM);
  place('schidx', DS_SCHIDX, schidx.b, DS_TALLY_SCHIDX);
  place('_data_', DS_DATA, data.b, DS_TALLY_DATA + 1);
  place('search', DS_SEARCH, search.b, 0);
  const total = at;

  const segidx = dsSink();
  for (let id = 0; id < DS_NEXT_ID; id++) {
    const s = segs.find((g) => g.id === id);
    segidx.u64(s ? s.at : 0);
    segidx.u32(s ? s.size : 0);
  }
  segs[0].body = segidx.b;

  /* --- emit ------------------------------------------------------ */
  const out = new Uint8Array(total);
  const head = dsSink();
  for (const c of 'jard') head.u8(c.charCodeAt(0));
  head.u16(DS_PAGE);                      /* allocation granularity */
  head.u16(1);                            /* format version */
  head.u32(8); head.u32(2); head.u32(0);  /* fixed container fields */
  head.u32(1);                            /* save counter: first save */
  head.u64(DS_PAGE);                      /* where segidx starts */
  head.u32(DS_NEXT_ID);                   /* next free segment id */
  head.u32(DS_SCHIDX); head.u32(DS_DATIDX); head.u32(DS_SEARCH);
  head.u32(0);                            /* prvsav: none, this is save 1 */
  head.u64(total);
  head.u32(0);                            /* freesp: nothing is free */
  head.u32(0);
  out.set(Uint8Array.from(head.b), 0);

  for (const s of segs) {
    const h = dsSink();
    h.u16(DS_SEG_MAGIC);
    for (const c of s.name) h.u8(c.charCodeAt(0));
    h.u64(s.id);
    h.u64(s.size);
    h.u32(1);                             /* written by save 1 */
    h.u32(0);
    h.u32(s.name === '_data_' ? 0 : s.tally);
    h.u32(s.name === '_data_' ? s.tally : 0);
    h.u64(0);
    out.set(Uint8Array.from(h.b), s.at);
    out.set(Uint8Array.from(s.body), s.at + DS_SEG_HDR);
  }
  return out;
};
