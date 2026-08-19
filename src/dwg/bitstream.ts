/* nasjidwg — DWG bit-level stream reader.
 *
 * The DWG object data format is a bit stream, MSB first, with a family of
 * variable-length primitive encodings (the "bitcodes" of the OpenDesign
 * specification): a double may occupy 2 bits (common values 0.0 / 1.0) or
 * 66 bits, a short 2, 10 or 18 bits, and so on. Everything DWG is built on
 * these primitives.
 */

export interface HandleRef {
  /** Reference code (high nibble): 2..5 absolute, 6/8 offset ±1,
   *  0xA/0xC offset ±value from the owner handle. */
  code: number;
  /** Raw stored value (meaning depends on code). */
  value: number;
}

/** Resolve a handle reference against its owner's absolute handle. */
export const resolveHandle = (ref: HandleRef, owner: number): number => {
  switch (ref.code) {
    case 0x6: return owner + 1;
    case 0x8: return owner - 1;
    case 0xA: return owner + ref.value;
    case 0xC: return owner - ref.value;
    default: return ref.value;            /* 2,3,4,5: absolute */
  }
};

/* One DataView per underlying buffer, shared by every reader over it: a
 * file yields three readers per object (data, handles, strings) and they
 * all view the same ArrayBuffer, so building a view each time dominated
 * the decode. */
const VIEWS = new WeakMap<ArrayBufferLike, DataView>();
/* Decoding walks thousands of objects that are all slices of one buffer,
 * so remembering the last answer turns the map lookup into a comparison. */
let lastBuffer: ArrayBufferLike | null = null;
let lastView: DataView | null = null;
const viewOf = (data: Uint8Array): DataView => {
  const buf = data.buffer;
  if (buf === lastBuffer && lastView) return lastView;
  let v = VIEWS.get(buf);
  if (!v) VIEWS.set(buf, v = new DataView(buf));
  lastBuffer = buf;
  lastView = v;
  return v;
};

export class BitReader {
  readonly data: Uint8Array;
  /** Absolute position in BITS from the start of `data`. */
  pos = 0;
  /** Hard stop in bits; reads beyond it throw. */
  endBit: number;

  /** Scratch for unaligned doubles; built on first use, since most
   *  readers only ever meet aligned ones. */
  private scratch?: DataView;
  /** Byte/double alias pair for the unaligned rd fast path. */
  private sBytes?: Uint8Array;
  private sF64?: Float64Array;
  /** A view over the whole buffer, so an aligned double is one read.
   *  `base` is this reader's byte offset within it. */
  private view: DataView;
  private base: number;

  constructor(data: Uint8Array, startBit = 0, endBit?: number) {
    this.data = data;
    this.pos = startBit;
    this.endBit = endBit ?? data.length * 8;
    this.view = viewOf(data);
    this.base = data.byteOffset;
  }

  atEnd(): boolean { return this.pos >= this.endBit; }

  private need(bits: number): void {
    if (this.pos + bits > this.endBit) {
      throw new RangeError(
        `bit stream overrun: need ${bits} bits at ${this.pos}, end ${this.endBit}`);
    }
  }

  /** B — one bit. */
  b(): number {
    this.need(1);
    const byte = this.data[this.pos >> 3];
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  /** BB — two bits. It fronts every BS/BL/BD in the stream, so it reads
   *  directly with a single bounds check instead of two b() round trips. */
  bb(): number {
    const pos = this.pos;
    if (pos + 2 > this.endBit) this.need(2);
    const i = pos >> 3, off = pos & 7;
    this.pos = pos + 2;
    if (off < 7) return (this.data[i] >> (6 - off)) & 3;
    /* straddles the byte boundary */
    return ((this.data[i] & 1) << 1) | ((this.data[i + 1] ?? 0) >> 7);
  }

  /** 3B — three bits (spec 3B, used by R2007+ section headers). */
  bbb(): number { return (this.bb() << 1) | this.b(); }

  /** RC — raw 8-bit char (may straddle a byte boundary). */
  rc(): number {
    this.need(8);
    const i = this.pos >> 3, off = this.pos & 7;
    let v: number;
    if (off === 0) v = this.data[i];
    else v = ((this.data[i] << off) | ((this.data[i + 1] ?? 0) >> (8 - off))) & 0xFF;
    this.pos += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    if ((this.pos & 7) === 0) {           /* fast path: byte aligned */
      this.need(n * 8);
      const start = this.pos >> 3;
      out.set(this.data.subarray(start, start + n));
      this.pos += n * 8;
    } else {
      for (let k = 0; k < n; k++) out[k] = this.rc();
    }
    return out;
  }

  /** RS — raw little-endian 16-bit; an aligned read skips the bit path. */
  rs(): number {
    if ((this.pos & 7) === 0) {
      this.need(16);
      const at = this.pos >> 3;
      this.pos += 16;
      return this.data[at] | (this.data[at + 1] << 8);
    }
    return this.rc() | (this.rc() << 8);
  }

  /** RL — raw little-endian 32-bit (unsigned). */
  rl(): number {
    if ((this.pos & 7) === 0) {
      this.need(32);
      const at = this.pos >> 3;
      this.pos += 32;
      return (this.data[at] | (this.data[at + 1] << 8)
        | (this.data[at + 2] << 16) | (this.data[at + 3] << 24)) >>> 0;
    }
    return (this.rs() | (this.rs() << 16)) >>> 0;
  }

  /** RLL — raw little-endian 64-bit, as a JS number (safe for file sizes). */
  rll(): number { return this.rl() + this.rl() * 0x100000000; }

  /** RD — raw little-endian IEEE double. Doubles dominate the stream, so
   *  the aligned case reads straight out of the file view and the
   *  unaligned case fills a reused scratch: neither allocates. */
  rd(): number {
    const pos = this.pos;
    if (pos + 64 > this.endBit) this.need(64);
    if ((pos & 7) === 0) {
      this.pos = pos + 64;
      return this.view.getFloat64(this.base + (pos >> 3), true);
    }
    /* Unaligned: bit-packed entity doubles nearly always land here. The
       bit stream is MSB-first, so on a BIG-endian reading three 32-bit
       words shifted by the bit offset reproduce the 8 payload bytes — two
       stores and one load on a reused scratch instead of an 8-byte merge
       loop. The last word may poke past the data end; the view spans the
       whole underlying buffer, so only a read at the buffer's true tail
       needs the byte fallback. */
    const scratch = this.scratch ??= new DataView(new ArrayBuffer(8));
    const i = this.base + (pos >> 3), off = pos & 7, inv = 32 - off;
    if (i + 12 <= this.view.byteLength) {
      const v = this.view;
      const w0 = v.getUint32(i, false), w1 = v.getUint32(i + 4, false);
      const w2 = v.getUint32(i + 8, false);
      scratch.setUint32(0, ((w0 << off) | (w1 >>> inv)) >>> 0, false);
      scratch.setUint32(4, ((w1 << off) | (w2 >>> inv)) >>> 0, false);
      this.pos = pos + 64;
      return scratch.getFloat64(0, true);
    }
    const d = this.data, j = pos >> 3, jinv = 8 - off;
    let sb = this.sBytes;
    if (!sb) {
      const ab = new ArrayBuffer(8);
      sb = this.sBytes = new Uint8Array(ab);
      this.sF64 = new Float64Array(ab);
    }
    for (let k = 0; k < 8; k++) {
      sb[k] = ((d[j + k] << off) | (d[j + k + 1] >> jinv)) & 0xFF;
    }
    this.pos = pos + 64;
    return this.sF64![0];
  }

  /** BS — bitshort. */
  bs(): number {
    switch (this.bb()) {
      case 0: { const v = this.rs(); return v >= 0x8000 ? v - 0x10000 : v; }
      case 1: return this.rc();
      case 2: return 0;
      default: return 256;
    }
  }

  /** BL — bitlong. */
  bl(): number {
    switch (this.bb()) {
      case 0: { const v = this.rl(); return v > 0x7FFFFFFF ? v - 0x100000000 : v; }
      case 1: return this.rc();
      case 2: return 0;
      default: return 0;                  /* 3 is unused per spec */
    }
  }

  /** BLL — bitlonglong: 3-bit byte count, then that many bytes (LE). */
  bll(): number {
    const len = this.bbb();
    let v = 0;
    for (let i = 0; i < len; i++) v += this.rc() * 2 ** (8 * i);
    return v;
  }

  /** BD — bitdouble. */
  bd(): number {
    switch (this.bb()) {
      case 0: return this.rd();
      case 1: return 1.0;
      case 2: return 0.0;
      default: return NaN;                /* 3 is invalid per spec */
    }
  }

  bd2(): [number, number] { return [this.bd(), this.bd()]; }
  bd3(): [number, number, number] { return [this.bd(), this.bd(), this.bd()]; }
  rd2(): [number, number] { return [this.rd(), this.rd()]; }

  /** One byte off the bit stream without the rc() bounds ceremony —
   *  caller has already need()ed the whole run. */
  private byteAt(pos: number): number {
    const d = this.data, i = pos >> 3, off = pos & 7;
    if (off === 0) return d[i];
    return ((d[i] << off) | ((d[i + 1] ?? 0) >> (8 - off))) & 0xFF;
  }

  /** DD — double with default: patches bytes of the default's LE image. */
  dd(dflt: number): number {
    const code = this.bb();
    if (code === 0) return dflt;
    if (code === 3) return this.rd();
    const scratch = this.scratch ??= new DataView(new ArrayBuffer(8));
    scratch.setFloat64(0, dflt, true);
    if (code === 1) {
      this.need(32);
      const p = this.pos;
      for (let i = 0; i < 4; i++) scratch.setUint8(i, this.byteAt(p + i * 8));
      this.pos = p + 32;
    } else {                              /* code 2: bytes 4,5 then 0..3 */
      this.need(48);
      const p = this.pos;
      scratch.setUint8(4, this.byteAt(p));
      scratch.setUint8(5, this.byteAt(p + 8));
      for (let i = 0; i < 4; i++) scratch.setUint8(i, this.byteAt(p + 16 + i * 8));
      this.pos = p + 48;
    }
    return scratch.getFloat64(0, true);
  }

  dd2(dx: number, dy: number): [number, number] {
    return [this.dd(dx), this.dd(dy)];
  }
  dd3(dx: number, dy: number, dz: number): [number, number, number] {
    return [this.dd(dx), this.dd(dy), this.dd(dz)];
  }

  /** BT — bit thickness (R2000+): flag bit, then BD when nonzero. */
  bt(): number { return this.b() ? 0.0 : this.bd(); }

  /** BE — bit extrusion (R2000+): flag bit -> (0,0,1), else 3BD. */
  be(): [number, number, number] {
    return this.b() ? [0, 0, 1] : this.bd3();
  }

  /** MC — signed modular char (7 bits per byte, LSB first; sign in the
   *  0x40 bit of the final byte). */
  mc(): number {
    let v = 0, shift = 0;
    for (;;) {
      let byte = this.rc();
      if (byte & 0x80) {
        v |= (byte & 0x7F) << shift;
        shift += 7;
      } else {
        const negative = (byte & 0x40) !== 0;
        byte &= 0x3F;
        v |= byte << shift;
        return negative ? -v : v;
      }
    }
  }

  /** UMC — unsigned modular char. */
  umc(): number {
    let v = 0, shift = 0;
    for (;;) {
      const byte = this.rc();
      v += (byte & 0x7F) * 2 ** shift;    /* * not << — offsets exceed 2^31 */
      if (!(byte & 0x80)) return v;
      shift += 7;
    }
  }

  /** MS — modular short (15 bits per LE short, LSW first). */
  ms(): number {
    let v = 0, shift = 0;
    for (;;) {
      const word = this.rs();
      v += (word & 0x7FFF) * 2 ** shift;
      if (!(word & 0x8000)) return v;
      shift += 15;
    }
  }

  /** H — handle reference: code nibble + counter nibble + counter bytes
   *  (big-endian). */
  h(): HandleRef {
    const first = this.rc();
    const code = (first >> 4) & 0x0F;
    const counter = first & 0x0F;
    let value = 0;
    for (let i = 0; i < counter; i++) value = value * 256 + this.rc();
    return { code, value };
  }

  /** H resolved against its owner, allocation-free. A large drawing reads
   *  handle references tens of millions of times; the {code,value} object
   *  h() returns was the single biggest source of GC pressure in a whole
   *  readDwg, so the hot path never builds one. */
  hAbs(owner: number): number {
    const first = this.rc();
    const code = (first >> 4) & 0x0F;
    const counter = first & 0x0F;
    let value = 0;
    for (let i = 0; i < counter; i++) value = value * 256 + this.rc();
    switch (code) {
      case 0x6: return owner + 1;
      case 0x8: return owner - 1;
      case 0xA: return owner + value;
      case 0xC: return owner - value;
      default: return value;              /* 2,3,4,5: absolute */
    }
  }

  /** H's raw stored value, allocation-free (for absolute references). */
  hValue(): number {
    const first = this.rc();
    const counter = first & 0x0F;
    let value = 0;
    for (let i = 0; i < counter; i++) value = value * 256 + this.rc();
    return value;
  }

  /** T — length-prefixed (BS) codepage text. Returns raw bytes; the caller
   *  owns codepage decoding. */
  tBytes(): Uint8Array {
    const len = this.bs();
    return this.bytes(Math.max(0, len));
  }

  /** TU — length-prefixed (BS) UTF-16LE text (R2007+). */
  tu(): string {
    const len = this.bs();
    let out = '';
    for (let i = 0; i < len; i++) out += String.fromCharCode(this.rs());
    /* strip a stored terminating NUL if present */
    return out.replace(/\0+$/, '');
  }

  /** SN — 16-byte sentinel. */
  sentinel(): Uint8Array { return this.bytes(16); }

  /** CRC — align to byte, then RS. */
  crc(): number {
    this.align();
    return this.rs();
  }

  /** Advance to the next byte boundary. */
  align(): void { this.pos = (this.pos + 7) & ~7; }
}

/* ------------------------------------------------------------------ *
 * Codepage decoding for T strings. DWG default is the drawing codepage;
 * ANSI 1252 dominates, and \U+XXXX escapes carry everything else.
 * A cp1256 (Arabic Windows) table covers the second most common case.
 * ------------------------------------------------------------------ */

import { CP1252_HIGH } from '../text/escapes.js';
import { CODEPAGE_HIGH } from '../text/codepages.js';
import { DBCS_PACKED, DBCS_SINGLE } from '../text/dbcs.js';

const CP1256_HIGH: readonly number[] = [
  /* 0x80..0xFF of Windows-1256 -> Unicode */
  0x20AC, 0x067E, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0679, 0x2039, 0x0152, 0x0686, 0x0698, 0x0688,
  0x06AF, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x06A9, 0x2122, 0x0691, 0x203A, 0x0153, 0x200C, 0x200D, 0x06BA,
  0x00A0, 0x060C, 0x00A2, 0x00A3, 0x00A4, 0x00A5, 0x00A6, 0x00A7,
  0x00A8, 0x00A9, 0x06BE, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x00AF,
  0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x00B4, 0x00B5, 0x00B6, 0x00B7,
  0x00B8, 0x00B9, 0x061B, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x061F,
  0x06C1, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627,
  0x0628, 0x0629, 0x062A, 0x062B, 0x062C, 0x062D, 0x062E, 0x062F,
  0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x00D7,
  0x0637, 0x0638, 0x0639, 0x063A, 0x0640, 0x0641, 0x0642, 0x0643,
  0x00E0, 0x0644, 0x00E2, 0x0645, 0x0646, 0x0647, 0x0648, 0x00E7,
  0x00E8, 0x00E9, 0x00EA, 0x00EB, 0x0649, 0x064A, 0x00EE, 0x00EF,
  0x064B, 0x064C, 0x064D, 0x064E, 0x00F4, 0x064F, 0x0650, 0x00F7,
  0x0651, 0x00F9, 0x0652, 0x00FB, 0x00FC, 0x200E, 0x200F, 0x06D2
];

/** Normalize the many spellings of codepage names (DWG numeric names,
 *  DXF $DWGCODEPAGE strings like 'ansi_1256', 'dos864', 'iso8859-6'). */
/* Every string in the file asks for its codepage; the answer only depends
 * on the name, so it is worked out once per name. */
const CANON_CACHE = new Map<string, string>();
const canonicalCodepage = (codepage?: string): string => {
  const key = codepage ?? '';
  const hit = CANON_CACHE.get(key);
  if (hit !== undefined) return hit;
  const out = canonicalCodepageUncached(codepage);
  if (CANON_CACHE.size < 1000) CANON_CACHE.set(key, out);
  return out;
};

const canonicalCodepageUncached = (codepage?: string): string => {
  const cp = String(codepage ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cp) return 'ANSI_1252';
  let m = cp.match(/^(?:ANSI|WINDOWS)(\d{3,4})$/);
  if (m) return 'ANSI_' + m[1];
  m = cp.match(/^(?:DOS|CP|IBM)(\d{3})$/);
  if (m) return 'CP' + m[1];
  m = cp.match(/^ISO8859(\d)$/);
  if (m) return 'ISO8859_' + m[1];
  if (cp.includes('1256')) return 'ANSI_1256';
  if (cp.includes('1252')) return 'ANSI_1252';
  return cp;
};

/* CJK double-byte pages are unpacked lazily: the tables are large and most
 * drawings never touch them. */
const dbcsCache = new Map<string, Map<number, number>>();

const unpackDbcs = (packed: string): Map<number, number> => {
  const map = new Map<number, number>();
  let k = 0, v = 0;
  if (!packed) return map;
  for (const part of packed.split(';')) {
    const comma = part.indexOf(',');
    k += parseInt(part.slice(0, comma), 36);
    v += parseInt(part.slice(comma + 1), 36);
    map.set(k, v);
  }
  return map;
};

const dbcsTable = (name: string, single: boolean): Map<number, number> | null => {
  const key = name + (single ? ':1' : ':2');
  const hit = dbcsCache.get(key);
  if (hit) return hit;
  const packed = single ? DBCS_SINGLE[name] : DBCS_PACKED[name];
  if (packed === undefined) return null;
  const map = unpackDbcs(packed);
  dbcsCache.set(key, map);
  return map;
};

/** DWG codepage name -> the CJK table that decodes it. */
const DBCS_ALIAS: Record<string, string> = {
  CP932: 'CP932', ANSI_932: 'CP932',
  BIG5: 'BIG5', ANSI_950: 'BIG5',
  GB2312: 'GB2312', ANSI_936: 'GB2312',
  CP949: 'CP949', ANSI_949: 'CP949', ANSI_1361: 'CP949',
  JOHAB: 'JOHAB'
};

/** Decode T-string bytes for a drawing codepage. All common single-byte pages
 *  are supported; unmapped bytes become U+FFFD. */
export const decodeCodepage = (bytes: Uint8Array, codepage?: string): string => {
  const cp = canonicalCodepage(codepage);

  /* CJK: a lead byte pairs with the next byte into one code point */
  const dbcsName = DBCS_ALIAS[cp];
  if (dbcsName) {
    const dbl = dbcsTable(dbcsName, false);
    const sgl = dbcsTable(dbcsName, true);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0) break;
      if (b < 0x80) { out += String.fromCharCode(b); continue; }
      if (i + 1 < bytes.length) {
        const pair = (b << 8) | bytes[i + 1];
        /* GB2312's table is in the 7-bit (GB) form while the bytes on disk
           are EUC (high bits set), so a miss retries without them */
        const u = dbl?.get(pair) ?? dbl?.get(pair & 0x7f7f);
        if (u !== undefined) { out += String.fromCharCode(u); i++; continue; }
      }
      const s = sgl?.get(b);
      out += String.fromCharCode(s ?? 0xFFFD);
    }
    return out;
  }

  const table: readonly number[] | undefined =
    cp === 'ANSI_1256' ? CP1256_HIGH
    : cp === 'ANSI_1252' ? undefined            /* fast built-in path */
    : cp === 'ISO8859_1' || cp === 'US_ASCII' || cp === 'UTF8' ? LATIN1_HIGH
    : CODEPAGE_HIGH[cp];
  let out = '';
  for (const byte of bytes) {
    if (byte === 0) break;                /* stored terminator */
    if (byte < 0x80) { out += String.fromCharCode(byte); continue; }
    if (table) out += String.fromCharCode(table[byte - 0x80]);
    else if (byte < 0xA0) out += String.fromCharCode(CP1252_HIGH[byte - 0x80]);
    else out += String.fromCharCode(byte);         /* 1252 == latin-1 here */
  }
  return out;
};

const LATIN1_HIGH: readonly number[] = Array.from({ length: 128 }, (_, i) => 0x80 + i);
