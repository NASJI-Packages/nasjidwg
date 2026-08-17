/* nasjidwg — the R2007 (AC1021) page container, write side.
 *
 * R2007 wraps its logical sections in a different envelope from R2004: the
 * file header, the page map and the section map are all Reed-Solomon coded,
 * and the maps use 64-bit fields throughout. Section payloads and the
 * section map are LZ77-packed when that shrinks them and stored when it
 * does not; the format declares a stored page by making the compressed
 * size equal the uncompressed one. The page map alone always goes out
 * stored: it describes its own page, so packing it would change the very
 * size it records, and at sixteen bytes an entry it never outgrows a
 * single RS block anyway.
 *
 * The RS code is RS(255,239) for the header and the system pages and
 * RS(255,251) for data pages, interleaved column-wise: byte j of block i
 * lands at j * blockCount + i.
 */

import { compressR2007 } from './sections2007.js';

/* The container carries TWO Reed-Solomon codes, and — the one thing that
 * makes them easy to get wrong — they do not share a field. The file
 * header and the system pages are RS(255,239) over x^8+x^6+x^5+x^3+1;
 * data pages are RS(255,251) over the far more common x^8+x^4+x^3+x^2+1.
 * Both are narrow-sense, with their generator's roots at a^1..a^r for
 * a = x, so neither generator is written down here: each is derived from
 * its field and its parity width alone.
 *
 * The data-page code was recovered by evaluating genuine blocks at every
 * element of every degree-8 field and asking which exponents annihilate
 * all of them: 0x11D answers with 1,2,3,4 and nothing else does. Both
 * codes then reproduce 102 genuine AC1021 files exactly — 55189 of 55189
 * data-page blocks, and every header and system page.
 *
 * The parity is not decorative. Flipping the four parity bytes of ONE
 * data page in an otherwise untouched genuine file — bytes no checksum in
 * the container covers — makes AutoCAD 2027 refuse the drawing with
 * ErrorStatus=53, so it either verifies the codeword or runs the
 * correction and mangles good data into "corrected" garbage. */
interface RsCode {
  /** Number of parity symbols; the data size is 255 minus this. */
  readonly parity: number;
  /** GF(256) multiply under this code's field polynomial. */
  readonly mul: (a: number, b: number) => number;
  /** Generator coefficients, constant term first, leading 1 last. */
  readonly gen: Uint8Array;
}

/** Build a narrow-sense RS code over GF(256) with field polynomial `poly`
 *  and `parity` symbols: g(x) = product over i in 1..parity of (x - x^i). */
const rsCode = (poly: number, parity: number): RsCode => {
  /* Reduction table: entry h is (h · x^8) folded back into eight bits. */
  const residue = new Uint8Array(256);
  const low = poly & 0xff;                    /* x^8 mod p */
  let v = low;
  for (let bit = 1; bit < 256; bit <<= 1) {
    for (let i = 0; i < bit; i++) residue[bit + i] = residue[i] ^ v;
    v = ((v << 1) ^ ((v & 0x80) ? low : 0)) & 0xff;
  }
  const mul = (a: number, b: number): number => {
    let prod = 0, A = a, B = b;
    while (B !== 0) {
      if (B & 1) prod ^= A;
      B >>= 1;
      A <<= 1;
    }
    return (prod ^ residue[prod >> 8]) & 0xff;
  };
  let gen = [1];
  let root = 1;
  for (let i = 0; i < parity; i++) {
    root = mul(root, 2);                      /* the i-th root, a^(i+1) */
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j + 1] ^= gen[j];
      next[j] ^= mul(gen[j], root);
    }
    gen = next;
  }
  return { parity, mul, gen: Uint8Array.from(gen) };
};

/** The two codes, keyed by the block data size that selects them. */
const RS_CODES: ReadonlyMap<number, RsCode> = new Map([
  [239, rsCode(0x169, 16)],                   /* header and system pages */
  [251, rsCode(0x11d, 4)],                    /* data pages              */
]);

/** The parity symbols for one block, by long division. */
const rsParity = (
  code: RsCode, src: Uint8Array, from: number, count: number
): Uint8Array => {
  const np = code.parity;
  const gen = code.gen;
  const p = new Uint8Array(np);
  for (let i = count - 1; i >= 0; i--) {
    const leader = p[np - 1];
    for (let j = np - 1; j > 0; j--) p[j] = p[j - 1] ^ code.mul(leader, gen[j]);
    p[0] = src[from + i] ^ code.mul(leader, gen[0]);
  }
  for (let k = 0; k < np; k++) {
    const leader = p[np - 1];
    for (let j = np - 1; j > 0; j--) p[j] = p[j - 1] ^ code.mul(leader, gen[j]);
    p[0] = code.mul(leader, gen[0]);
  }
  return p;
};

/** Reed-Solomon code `payload` into interleaved 255-byte blocks. */
export const rsEncode = (
  payload: Uint8Array, dataSize: number, blocks: number
): Uint8Array => {
  const code = RS_CODES.get(dataSize);
  if (!code) throw new Error(`R2007: no Reed-Solomon code for ${dataSize} data bytes`);
  const out = new Uint8Array(blocks * 255);
  for (let i = 0; i < blocks; i++) {
    const at = i * dataSize;
    const n = Math.max(0, Math.min(dataSize, payload.length - at));
    const block = new Uint8Array(dataSize);
    if (n > 0) block.set(payload.subarray(at, at + n));
    for (let j = 0; j < dataSize; j++) out[j * blocks + i] = block[j];
    const parity = rsParity(code, block, 0, dataSize);
    for (let j = 0; j < code.parity; j++) out[(dataSize + j) * blocks + i] = parity[j];
  }
  return out;
};

const round8 = (n: number): number => (n + 7) & ~7;
const round32 = (n: number): number => (n + 31) & ~31;

/** First page starts here: 0x80 prologue + 0x3D8 coded header + 0x28 slack. */
const PAGE_BASE = 0x480;

export interface Section2007 { name: string; data: Uint8Array }

/** A system page: RS(255,239), padded to eight bytes. */
const systemPage = (payload: Uint8Array): Uint8Array => {
  const blocks = Math.max(1, Math.ceil(round8(payload.length) / 239));
  const coded = rsEncode(payload, 239, blocks);
  const page = new Uint8Array(round8(blocks * 255));
  page.set(coded);
  return page;
};

/** A data page: RS(255,251), padded to thirty-two bytes. The reader tells
 *  a coded page from a stored one by exactly this size. */
const dataPage = (payload: Uint8Array): Uint8Array => {
  const blocks = Math.max(1, Math.ceil(round8(payload.length) / 251));
  const coded = rsEncode(payload, 251, blocks);
  const page = new Uint8Array(round32(blocks * 255));
  page.set(coded);
  return page;
};

/* ---------------------------------------------------------------- *
 * The two R2007 page checksums.
 *
 * Recovered from 102 genuine AC1021 files (every drawing shipped with
 * AutoCAD 2027 plus the libredwg samples): 1814 of 1815 section-page
 * records and all 408 map-level fields reproduce exactly. Both walk the
 * message in the same peculiar order — the four 16-bit words of each
 * aligned eight-byte chunk most-significant first, then the same for a
 * trailing four, two and one — and both take their seed from the message
 * LENGTH through the MSVC CRT rand() LCG (214013·n + 2531011), which is
 * why no textbook parameter set ever fit. The pair cover DIFFERENT
 * buffers: the 32-bit field checksums the decompressed page, the 64-bit
 * field the compressed bytes that actually sit on disk.
 * ---------------------------------------------------------------- */

/** 16-bit words of each aligned 8/4/2/1-byte chunk, most significant
 *  first — the order both checksums consume their message in. */
const wordOrder = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(b.length);
  const n = b.length;
  let d = 0, i = 0;
  for (; i + 8 <= n; i += 8) {
    for (let w = 3; w >= 0; w--) { out[d++] = b[i + 2 * w]; out[d++] = b[i + 2 * w + 1]; }
  }
  if (i + 4 <= n) {
    for (let w = 1; w >= 0; w--) { out[d++] = b[i + 2 * w]; out[d++] = b[i + 2 * w + 1]; }
    i += 4;
  }
  if (i + 2 <= n) { out[d++] = b[i]; out[d++] = b[i + 1]; i += 2; }
  if (i < n) out[d++] = b[i];
  return out;
};

const M64 = (1n << 64n) - 1n;
/** CRC-64/Jones, reflected: rev64(0xAD93D23594C935A9). */
const CRC64_TABLE = ((): BigUint64Array => {
  const t = new BigUint64Array(256);
  for (let i = 0; i < 256; i++) {
    let c = BigInt(i);
    for (let k = 0; k < 8; k++) c = (c & 1n) ? (c >> 1n) ^ 0x95ac9329ac4bc9b5n : c >> 1n;
    t[i] = c;
  }
  return t;
})();

/** The 64-bit page CRC. Init is the bitwise NOT of the two LCG steps
 *  taken from the byte count, packed low word then high; the 64-bit
 *  arithmetic and the OR both matter once a page passes ~20 000 bytes,
 *  where the low step's overflow folds into the high half. XOR-out is 0
 *  and the result is stored little-endian. */
export const crc64R2007 = (data: Uint8Array): bigint => {
  const s1 = (214013n * BigInt(data.length) + 2531011n) & M64;
  const s2 = (214013n * s1 + 2531011n) & M64;
  let c = ~(s1 | ((s2 << 32n) & M64)) & M64;
  const m = wordOrder(data);
  for (let i = 0; i < m.length; i++) {
    c = (c >> 8n) ^ CRC64_TABLE[Number((c ^ BigInt(m[i])) & 0xffn)];
  }
  return c;
};

/* ---------------------------------------------------------------- *
 * The file header's own three integrity fields use the OTHER member of
 * the pair: the "normal" (most-significant-bit-first) CRC-64/ECMA-182,
 * inverted at the end, over the same 6,7,4,5,2,3,0,1 chunk walk. Their
 * seeds come from the message length through two different foldings of
 * the same LCG — `seed1` for the checking sequence, `seed2` for the
 * header record and the compressed data.
 * ---------------------------------------------------------------- */

/** Seed fold 1: the two LCG steps OR-ed low-word/high-word, complemented.
 *  (Identical to the page CRC's init above, in the header's own idiom.) */
const seed1 = (len: number): bigint => {
  const s = (BigInt(len) * 214013n + 2531011n) & M64;
  return ~(s | ((s * ((214013n << 32n) & M64) + ((2531011n << 32n) & M64)) & M64)) & M64;
};

/** Seed fold 2: the same first step, then one 64-bit LCG step whose
 *  multiplier carries the length back in, complemented. */
const seed2 = (len: number): bigint => {
  const s = (BigInt(len) * 214013n + 2531011n) & M64;
  return ~((s * (((1n << 32n) + 214013n) & M64) + BigInt(len) + 2531011n) & M64) & M64;
};

/** CRC-64/ECMA-182, most-significant-byte first. */
const CRC64_FWD = ((): BigUint64Array => {
  const t = new BigUint64Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (BigInt(i) << 56n) & M64;
    for (let k = 0; k < 8; k++) {
      c = (c & (1n << 63n)) ? (((c << 1n) & M64) ^ 0x42f0e1eba9ea3693n) : ((c << 1n) & M64);
    }
    t[i] = c;
  }
  return t;
})();

/** The header's 64-bit CRC: forward ECMA-182 over the word order, seeded
 *  from the length and complemented on the way out. */
export const crc64Normal = (data: Uint8Array, seed: bigint): bigint => {
  let c = seed & M64;
  const m = wordOrder(data);
  for (let i = 0; i < m.length; i++) {
    c = CRC64_FWD[Number(((c >> 56n) ^ BigInt(m[i])) & 0xffn)] ^ ((c << 8n) & M64);
  }
  return ~c & M64;
};

/** Rotate left by the low five bits of `by` — the header's one piece of
 *  non-linearity, and the reason the checking sequence resisted every
 *  affine CRC fit. */
const encodeRot = (v: bigint, by: bigint): bigint => {
  const s = by & 0x1fn;
  return s === 0n ? v : (((v << s) | (v >> (64n - s))) & M64);
};

/** The checking sequence: a random 64-bit key and that key rotated by its
 *  own low five bits, little-endian, CRC-64'd. It certifies nothing but
 *  itself — any key with its matching CRC is accepted. */
export const sequenceCrc = (key: bigint): bigint => {
  const m = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    m[i] = Number((key >> BigInt(8 * i)) & 0xffn);
    m[8 + i] = Number((encodeRot(key, key) >> BigInt(8 * i)) & 0xffn);
  }
  return crc64Normal(m, seed1(16));
};

/** The mirrored CRC with an explicit seed and no final inversion — the
 *  page CRC's kernel, exposed for the file header's check data. */
const crc64Mirror = (data: Uint8Array, seed: bigint): bigint => {
  let c = seed & M64;
  const m = wordOrder(data);
  for (let i = 0; i < m.length; i++) {
    c = (c >> 8n) ^ CRC64_TABLE[Number((c ^ BigInt(m[i])) & 0xffn)];
  }
  return c;
};

/** The 0x28 bytes of "check data" that close the file header page, at
 *  PAGE_BASE - 0x28: two CRCs over a chain of rotations of two random
 *  words, then the words and the encoded CRC seed. Like the checking
 *  sequence it certifies only itself, so the two words are ours to pick. */
const checkData = (r1: bigint, r2: bigint, seedEnc: bigint): Uint8Array => {
  const pack = (v: readonly bigint[]): Uint8Array => {
    const b = new Uint8Array(64);
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 8; k++) b[i * 8 + k] = Number((v[i] >> BigInt(8 * k)) & 0xffn);
    }
    return b;
  };
  const a: bigint[] = [];
  a[0] = encodeRot(r1, r2); a[1] = encodeRot(a[0], a[0]);
  a[2] = encodeRot(r2, a[1]); a[3] = encodeRot(a[2], a[2]);
  a[4] = encodeRot(r1, a[3]); a[5] = encodeRot(a[4], a[4]);
  a[6] = encodeRot(a[5], a[5]); a[7] = encodeRot(a[6], a[6]);
  const normal = crc64Normal(pack(a), ~r2 & M64);
  const b: bigint[] = [];
  b[0] = encodeRot(r1, r2); b[1] = encodeRot(normal, b[0]);
  b[2] = encodeRot(r2, b[1]); b[3] = encodeRot(normal, b[2]);
  b[4] = encodeRot(r1, b[3]); b[5] = encodeRot(normal, b[4]);
  b[6] = encodeRot(r2, b[5]); b[7] = encodeRot(b[6], b[6]);
  const mirrored = crc64Mirror(pack(b), ~r1 & M64);
  const out = new Uint8Array(40);
  [normal, mirrored, r1, r2, seedEnc].forEach((v, i) => {
    for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((v >> BigInt(8 * k)) & 0xffn);
  });
  return out;
};

/** The 32-bit sibling: the same chunked Adler R2004 pages use, over the
 *  same word order, seeded from the length by one LCG step (the halves
 *  are used unreduced, exactly as AutoCAD does). */
export const cksum32R2007 = (data: Uint8Array): number => {
  const seed = (Math.imul(214013, data.length) + 2531011) >>> 0;
  const m = wordOrder(data);
  let s1 = seed & 0xffff, s2 = (seed >>> 16) & 0xffff, at = 0;
  while (at < m.length) {
    const stop = Math.min(at + 0x15b0, m.length);
    for (; at < stop; at++) { s1 += m[at]; s2 += s1; }
    s1 %= 0xfff1; s2 %= 0xfff1;
  }
  return ((s2 % 0xfff1) * 0x10000 + (s1 % 0xfff1)) >>> 0;
};

/** Pack a payload, or keep it as-is when packing does not pay: equal
 *  compressed and uncompressed sizes are the format's "stored" marker, so
 *  the choice is visible to the reader through the sizes alone. */
const packed = (data: Uint8Array): Uint8Array => {
  const comp = compressR2007(data);
  return comp.length < data.length ? comp : data;
};

/* Everything below mirrors an AutoCAD-2027-minted AC1021 file (ref2007,
 * campaign 5), field-walked with the library's own R2007 reader:
 *
 *  - prologue: maintenance 0x32 at 0x0B, 0x03 at 0x0C, app version
 *    0x21/0xFF at 0x11/0x12 and again at 0x16/0x17;
 *  - the page map comes FIRST (two copies at 0x480 and +alloc), data
 *    pages carry ids from 3, the section map and its copy follow them,
 *    and the page-map pair takes the two ids after a gap of two;
 *  - system pages are written in multiple copies packed to fill their
 *    allocation (pages map x7, section map x5 in the ref) — the
 *    "correction factor" of the header record is that copy count;
 *  - the 0x110 header record goes out compressed behind its 32-byte
 *    prologue, and a byte-for-byte copy of the whole coded header block
 *    closes the file (header2_offset, relative to 0x480);
 *  - section descriptors carry a per-name hash — an opaque constant per
 *    section name, copied from the ref — and an "encoded" marker of 4;
 *    the list ends with a nameless terminator descriptor.
 */

/** Per-name descriptor constants AutoCAD writes for the classic sections
 *  (hash is name-derived and stable across files; maxSize is the page
 *  cap the section is declared with). */
const SECTION_META: Record<string, { hash: number; maxSize: number }> = {
  'AcDb:Header': { hash: 0x32b803d9, maxSize: 0x800 },
  'AcDb:AuxHeader': { hash: 0x54f0050a, maxSize: 0x800 },
  'AcDb:Classes': { hash: 0x3f54045f, maxSize: 0xf800 },
  'AcDb:Handles': { hash: 0x3f6e0450, maxSize: 0xf800 },
  'AcDb:Template': { hash: 0x4a1404ce, maxSize: 0x400 },
  'AcDb:ObjFreeSpace': { hash: 0x77e2061f, maxSize: 0xf800 },
  'AcDb:AcDbObjects': { hash: 0x674c05a9, maxSize: 0xf800 },
  'AcDb:RevHistory': { hash: 0x60a205b3, maxSize: 0x1000 },
  'AcDb:SummaryInfo': { hash: 0x717a060f, maxSize: 0x80 },
  'AcDb:AppInfo': { hash: 0x3fa0043e, maxSize: 0x300 }
};

/** The stream order of the classic sections in a real file, first page
 *  first: RevHistory leads, Header closes. */
const STREAM_ORDER = ['AcDb:RevHistory', 'AcDb:AcDbObjects',
  'AcDb:ObjFreeSpace', 'AcDb:Template', 'AcDb:Handles', 'AcDb:Classes',
  'AcDb:AuxHeader', 'AcDb:Header'];

/* ---------------------------------------------------------------- *
 * The envelope's seven "random" 64-bit fields.
 *
 * They are not seven independent draws: they are FOURTEEN CONSECUTIVE
 * words of one MT19937 seeding array, read out in pairs, high word first.
 * With x[0] = S and x[n] = 1812433253 · (x[n-1] ^ (x[n-1] >> 30)) + n,
 * the fields sit in this order and no other, verified on 102 of 102
 * genuine AC1021 files:
 *
 *    x[k],   x[k+1]   sections map crc seed   (record 0xE0)  masked
 *    x[k+2], x[k+3]   pages map crc seed      (record 0x20)  masked
 *    x[k+4], x[k+5]   check data r1                          plain
 *    x[k+6], x[k+7]   check data r2                          plain
 *    x[k+8], x[k+9]   check data word 5                      masked
 *    x[k+10],x[k+11]  crc seed encoded        (record 0xF8)  masked
 *    x[k+12],x[k+13]  the prologue key                       plain
 *
 * with k between 139 and 359. "Masked" means AND 0xF7DF7DF7DF7DF7DF —
 * every bit congruent to 5 mod 6 cleared, five-bit digits packed into
 * six-bit slots. The three plain fields give exact words, which is how
 * the layout was measured rather than guessed: solving
 * n = x[n] - M·(x[n-1] ^ (x[n-1] >> 30)) for every ordered pair of words
 * in the envelope returns a small, plausible index only for genuinely
 * adjacent draws, and it does so for r1.hi->r1.lo->r2.hi->r2.lo and
 * key.hi->key.lo in 102 files out of 102.
 *
 * Every one of the seven is free — each was individually replaced in a
 * genuine file and AUDITed clean — so nothing here is required. It is
 * written this way because it costs nothing and makes our envelope the
 * same SHAPE as AutoCAD's instead of a block of zeros.
 *
 * `random_seed` at record 0x100 is NOT part of this window. It is
 * (x[128], x[129]) of a DIFFERENT instance: walking this stream back from
 * the key to index 128 reproduces it in 0 of 102 files. That is measured,
 * not assumed, and it is why solving the key does not solve random_seed.
 * ---------------------------------------------------------------- */

/** Every bit congruent to 5 mod 6 cleared — the shape four of the seven
 *  fields are stored in. */
const SEED_MASK = 0xf7df7df7df7df7dfn;

interface EnvelopeSeeds {
  secmapSeed: bigint; pagesMapSeed: bigint;
  r1: bigint; r2: bigint; word5: bigint;
  crcSeedEncoded: bigint; key: bigint;
}

/** The fourteen-word window starting at draw `first` of the stream seeded
 *  with `seed`. Both are ours to pick; they are derived from the layout so
 *  that one drawing always mints one file. */
const envelopeSeeds = (seed: number, first: number): EnvelopeSeeds => {
  const x = new Uint32Array(first + 14);
  x[0] = seed >>> 0;
  for (let n = 1; n < x.length; n++) {
    x[n] = (Math.imul(1812433253, (x[n - 1] ^ (x[n - 1] >>> 30)) >>> 0) + n) >>> 0;
  }
  const pair = (n: number): bigint =>
    (BigInt(x[first + n]) << 32n) | BigInt(x[first + n + 1]);
  return {
    secmapSeed: pair(0) & SEED_MASK,
    pagesMapSeed: pair(2) & SEED_MASK,
    r1: pair(4),
    r2: pair(6),
    word5: pair(8) & SEED_MASK,
    crcSeedEncoded: pair(10) & SEED_MASK,
    key: pair(12),
  };
};

/** A system page holding as many copies of `payload` as fit its
 *  allocation (at least five copies' worth, at least 0x400 bytes). */
const systemPageCopies = (
  payload: Uint8Array
): { page: Uint8Array; copies: number } => {
  const unit = Math.max(8, round8(payload.length));
  const blocks5 = Math.ceil((unit * 5) / 239);
  const alloc = Math.max(0x400, round32(blocks5 * 255));
  const blocks = Math.floor(alloc / 255);
  const copies = Math.max(1, Math.floor((blocks * 239) / unit));
  const buf = new Uint8Array(blocks * 239);
  for (let c = 0; c < copies; c++) buf.set(payload, c * unit);
  const coded = rsEncode(buf, 239, blocks);
  const page = new Uint8Array(alloc);
  page.set(coded.subarray(0, Math.min(coded.length, alloc)));
  return { page, copies };
};

/** Build a complete AC1021 file around already-encoded logical sections. */
export const assemble2007 = (sections: readonly Section2007[]): Uint8Array => {
  const put64 = (into: number[], v: number): void => {
    into.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    const hi = Math.floor(v / 0x100000000);
    into.push(hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff);
  };
  /** The CRC64 fields need all 64 bits, so they go out as a BigInt. */
  const put64b = (into: number[], v: bigint): void => {
    for (let i = 0n; i < 8n; i++) into.push(Number((v >> (i * 8n)) & 0xffn));
  };
  const put64bAt = (into: Uint8Array, at: number, v: bigint): void => {
    for (let i = 0; i < 8; i++) into[at + i] = Number((v >> BigInt(8 * i)) & 0xffn);
  };

  /* -- order the sections the way real files stream them -- */
  const ordered = STREAM_ORDER
    .map((nm) => sections.find((s) => s.name === nm))
    .filter((s): s is Section2007 => s !== undefined);
  for (const s of sections) if (!ordered.includes(s)) ordered.push(s);

  /* -- cut every section into pages of at most 0xF800 decompressed
        bytes; the last slice keeps its true length (real files do not
        pad it) -- */
  interface Page2007 {
    id: number; target: number; uncomp: number;
    payload: Uint8Array; disk: Uint8Array;
    cksum: number; crc: bigint;
  }
  const bySection: Page2007[][] = [];
  let nextId = 3;                          /* data page ids start at 3 */
  for (const sec of ordered) {
    const pages: Page2007[] = [];
    const total = Math.max(1, Math.ceil(sec.data.length / 0xf800));
    for (let k = 0; k < total; k++) {
      const slice = sec.data.subarray(k * 0xf800,
        Math.min((k + 1) * 0xf800, sec.data.length));
      const payload = packed(slice);
      pages.push({
        id: nextId++, target: k * 0xf800, uncomp: slice.length,
        payload, disk: dataPage(payload),
        /* the 32-bit field checksums the decompressed page, the 64-bit
           field the compressed bytes that reach the disk */
        cksum: cksum32R2007(slice), crc: crc64R2007(payload)
      });
    }
    bySection.push(pages);
  }
  const dataPageCount = nextId - 3;
  const secMapId = nextId++;
  const secMap2Id = nextId++;
  const pagesMapId = nextId + 2;           /* a gap of two unused ids */
  const pagesMap2Id = nextId + 3;

  /* -- section map: one 64-byte record per section, then its pages;
        a nameless terminator descriptor closes the list -- */
  const smParts: number[] = [];
  ordered.forEach((sec, i) => {
    const meta = SECTION_META[sec.name];
    const maxSize = meta?.maxSize ?? 0xf800;
    put64(smParts, sec.data.length);      /* data size */
    put64(smParts, maxSize);
    put64(smParts, 0);                    /* not encrypted */
    put64(smParts, meta?.hash ?? 0);      /* name hash */
    put64(smParts, (sec.name.length + 1) * 2);   /* UTF-16, NUL included */
    put64(smParts, 0);
    put64(smParts, 4);                    /* encoded: RS-coded pages */
    put64(smParts, bySection[i].length);
    for (let k = 0; k < sec.name.length; k++) {
      smParts.push(sec.name.charCodeAt(k) & 0xff, 0);
    }
    smParts.push(0, 0);                   /* NUL terminator */
    for (const pg of bySection[i]) {
      put64(smParts, pg.target);          /* offset in the section */
      put64(smParts, maxSize);            /* allocation slot */
      put64(smParts, pg.id);
      put64(smParts, pg.uncomp);
      put64(smParts, pg.payload.length);  /* compressed; == stored if equal */
      put64(smParts, pg.cksum);           /* Adler over the decompressed page */
      put64b(smParts, pg.crc);            /* CRC-64/Jones over the compressed */
    }
  });
  /* terminator: no name, no pages */
  put64(smParts, 0); put64(smParts, 0xf800); put64(smParts, 0);
  put64(smParts, 0); put64(smParts, 0); put64(smParts, 0);
  put64(smParts, 4); put64(smParts, 0);
  const sectionsMap = Uint8Array.from(smParts);
  const sectionsMapPayload = packed(sectionsMap);
  const secMapSys = systemPageCopies(sectionsMapPayload);

  /* -- page map: (size, id) in file order — its own pair first, then
        the data pages, then the section-map pair. Its content names its
        own allocation, so iterate until the size settles. -- */
  let pagesMapAlloc = 0x400;
  let pagesMap: Uint8Array = new Uint8Array(0);
  let pagesMapPayload: Uint8Array = new Uint8Array(0);
  let pmSys: { page: Uint8Array; copies: number } | null = null;
  for (let iter = 0; iter < 4; iter++) {
    const pm: number[] = [];
    put64(pm, pagesMapAlloc); put64(pm, pagesMapId);
    put64(pm, pagesMapAlloc); put64(pm, pagesMap2Id);
    for (const pages of bySection) {
      for (const pg of pages) { put64(pm, pg.disk.length); put64(pm, pg.id); }
    }
    put64(pm, secMapSys.page.length); put64(pm, secMapId);
    put64(pm, secMapSys.page.length); put64(pm, secMap2Id);
    pagesMap = Uint8Array.from(pm);
    pagesMapPayload = packed(pagesMap);
    pmSys = systemPageCopies(pagesMapPayload);
    if (pmSys.page.length === pagesMapAlloc) break;
    pagesMapAlloc = pmSys.page.length;
  }
  const pagesMapPage = pmSys!.page;

  /* -- absolute layout -- */
  let cursor = PAGE_BASE;
  cursor += pagesMapPage.length * 2;       /* the pair up front */
  for (const pages of bySection) for (const pg of pages) cursor += pg.disk.length;
  cursor += secMapSys.page.length * 2;
  const header2At = cursor;                /* second header block */
  const fileSize = header2At + 0x400;
  const totalPages = dataPageCount + 4;

  /* -- the seven free "random" fields, minted as one window of one
        stream the way AutoCAD mints them. Seed and draw index are ours;
        deriving them from the layout keeps a drawing reproducible byte
        for byte, which a random source would not. The draw index stays
        inside the 139..359 band genuine files use. -- */
  const seeds = envelopeSeeds(
    Number(seed2(fileSize) & 0xffffffffn) >>> 0, 139 + (fileSize % 221));

  /* -- the 0x110 metadata record, compressed and RS coded behind a
        32-byte prologue -- */
  const rec: number[] = [];
  const F = (v: number): void => put64(rec, v);
  const F64 = (v: bigint): void => put64b(rec, v);
  F(0x70);                                /* header size */
  F(fileSize);
  F64(crc64R2007(pagesMapPayload));       /* pages map crc, compressed */
  F(pmSys!.copies);                       /* pages map copy count */
  F64(seeds.pagesMapSeed);                /* pages map crc seed */
  F(pagesMapPage.length);                 /* second pages map offset */
  F(pagesMap2Id);
  F(0);                                   /* pages map offset (first copy) */
  F(pagesMapId);
  F(header2At - PAGE_BASE);               /* second header offset */
  F(pagesMapPayload.length);              /* compressed; == stored if equal */
  F(pagesMap.length);
  F(totalPages);
  F(pagesMap2Id);                         /* highest page id */
  F(0x20); F(0x40);
  F64(crc64R2007(pagesMap));              /* pages map crc, uncompressed */
  F(0xf800); F(4); F(1);
  F(ordered.length + 1);                  /* descriptors incl. terminator */
  F64(crc64R2007(sectionsMap));           /* sections map crc, uncompressed */
  F(sectionsMapPayload.length);           /* compressed; == stored if equal */
  F(secMap2Id);
  F(secMapId);
  F(sectionsMap.length);                  /* uncompressed */
  F64(crc64R2007(sectionsMapPayload));    /* sections map crc, compressed */
  F(secMapSys.copies);                    /* sections map copy count */
  F64(seeds.secmapSeed);                  /* sections map crc seed */
  F(0x60100);                             /* stream version */
  F(0);                                   /* crc seed: zero in every genuine file */
  F64(seeds.crcSeedEncoded);              /* crc seed, encoded */
  F(0);                                   /* random_seed: still unsolved */
  F(0);                                   /* header crc, filled in below */

  const recBytes = Uint8Array.from(rec);
  /* the record's own CRC covers the record with that field left zero */
  const recCrc = crc64Normal(recBytes, seed2(recBytes.length));
  for (let i = 0; i < 8; i++) {
    recBytes[0x108 + i] = Number((recCrc >> BigInt(8 * i)) & 0xffn);
  }
  const recPacked = compressR2007(recBytes);
  /* the key is ours to choose — the checking sequence certifies only the
     key itself, so derive one from the layout and CRC it */
  const key = seeds.key;
  const unit = new Uint8Array(32 + recPacked.length);
  const pv = new DataView(unit.buffer);    /* crc64, key, crc64, len, len2 */
  put64bAt(unit, 0, sequenceCrc(key));
  put64bAt(unit, 8, key);
  put64bAt(unit, 16, crc64Normal(recPacked, seed2(recPacked.length)));
  pv.setInt32(24, recPacked.length, true); /* compressed record follows */
  pv.setInt32(28, 0, true);
  unit.set(recPacked, 32);
  /* Real files repeat the whole prologue+record unit at 8-byte strides
     until the three RS blocks are full (ref2007 carries three copies).
     Copy 0 alone is consulted: wiping copies 1 and 2 to zero AUDITs
     clean, and corrupting copy 0 alone makes AutoCAD fall through to
     copy 1, so the copies are a fallback list, not a quorum. Any patch
     graded against AutoCAD must therefore be applied to EVERY copy, or
     the fall-through makes the verdict meaningless. The inter-copy
     padding and the slack past the last copy can be scribbled on freely;
     a single flipped bit in the compressed record data is refused.

     THE THREE FIELDS ARE SOLVED (campaign 8), and all three verify on
     102 of 102 genuine AC1021 files. The container needs BOTH members of
     a CRC-64 pair, not one:

       - the PAGE and MAP checksums use the "mirrored" CRC — reflected
         CRC-64/Jones, poly 0xAD93D23594C935A9, no final inversion, seeded
         by `seed1` of the message length. That is `crc64R2007` above.
       - the FILE HEADER's own fields use the "normal" CRC — forward
         (most-significant-byte first) CRC-64/ECMA-182, poly
         0x42F0E1EBA9EA3693, INVERTED on the way out. That is
         `crc64Normal`.

     Both walk the message in the same order, the four 16-bit words of
     each aligned eight-byte chunk most significant first (6,7,4,5,2,3,0,1),
     with the 4/2/1-byte tail cases `wordOrder` implements, and both take
     their seed from the message LENGTH through the MSVC LCG — but through
     two DIFFERENT foldings of it, which is why one length can produce two
     unrelated seeds:

       seed1(n): s = 214013n + 2531011; s |= (214013s + 2531011) << 32;  ~s
       seed2(n): s = 214013n + 2531011; s = s(2^32 + 214013) + n + 2531011; ~s

     With those in hand:

       seqCrc      = crc64Normal(le64(key) ++ le64(rotl(key, key & 31)),
                                 seed1(16))
       comprCrc    = crc64Normal(compressed record, seed2(comprLen))
       header_crc64 = crc64Normal(the 0x110 record with that field zeroed,
                                 seed2(0x110))

     The AutoCAD oracle settled the semantics before the algebra did, and
     the two agree exactly:

       - replacing the 16-byte (seqCrc, key) PAIR with another genuine
         file's pair AUDITs clean, in a base whose data and compressed
         length both differ; four donor pairs taken from files of
         compressed length 161, 164, 165 and 168 all pass. Replacing
         either half alone, or the (seqCrc, key, comprCrc) triple, or the
         whole 32-byte prologue, is refused. So seqCrc certifies nothing
         but the key, and comprCrc does not depend on the key at all.
       - a (seqCrc, key) pair computed by `sequenceCrc` from a key of our
         own choosing is accepted, including key = 0. Nothing from a
         genuine file needs to be carried.

     That "seqCrc is not a checksum of the file" is exactly what campaign
     7's parity measurement had already proved without being able to name
     the cause: seqCrc has EVEN POPCOUNT in 105 of 105 genuine files
     (p = 2^-105), and no other field does. The message is key ++ rotl(key),
     whose weight is 2*popcount(key) and so always even; a forward CRC-64's
     column for every message bit has odd parity, so the output parity is
     pinned to the parity of the seed image alone. The rotate by the key's
     own low five bits is also the whole of the field's non-linearity, and
     is why eleven exhaustive affine/CRC sweeps and a validated GF(2)
     affine-in-key fit all had to come back empty.

     Recorded so they are not measured again:

       - the file header page closes with 0x28 bytes of CHECK DATA at
         PAGE_BASE - 0x28 (not at 0x3D8, where the RS block's slack
         begins): normal CRC, mirrored CRC, two random words and the
         encoded CRC seed. `checkData` above reproduces both CRCs of
         ref2007 exactly. Like the checking sequence it certifies only
         itself, so the two words are ours to pick.
       - the STORED form of the header record (libredwg's `compr_len <= 0`
         memcpy branch) is refused by AutoCAD 2027 in every shape tried
         (compr_len 0, -0x110 and +0x110, with the prologue CRCs kept and
         zeroed), so there is no escape from these fields that way.
       - len2, the second 32-bit length at payload 0x1c, is zero in every
         genuine file; setting it to 1 in all three copies is refused.
       - crc_seed at record 0xF0 is ZERO in all 102 files while
         crc_seed_encoded at 0xF8, pagesmap_crc_seed and secmap_crc_seed
         are per-file random inside the mask 0xf7df7df7df7df7df (every bit
         congruent to 5 mod 6 forced to zero — five-bit digits packed into
         six-bit slots), with GF(2) rank exactly 54. None of them seeds
         its namesake: the map CRCs verify 102/102 under the plain
         seed1-of-length above, and AutoCAD 2027 AUDITs a genuine file
         clean with any ONE of the three zeroed, so all three are decoys
         and the zeros written below are correct.
       - the fifth word of the 0x28 check-data block belongs to the same
         masked family (inside 0xf7df7df7df7df7df in 103 of 103 files); it
         is NOT a copy of the record's crc_seed_encoded (0 of 103 match).
         Zero is accepted there too.
       - the two random words of the check-data block are genuinely OURS
         to pick: replacing r1/r2 in a genuine file with 0x1111.../0x2222...
         and recomputing both its CRCs with `checkData` below AUDITs clean.
         `checkData` reproduces both CRCs on 103 of 103 genuine files, so
         that machinery is general, not fitted to one reference.
       - the 0x80 prologue carries live-looking addresses AutoCAD writes
         and we leave zero: @0x0D the AcDb:Preview page, @0x20 the
         AcDb:SummaryInfo page, @0x2C AcDb:AppInfo, @0x30
         AcDb:AppInfoHistory (each an absolute file offset), then 0x202 at
         @0x34 and a small count at @0x38. They are INFORMATIONAL: zeroing
         all four in a genuine file still AUDITs clean, so they are not
         worth writing on correctness grounds.
       - "mint the same drawing twice and diff" is inconclusive BY
         CONSTRUCTION. Consecutive SAVEAS-2007 passes in one accoreconsole
         session produce different sizes (85408, 85664, 86688 from one
         source) because the drawing's editing time and history grow
         between saves, so no two files ever share a record.

     WHAT STILL BLOCKS R2007 (campaign 9). One field, and it is in this
     envelope, not in the section content: `random_seed` at record 0x100.

     The bisection that pinned it. A CHIMERA — every logical section of a
     genuine AC1021 file, read out with `readSections2007` and re-emitted
     through `assemble2007` — is refused with the same ErrorStatus=53 our
     own R2007 files get, so the container, not the content, is the
     suspect. Against that, an IDENTITY re-encode of a genuine file (its
     record decompressed, recompressed with our compressor, all three
     prologue CRCs recomputed, all three copies and both header blocks
     rewritten) AUDITs clean with 0 errors, so the pipeline is sound and
     single-field edits are a clean oracle. Under that oracle:

       - zero pagesmap_crc_seed (0x20)   -> AUDIT 0 errors
       - zero secmap_crc_seed   (0xE0)   -> AUDIT 0 errors
       - zero crc_seed_encoded  (0xF8)   -> AUDIT 0 errors
       - zero random_seed       (0x100)  -> ErrorStatus=53
       - random_seed = 1                 -> ErrorStatus=53
       - random_seed = another genuine file's value -> ErrorStatus=53
       - random_seed ^ 1 (one bit)       -> ErrorStatus=53

     The compressed record is 156 bytes in both the passing 0xF8 probe and
     the failing 0x100 probe, so no length or copy-count artefact is in
     play. The field is compared EXACTLY and is FILE-SPECIFIC, which is
     why nothing we can pick is accepted and why every R2007 file this
     writer produces is refused.

     What random_seed is NOT (all measured over 103 genuine AC1021 files,
     no hypothesis surviving):

       - not a function of the rest of the record: the file stays clean
         with 0x20, 0xE0 and 0xF8 zeroed and random_seed untouched.
       - not paired with the masked-seed family: zeroing all three record
         seeds AND the fifth check-data word, with a donor random_seed,
         is still refused.
       - not tied to the check-data random words: replacing r1/r2 with our
         own and keeping random_seed AUDITs clean.
       - not the seed of the header page's padding. That "padding" is not
         generated at all: in every genuine file the inter-copy gap bytes
         are byte-identical to the first bytes of the tail past the last
         copy, i.e. AutoCAD memcpy's one buffer of record + trailing heap
         garbage N times. No MSVC-LCG picker matches it either.
       - not a CRC: swept as mirrored-Jones and forward-ECMA-182, walked
         and raw, inverted and not, seeded by seed1/seed2 of the length,
         0, ~0, the prologue key and ~key, over every record prefix, the
         record with every subset of seed fields masked, every slice pair
         of the 0x80 prologue, every slice of the check-data block, the
         page map and section map (compressed and uncompressed), the file
         body, the whole file, and the AppInfo/SummaryInfo/Header/
         AppInfoHistory/RevHistory/Template/ObjFreeSpace sections.
       - not stored anywhere else: its eight bytes appear nowhere in the
         file, raw or in any decompressed section, little- or big-endian.
       - not an LCG self-certification (hi32 = LCG(lo32) and six variants),
         not a member of the check-data rotation chains, not an LCG image
         of the key, r1, r2 or the masked seeds, and no PRNG chain from
         random_seed reaches any of them.

     Its only measured structure is TWO GF(2) relations, satisfied by all
     103 files (rank 63 of 65 counting the affine column):

         bit1 ^ bit32 ^ bit33 ^ bit62 ^ bit63 == 0
         bit0 ^ bit32 ^ bit62 == 1

     Both are satisfied by random_seed = 1, which AutoCAD still refuses, so
     they are necessary conditions at best.

     THE GENERATOR IS SOLVED (campaign 11). random_seed is not a digest at
     all: it is two adjacent words of a MERSENNE TWISTER seeding array.
     With mt[] the MT19937 init_genrand state of a 32-bit seed S,

         mt[0] = S;  mt[i] = 0x6C078965 * (mt[i-1] ^ (mt[i-1] >> 30)) + i

     the field is exactly

         random_seed = (mt[128] << 32) | mt[129]

     — high half mt[128], low half mt[129]. It holds on 102 of 102 genuine
     files. The multiplier and the addend were RECOVERED, not assumed: an
     exhaustive bitwise (Hensel) fit of `lo = M*g(hi) + C mod 2^32` over all
     102 files at once, run for a catalogue of ~130 pre-transforms g, leaves
     a UNIQUE surviving (M, C) = (0x6C078965, 0x81) at full 32-bit depth for
     g(x) = x ^ (x >> 30) and dies at bit 0 or 2 for every other g. That is
     also the mechanical explanation of the two GF(2) relations recorded
     above: a multiply-add is affine in bits 0 and 1 and goes nonlinear from
     bit 2 up through its carries, so a linear scan of the field can only
     ever see exactly two relations, no matter how much data it is given.

     The same shape recurs elsewhere in the envelope: the prologue KEY is
     also a consecutive (mt[i-1], mt[i]) pair, at a per-file index in
     174..182. So AutoCAD mints its 64-bit "random" fields by reading two
     adjacent words out of an MT19937 seeding array — which is why several
     of them look structured without being derived from the file.

     S itself is uniformly random: 102 distinct values spread over the whole
     32-bit range (0x035B1AB5 .. 0xFC632D3F), no bit bias, not a time stamp,
     not a counter, not the file size, not either half of the key.

     THE STRUCTURE IS NECESSARY BUT NOT SUFFICIENT. Two structurally perfect
     self-generated values were graded on Sheet1.dwg through the rebuild
     oracle (only random_seed changed, both header blocks and all three
     copies patched):

       - hi = 0xDEADBEEF, so rnd = 0xDEADBEEF9E2C9F9D  -> ErrorStatus=53
       - the pair for S(genuine)+1, rnd = 0x54313092E26BD580 -> ErrorStatus=53

     So AutoCAD pins S itself, to the bit, and the MT expansion is only the
     packaging. Since a file carries no copy of S (see below), whatever
     pins it must be recomputed by AutoCAD from the file.

     What campaign 11 swept and missed, so no one repeats it:

       - STORED COPIES. 140 images of random_seed (identity, complement,
         negation, half-swap, both LCG images, all 63 rotations, each
         little- and big-endian) searched at EVERY byte offset of all 14
         decompressed sections of all 102 files, plus a per-offset algebra
         sweep (word ^ rnd, word +- rnd, and both 32-bit halves) anchored at
         each section's start AND end: no hit. The same search for S, for
         mt[1], mt[2], mt[127], mt[130], mt[623] and for the first eight
         tempered outputs of the generator: no hit. Neither the value nor
         its pre-image is written down anywhere.
       - 64-BIT DIGESTS over the object and handle streams. 14 non-CRC
         families (FNV-1, FNV-1a, djb2, djb2-xor, sdbm, Murmur64A, xxHash64,
         Fletcher-64, Adler-64, sum64, xor64, both MSVC-LCG folds and a
         multiply-fold accumulator) x 65 buffers x 10 seed forms (0, ~0,
         length, seed1(len), seed2(len), 0x110, file size, the xxHash prime,
         the key and ~key) = 9100 combinations, graded as exact, XOR-const
         and ADD-const: NO HIT. The buffers included AcDb:AcDbObjects and
         AcDb:Handles whole, both concatenations, the decoded object map as
         (handle, offset) pairs, the handle list alone, the offset list
         alone, handle range/count/sum summaries, every other decompressed
         section, the eight-section stream-order concatenation, the record
         and its variants, the 0x80 prologue, both maps compressed and
         uncompressed, the RS payload, the compressed record, the whole
         file, the body 0x480..header2, the tail, a page-geometry vector,
         and the word-order permutation of every buffer under 4 KiB.
       - 32-BIT DIGESTS against S, which is the right target now that the
         expansion is known: CRC-32 (inverted and raw), Adler-32, FNV-1a-32,
         Murmur3-32 and this container's own `cksum32R2007` (with its
         length-derived seed and with every other seed form) over the same
         65 buffers = 4550 combinations: NO HIT.
       - LAYOUT. Sheet1/Sheet2/Sheet3.dwg of the SheetSetVBA sample are
         genuine near-twins — identical file size, identical page ids,
         offsets and disk sizes, identical section data sizes — with three
         completely unrelated random_seeds. The field is not a function of
         the layout or of the record.

     A REUSABLE CONTENT ORACLE is worth rebuilding for that: because those
     twins share a layout, one section's disk pages can be transplanted
     from donor to base, that page's record (compressed size, Adler, CRC)
     copied into the section map, the section-map system page rebuilt
     inside its existing allocation, the 0x110 record's secmap sizes, CRCs
     and correction factor rewritten and both header blocks re-emitted —
     changing drawing CONTENT while keeping the base's genuine random_seed.
     The version that existed (.tmp-acad/zz-r11-splice.mjs) had the
     block-count bug described below, and its no-op control passed only by
     luck of the base file it was run on, so treat every verdict it
     produced as unproven. Any rebuild of that kind must derive the
     geometry the way the paragraph after next sets out.

     WITHDRAWN (campaign 12): "a second blocker in `compressR2007`". A
     previous entry here recorded that rebuilding a genuine file's
     section-map page from a payload of our own is refused with
     ErrorStatus=434 while the same rebuild keeping AutoCAD's bytes AUDITs
     clean, and concluded that AutoCAD rejects the streams we produce.
     THAT CONCLUSION WAS WRONG, and the compressor was never at fault. The
     probe was: zz-r11-splice.mjs took the page's RS block count from its
     ON-DISK ALLOCATION, floor(alloc/255). The reader takes it from the
     record's own fields, ceil(round8(sizeComp) * repeat / 239). Those two
     agree only when the allocation has no slack, so the moment the payload
     changed length the page was interleaved across sixteen blocks and
     de-interleaved across fifteen, and every byte after the first was
     garbage. Rebuild the same page with the READER's geometry and our own
     `compressR2007` output (1860 -> 703 bytes) AUDITs clean at 0 errors.
     The stored variant failed for its own reason: a system page whose
     compressed size equals its uncompressed size is not a shape AutoCAD
     reads back.

     The rule, verified on 102 of 102 genuine files, is worth having in one
     place, because two different derivations of the same number are what
     made the trap:
       repeat = the largest c with ceil(round8(comp) * c / 239) * 255 <= alloc
       blocks = ceil(round8(comp) * repeat / 239)
     `systemPageCopies` below satisfies both for every payload length from
     1 to 40000 (checked exhaustively), because it derives the allocation
     from the block count rather than the other way round. Any probe that
     edits a page inside a FIXED allocation must use the rule above.

     THE REAL SECOND BLOCKER was in this file, and is now fixed: `rsEncode`
     used the RS(255,239) generator for data pages too. See the comment on
     `rsCode` above — the two codes do not share a field, twelve of the
     sixteen parity bytes fell off the end of the page, and the four that
     landed were wrong. AutoCAD checks them: flipping the parity of ONE
     data page in an otherwise untouched genuine file is refused with
     ErrorStatus=53, and so is zeroing the padding between the payload and
     the end of the block, which invalidates the same codeword. Neither
     region is covered by any checksum in the container, which is why this
     survived every CRC campaign.

     With both of those settled, the whole write path is now graded end to
     end on genuine material: every compressed page of a genuine file
     recompressed by `compressR2007`, its section map recompressed, its
     0x110 record recompressed and every RS block re-encoded by us, AUDITs
     clean at 0 errors — on Sheet1.dwg (6 pages, 8914 -> 7661 bytes) and on
     Assembly Sample.dwg (11 pages, 180853 -> 176208 bytes, 2600 objects,
     8 blocks). Our compressed output is 93.7% of AutoCAD's over all 1231
     compressed pages of the corpus and round-trips through our own
     decompressor on every one of them.

     WHERE TO GO NEXT. One item is left, and it is `random_seed`: find what
     pins S. It is 32 bits, uniformly distributed, absent from the file,
     and neither a digest of any buffer swept above nor a function of the
     layout. The untried shapes are a digest over material we have never
     assembled (the object map in AutoCAD's own in-memory order, handle
     values with their object types, the class section keyed by name) and a
     32-bit fold of a 64-bit digest.

     The field survived a re-grade under the corrected geometry, with a
     control the earlier campaigns did not have (Sheet1.dwg, all copies
     patched, one isolated launch each):
       pagesmap_crc_seed 0x20 = 0                    -> 0 errors, record 149
       crc_seed_encoded  0xF8 = a full-entropy word   -> 0 errors, record 154
       crc_seed_encoded  0xF8 = another such word     -> 0 errors, record 160
       random_seed       0x100 = 0                    -> 53, record 153
       random_seed       0x100 = genuine ^ 1          -> 53, record 160
       random_seed       0x100 = another file's value -> 53, record 160
     The two 0xF8 rows are entropy- and length-matched to the refused rows,
     so neither the compressed length, the copy stride nor "eight random
     bytes near the record tail" explains the refusal: only the offset
     does. The 434 trap cannot reach this harness either, because the file
     header block is fixed by the format at THREE RS(255,239) blocks — the
     reader hard-codes that count instead of deriving it — so a record
     length change moves only the copy stride. Writing a genuine file's
     random_seed into one of OUR files does not help (53), as expected of a
     file-specific value.

     Until that lands, R2007 cannot open, and PASS_BASELINE in
     tools/validate-external.mjs must stay at six releases. */
  const stride = round8(unit.length);
  const headerPayload = new Uint8Array(3 * 239);
  for (let c = 0; c * stride + unit.length <= headerPayload.length; c++) {
    headerPayload.set(unit, c * stride);
  }
  const headerCoded = rsEncode(headerPayload, 239, 3);

  /* -- lay the file out -- */
  const out = new Uint8Array(fileSize);
  const magic = 'AC1021';
  for (let i = 0; i < magic.length; i++) out[i] = magic.charCodeAt(i);
  out[0x0b] = 0x32;                       /* maintenance release */
  out[0x0c] = 0x03;
  out[0x11] = 0x21;                       /* app version: AutoCAD 2027 */
  out[0x12] = 0xff;                       /* app maintenance */
  out[0x13] = 30; out[0x14] = 0;          /* codepage: ANSI_1252 */
  out[0x16] = 0x21; out[0x17] = 0xff;     /* app version pair, again */
  out[0x28] = 0x80;                       /* file header address */
  out.set(headerCoded.subarray(0, Math.min(headerCoded.length, 0x3d8)), 0x80);
  out.set(checkData(seeds.r1, seeds.r2, seeds.word5), PAGE_BASE - 0x28);

  let at = PAGE_BASE;
  out.set(pagesMapPage, at); at += pagesMapPage.length;
  out.set(pagesMapPage, at); at += pagesMapPage.length;
  for (const pages of bySection) {
    for (const pg of pages) { out.set(pg.disk, at); at += pg.disk.length; }
  }
  out.set(secMapSys.page, at); at += secMapSys.page.length;
  out.set(secMapSys.page, at); at += secMapSys.page.length;
  /* the trailing second header: the coded block over again */
  out.set(out.subarray(0x80, 0x80 + 0x3d8), header2At);
  return out;
};
