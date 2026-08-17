/* nasjidwg — R2007 (AC1021) file structure layer.
 *
 * R2007 is the only DWG release that wraps its container in Reed-Solomon
 * codewords: the file header and the page/section maps use RS(255,239),
 * data pages RS(255,251), with the payload bytes of all blocks interleaved
 * across the page. On an undamaged file the parity bytes are redundant, so
 * we only de-interleave the payload and skip the error correction — a
 * corrupt page surfaces as a decompression failure instead. Pages are
 * further packed with R2007's private LZ77 dialect whose literal runs are
 * stored byte-shuffled (see the remainder table below).
 */

import { lzParse } from './compress.js';
import type { LzRules } from './compress.js';

/* ------------------------------------------------------------------ */
/* small helpers                                                      */

const round8 = (n: number): number => (n + 7) & ~7;

/** Read a little-endian u64 as a JS number; DWG offsets/sizes fit easily,
 *  anything larger means we are reading garbage. */
const u64 = (dv: DataView, at: number): number => {
  const v = dv.getBigUint64(at, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`R2007: 64-bit value at ${at} out of sane range`);
  }
  return Number(v);
};

/** Signed variant — page ids are negative for free/gap pages. */
const i64 = (dv: DataView, at: number): number => {
  const v = dv.getBigInt64(at, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`R2007: 64-bit value at ${at} out of sane range`);
  }
  return Number(v);
};

const view = (b: Uint8Array): DataView =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);

/* ------------------------------------------------------------------ */
/* Reed-Solomon payload extraction                                    */

/** Undo the RS block interleave: byte j of block i sits at src[j*blocks+i].
 *  Parity (the last 255-k bytes of each codeword) is simply not visited. */
function deinterleaveRs(src: Uint8Array, blocks: number, dataSize: number): Uint8Array {
  if (blocks <= 0 || blocks * dataSize > src.length) {
    throw new Error(`R2007: RS page too small for ${blocks} block(s)`);
  }
  const out = new Uint8Array(blocks * dataSize);
  let d = 0;
  for (let i = 0; i < blocks; i++) {
    for (let j = 0, s = i; j < dataSize; j++, s += blocks) out[d++] = src[s];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* R2007 decompression                                                */

/* Literal runs are not stored in reading order.
 *
 * A run is consumed 32 bytes at a time, and within each of those groups the
 * four 8-byte words come out back to front. Whatever is left over — 0 to 31
 * bytes — gets a shuffle of its own, one per possible remainder, and those
 * follow no rule that can be computed: they are simply the order the writer
 * emits. So they are tabulated here in the most primitive form there is, a
 * destination-to-source byte map per remainder. Row n reads "byte k of an
 * n-byte tail was stored at input byte TAIL_ORDER[n][k]", digits base 32.
 *
 * The rows were read off real R2007 payloads and are re-checked on every
 * test run: test/dwg.test.ts decodes AC1021 fixtures whose contents are
 * known, and any wrong entry corrupts a literal run into garbage. */
const TAIL_ORDER: readonly Uint8Array[] = [
  '', '0', '10', '210',
  '0123', '40123', '512340', '6512340',
  '01234567', '801234567', '9123456780', 'a9123456780',
  '89ab01234567', 'c89ab01234567', 'd9abc123456780', 'ed9abc123456780',
  '89abcdef01234567', '9abcdefg801234567', 'h9abcdefg123456780',
  'ihg89abcdef01234567', 'ghij89abcdef01234567', 'kghij89abcdef01234567',
  'lkghij89abcdef01234567', 'mlkghij89abcdef01234567',
  'ghijklmn89abcdef01234567', 'hijklmnog89abcdef01234567',
  'phijklmnog89abcdef01234567', 'qphijklmnog89abcdef01234567',
  'opqrghijklmn89abcdef01234567', 'sopqrghijklmn89abcdef01234567',
  'tsopqrghijklmn89abcdef01234567', 'uqrstijklmnopabcdefgh2345678910',
].map((row) => Uint8Array.from([...row], (c) => parseInt(c, 32)));

/** Lay a literal run down in reading order, undoing the storage shuffle. */
function placeLiteral(
  dst: Uint8Array, d: number, src: Uint8Array, s: number, length: number
): void {
  /* Whole groups: last 8-byte word first, first word last. */
  while (length >= 32) {
    for (let word = 24; word >= 0; word -= 8) {
      for (let i = 0; i < 8; i++) dst[d++] = src[s + word + i];
    }
    s += 32;
    length -= 32;
  }
  const order = TAIL_ORDER[length];
  for (let k = 0; k < length; k++) dst[d + k] = src[s + order[k]];
}

/** R2007 LZ77 variant. Writes into dst[dstStart..dstEnd); the stream is
 *  allowed to stop short of dstEnd (callers pre-zero the buffer) but may
 *  never write past it. Exported for the compressor's round-trip tests. */
export function decompress(
  dst: Uint8Array, dstStart: number, dstEnd: number,
  src: Uint8Array, srcLen: number,
): void {
  const end = Math.min(srcLen, src.length);
  if (end < 2) throw new Error('R2007: compressed stream too short');
  let s = 0;
  let d = dstStart;
  let opcode = 0;
  let offset = 0;
  let length = 0;

  const byte = (): number => {
    if (s >= end) throw new Error('R2007: compressed stream ran out');
    return src[s++];
  };

  /* Size of the next literal run. Opcodes 0x01..0x0E state 9..22 outright;
   * 0x0F means "more than that" and opens a chain — one byte, then 16-bit
   * words for as long as each one saturates. */
  const takeLiteralCount = (): void => {
    length = opcode + 8;
    if (length !== 0x17) return;
    let more = byte();
    length += more;
    if (more !== 0xff) return;
    do {
      more = byte() | (byte() << 8);
      length += more;
    } while (more === 0xffff);
  };

  /* A back-reference: how far back, and how much. Three encodings, widening
   * as the distance grows. Whichever byte is read last also carries the size
   * of the literal run that comes after the copy, which is why `opcode`
   * survives the call instead of being consumed here. */
  const takeBackReference = (): void => {
    if (opcode < 0x20) {
      /* Near: one byte of distance plus high bits from the byte after it.
       * Below 0x10 the length base is larger and steals that byte's top bit
       * for one more length bit, leaving it four distance bits instead of
       * five — otherwise the two halves of this range are the same shape. */
      const wide = opcode < 0x10;
      length = (opcode & 0xf) + (wide ? 0x13 : 3);
      const low = byte();
      const high = byte();
      if (wide) length += (high >> 3) & 0x10;
      offset = low + ((high & (wide ? 0x78 : 0xf8)) << 5) + 1;
      opcode = high;
    } else if (opcode < 0x30) {
      /* Far: a full 16-bit distance, and bit 3 says whether the length is
       * one more byte or two. */
      offset = byte() | (byte() << 8);
      length = opcode & 7;
      if ((opcode & 8) === 0) {
        opcode = byte();
        length += opcode & 0xf8;
      } else {
        offset++;
        length += byte() << 3;
        opcode = byte();
        length += ((opcode & 0xf8) << 8) + 0x100;
      }
    } else {
      /* Compact: length and the low distance bits inside the opcode, the
       * rest in the single byte behind it. */
      length = opcode >> 4;
      offset = opcode & 15;
      opcode = byte();
      offset += ((opcode & 0xf8) << 1) + 1;
    }
  };

  opcode = byte();
  if ((opcode & 0xf0) === 0x20) {
    /* Alternate stream header: two ignored bytes, then an initial literal
     * length that must be nonzero. */
    s += 2;
    length = byte() & 7;
    if (length === 0) throw new Error('R2007: zero-length stream header');
  }

  while (s < end) {
    if (length === 0) takeLiteralCount();
    if (d + length > dstEnd || s + length > end) {
      throw new Error('R2007: literal run overflows buffer');
    }
    placeLiteral(dst, d, src, s, length);
    d += length;
    s += length;
    length = 0;

    if (s >= end) return;
    opcode = byte();
    takeBackReference();

    for (;;) {
      if (d + length > dstEnd) throw new Error('R2007: match overflows buffer');
      if (offset > d - dstStart) throw new Error('R2007: match offset before stream start');
      /* Overlapping copy must run forward byte by byte: offset < length
       * means the source repeats what we just wrote. */
      for (let i = 0, from = d - offset; i < length; i++) dst[d + i] = dst[from + i];
      d += length;

      length = opcode & 7;
      if (length !== 0 || s >= end) break;
      opcode = byte();
      if (opcode >> 4 === 0) break;      /* next opcode is a literal length */
      if (opcode >> 4 === 0x0f) opcode &= 0xf;
      takeBackReference();
    }
  }
}

/* ------------------------------------------------------------------ */
/* R2007 compression                                                  */

const R2007_RULES: LzRules = {
  /* The smallest standalone literal count is eight (opcode 0x00), so the
   * stream's opening run — which must stand alone — pins the first match
   * at position eight or later. */
  firstMatchAt: 8,
  /* The far form stores its distance in sixteen raw bits. */
  maxDistance: 0xffff,
  /* The far form's long-length variant: 0x100 base plus a 16-bit field. */
  maxLength: 0x100ff,
  /* A three-byte match past the near form's reach costs four bytes to
   * spell — as much as it saves — so the matcher skips those. */
  shortMatchMaxDistance: 0x2000,
};

/** Pack `src` into a stream `decompress` above reverses byte for byte.
 *
 *  The same greedy matcher as R2004 drives every shape the decoder knows:
 *  the compact form (two bytes, distance to 0x200, length 3..15), both
 *  halves of the near form (three bytes — 0x10..0x1F for length 3..18 to
 *  distance 0x2000, 0x00..0x0F for length 19..50 to distance 0x1000), and
 *  the far form in both its length widths (distance to 0xFFFF).
 *
 *  Two of those shapes are position-dependent, because a reference opcode
 *  means something else when the decoder reads it BETWEEN two matches —
 *  there a high nibble of zero introduces a literal run instead. So the
 *  0x00..0x0F half goes out masked as 0xF0..0xFF in that position (the
 *  decoder strips the mask), and compact length 15, whose opcode is
 *  0xF0..0xFF, is only spelled where it cannot be mistaken for that mask,
 *  i.e. straight after a literal run. Both cases fall back to a form that
 *  reaches the same match one byte wider. Genuine AC1021 streams use every
 *  one of these shapes under exactly the same rules.
 *
 *  Literal runs go out pre-shuffled so placeLiteral restores reading order:
 *  each whole 32-byte group with its four words reversed, the tail scattered
 *  through TAIL_ORDER. Runs of one to seven ride the low three bits of the
 *  byte that ends the reference before them; standalone runs say 8..22 in
 *  one opcode and escape beyond that through a byte, then 16-bit words.
 *  There is no terminator — the stream just ends, so a trailing match
 *  simply leaves its literal-count bits at zero.
 *
 *  Inputs under eight bytes are padded to eight, the shortest opening run;
 *  callers must give the decoder that much room (the library's own callers
 *  always decompress with slack) or store such payloads uncompressed, as
 *  the R2007 writer does — a run that small never shrinks anyway. */
export function compressR2007(src: Uint8Array): Uint8Array {
  const data = src.length >= 8 ? src : (() => {
    const padded = new Uint8Array(8);
    padded.set(src);
    return padded;
  })();
  const out: number[] = [];
  /* Index of the byte whose low three bits will name the literal run that
   * follows the match just written; -1 while no match has been written. */
  let countAt = -1;

  /* Emit `length` literals starting at `from`, in storage order: whole
   * groups word-reversed, the tail permuted so that placeLiteral's
   * dst[d + k] = src[s + TAIL_ORDER[len][k]] lands every byte back home. */
  const pushShuffled = (from: number, length: number): void => {
    let p = from;
    let left = length;
    while (left >= 32) {
      for (let word = 24; word >= 0; word -= 8) {
        for (let i = 0; i < 8; i++) out.push(data[p + word + i]);
      }
      p += 32;
      left -= 32;
    }
    if (left > 0) {
      const order = TAIL_ORDER[left];
      const tail = new Uint8Array(left);
      for (let k = 0; k < left; k++) tail[order[k]] = data[p + k];
      for (let k = 0; k < left; k++) out.push(tail[k]);
    }
  };

  const literals = (from: number, to: number): void => {
    const run = to - from;
    if (run === 0) return;
    if (countAt >= 0 && run <= 7) {
      out[countAt] |= run;                 /* rides the previous reference */
    } else if (run <= 22) {
      out.push(run - 8);                   /* stated outright, 0x00..0x0E */
    } else {
      /* 0x0F opens the chain: one byte, then 16-bit words for as long as
       * each saturates — including a final zero word when the count lands
       * exactly on a boundary, because the decoder always reads on. */
      out.push(0x0f);
      let left = run - 23;
      if (left < 0xff) {
        out.push(left);
      } else {
        out.push(0xff);
        left -= 0xff;
        for (;;) {
          const word = Math.min(left, 0xffff);
          out.push(word & 0xff, word >> 8);
          left -= word;
          if (word !== 0xffff) break;
        }
      }
    }
    pushShuffled(from, run);
  };

  /* `atTop` is true when the decoder will read this opcode straight after a
   * literal run, where every byte value is a reference; false when it reads
   * it between two matches, where a high nibble of zero means "literal run"
   * and 0xF0..0xFF is the mask that escapes it. */
  const match = (length: number, distance: number, atTop: boolean): void => {
    if (distance <= 0x200 && (length <= 14 || (length === 15 && atTop))) {
      /* Compact: two bytes. Length 15 puts the opcode in 0xF0..0xFF, so it
       * is only spelled where that cannot read as the escape. */
      out.push((length << 4) | ((distance - 1) & 0xf));
      countAt = out.length;
      out.push(((distance - 1) >> 4) << 3);
    } else if (length <= 18 && distance <= 0x2000) {
      /* Near, upper half: 13-bit distance split over the trailing pair. */
      out.push(0x10 | (length - 3), (distance - 1) & 0xff);
      countAt = out.length;
      out.push(((distance - 1) >> 8) << 3);
    } else if (length >= 0x13 && length <= 0x32 && distance <= 0x1000) {
      /* Near, lower half: three bytes for the lengths the upper half cannot
       * reach. The length's low nibble rides the opcode and its fifth bit
       * the top bit of the trailing byte, which also carries the distance's
       * high nibble in bits 3..6. Between matches the opcode is masked. */
      const n = length - 0x13;
      out.push((atTop ? 0 : 0xf0) | (n & 0xf), (distance - 1) & 0xff);
      countAt = out.length;
      out.push(((((distance - 1) >> 8) & 0xf) << 3) | (n >= 0x10 ? 0x80 : 0));
    } else if (length <= 0xff) {
      /* Far, one length byte: bit 3 clear, the distance stored raw. */
      out.push(0x20 | (length & 7), distance & 0xff, distance >> 8);
      countAt = out.length;
      out.push(length & 0xf8);
    } else {
      /* Far, two length bytes: bit 3 set, distance stored minus one and
       * the length minus its 0x100 base spread over opcode and pair. */
      const rem = length - 0x100;
      out.push(0x28 | (rem & 7), (distance - 1) & 0xff, (distance - 1) >> 8,
               (rem >> 3) & 0xff);
      countAt = out.length;
      out.push((rem >> 11) << 3);
    }
  };

  lzParse(data, R2007_RULES, (litFrom, litTo, length, distance) => {
    literals(litFrom, litTo);
    /* A literal run of any size — inline, stated or chained — puts the
     * decoder back at the top of its loop, where the next byte it reads is
     * unconditionally a reference. With no run between two matches it is
     * still inside the copy loop, where the opcode is read differently. */
    if (length > 0) match(length, distance, litTo > litFrom);
  });
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ */
/* pages                                                              */

/** First data page: 0x80 header prologue + 0x3D8 RS-coded header
 *  + 0x28 check bytes. Page map offsets are relative to this. */
const PAGE_BASE = 0x480;

/** System pages (page map, section map): RS(255,239); the payload may be
 *  written `repeat` times over for redundancy — we use the first copy. */
function readSystemPage(
  data: Uint8Array, at: number,
  sizeComp: number, sizeUncomp: number, repeat: number,
): Uint8Array {
  if (sizeComp <= 0 || sizeComp >= data.length || sizeUncomp <= 0
      || sizeUncomp >= data.length || repeat <= 0 || repeat > 0x100000) {
    throw new Error(
      `R2007: invalid system page (comp ${sizeComp}, uncomp ${sizeUncomp}, x${repeat})`);
  }
  const blocks = Math.ceil((round8(sizeComp) * repeat) / 239);
  const pageSize = round8(blocks * 255);
  if (at < 0 || at + pageSize > data.length) {
    throw new Error(`R2007: system page at ${at} (+${pageSize}) outside the file`);
  }
  const payload = deinterleaveRs(data.subarray(at, at + pageSize), blocks, 239);
  if (sizeComp >= sizeUncomp) return payload.slice(0, sizeUncomp);
  /* Slack after sizeUncomp: the stream may legally overshoot its logical
   * size, so give it room and hand back only the logical part. */
  const buf = new Uint8Array(sizeUncomp + pageSize);
  decompress(buf, 0, buf.length, payload, Math.min(payload.length, sizeComp));
  return buf.subarray(0, sizeUncomp);
}

/** On-disk size of a data page if its payload were RS(255,251) coded and
 *  padded to 32. Data page records carry no RS flag (unlike R2004+), so a
 *  size match is the only way to detect coding on uncompressed pages. */
const rsCodedSize = (sizeComp: number): number => {
  const blocks = Math.ceil(round8(sizeComp) / 0xfb);
  return (blocks * 0xff + 31) & ~31;
};

/* ------------------------------------------------------------------ */
/* file header                                                        */

interface Header2007 {
  pagesMapCorrection: number;
  pagesMapOffset: number;
  pagesMapSizeComp: number;
  pagesMapSizeUncomp: number;
  sectionsMapSizeComp: number;
  sectionsMapId: number;
  sectionsMapSizeUncomp: number;
  sectionsMapCorrection: number;
}

const HEADER_AT = 0x80;
const HEADER_RAW = 0x3d8;     /* three interleaved RS(255,239) blocks */
const HEADER_SIZE = 0x110;    /* decompressed metadata record */

function readFileHeader(data: Uint8Array): Header2007 {
  if (data.length < HEADER_AT + HEADER_RAW) {
    throw new Error('R2007: file too short for the encoded file header');
  }
  const payload = deinterleaveRs(
    data.subarray(HEADER_AT, HEADER_AT + HEADER_RAW), 3, 239);
  /* 32-byte prologue: crc64, key, compressed crc64, comprLen, len2.
   * comprLen <= 0 means the metadata record is stored verbatim. */
  const comprLen = view(payload).getInt32(24, true);
  let hdr: Uint8Array;
  if (comprLen > 0) {
    hdr = new Uint8Array(HEADER_SIZE);
    decompress(hdr, 0, HEADER_SIZE, payload.subarray(32),
               Math.min(comprLen, payload.length - 32));
  } else {
    hdr = payload.slice(32, 32 + HEADER_SIZE);
  }
  const dv = view(hdr);
  return {
    pagesMapCorrection: u64(dv, 0x18),
    pagesMapOffset: u64(dv, 0x38),
    pagesMapSizeComp: u64(dv, 0x50),
    pagesMapSizeUncomp: u64(dv, 0x58),
    sectionsMapSizeComp: u64(dv, 0xb0),
    sectionsMapId: i64(dv, 0xc0),
    sectionsMapSizeUncomp: u64(dv, 0xc8),
    sectionsMapCorrection: u64(dv, 0xd8),
  };
}

/* ------------------------------------------------------------------ */
/* page map and section map                                           */

interface FilePage {
  offset: number;   /* absolute position in the file */
  size: number;     /* on-disk size */
}

function readPagesMap(data: Uint8Array, fh: Header2007): Map<number, FilePage> {
  const buf = readSystemPage(
    data, PAGE_BASE + fh.pagesMapOffset,
    fh.pagesMapSizeComp, fh.pagesMapSizeUncomp, fh.pagesMapCorrection);
  if (buf.length % 16 !== 0) {
    throw new Error(`R2007: pages map size ${buf.length} not a whole number of entries`);
  }
  const dv = view(buf);
  const pages = new Map<number, FilePage>();
  /* Page positions are not stored — they accumulate from the sizes, in map
   * order, starting right after the file header block. Negative ids are
   * free/gap pages and still occupy space. */
  let offset = PAGE_BASE;
  for (let pos = 0; pos < buf.length; pos += 16) {
    const size = u64(dv, pos);
    const id = i64(dv, pos + 8);
    if (!pages.has(id)) pages.set(id, { offset, size });
    offset += size;
  }
  return pages;
}

interface SectionPage {
  targetOffset: number;   /* where in the assembled section this page lands */
  pageId: number;
  uncompSize: number;
  compSize: number;
}

interface SectionDesc {
  name: string;
  dataSize: number;
  pages: SectionPage[];
}

function readSectionsMap(
  data: Uint8Array, fh: Header2007, pages: Map<number, FilePage>,
): SectionDesc[] {
  const mapPage = pages.get(fh.sectionsMapId);
  if (!mapPage) {
    throw new Error(`R2007: sections map page ${fh.sectionsMapId} missing from pages map`);
  }
  const buf = readSystemPage(
    data, mapPage.offset,
    fh.sectionsMapSizeComp, fh.sectionsMapSizeUncomp, fh.sectionsMapCorrection);
  const dv = view(buf);
  const out: SectionDesc[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 64 > buf.length) throw new Error('R2007: truncated section map entry');
    const dataSize = u64(dv, pos);            /* +8 maxSize, +16 encrypted,   */
    const nameLength = u64(dv, pos + 32);     /* +24 hash, +40/+48 unknowns   */
    const numPages = u64(dv, pos + 56);
    pos += 64;
    if (dataSize > 10 * data.length || nameLength >= 48) {
      throw new Error('R2007: implausible section map entry');
    }

    /* Name is UTF-16LE with the NUL included in nameLength (bytes). The
     * canonical names are plain ASCII, so keeping the low byte of each code
     * unit yields the same 'AcDb:*' keys the rest of the library uses. */
    let nameBytes = nameLength + (nameLength & 1);
    if (pos + nameBytes > buf.length) nameBytes = (buf.length - pos) & ~1;
    let name = '';
    for (let i = pos; i + 2 <= pos + nameBytes; i += 2) {
      const cu = buf[i] | (buf[i + 1] << 8);
      if (cu === 0) break;
      name += String.fromCharCode(cu & 0xff);
    }
    pos += nameBytes;

    /* Garbage page counts leave nothing to resync on; skip the entry and let
     * the loop try the next 64-byte record. */
    if (numPages <= 0 || numPages > 0xf0000) continue;

    const secPages: SectionPage[] = [];
    for (let i = 0; i < numPages; i++) {
      if (pos + 56 > buf.length) break;       /* truncated tail: keep what fits */
      secPages.push({
        targetOffset: u64(dv, pos),           /* +8 size, +40 checksum, +48 crc */
        pageId: i64(dv, pos + 16),
        uncompSize: u64(dv, pos + 24),
        compSize: u64(dv, pos + 32),
      });
      pos += 56;
    }
    if (name) out.push({ name, dataSize, pages: secPages });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* section assembly                                                   */

function assembleSection(
  data: Uint8Array, sec: SectionDesc, pages: Map<number, FilePage>,
): Uint8Array {
  const out = new Uint8Array(sec.dataSize);
  for (const sp of sec.pages) {
    const page = pages.get(sp.pageId);
    if (!page) throw new Error(`R2007: section '${sec.name}' references unknown page ${sp.pageId}`);
    if (sp.targetOffset + sp.uncompSize > out.length) {
      throw new Error(`R2007: section '${sec.name}' page lands outside its data`);
    }
    if (sp.compSize !== sp.uncompSize || page.size === rsCodedSize(sp.compSize)) {
      /* RS coding and compression are independent: an uncompressed page can
       * still be RS coded, betrayed only by its on-disk size. */
      if (page.offset + page.size > data.length) {
        throw new Error(`R2007: page ${sp.pageId} outside the file`);
      }
      const blocks = Math.ceil(round8(sp.compSize) / 0xfb);
      const payload = deinterleaveRs(
        data.subarray(page.offset, page.offset + page.size), blocks, 0xfb);
      if (sp.compSize < sp.uncompSize) {
        /* Decompress straight into the shared buffer: a page may overshoot
         * its own slot as long as it stays inside the section. */
        decompress(out, sp.targetOffset, out.length,
                   payload, Math.min(payload.length, sp.compSize));
      } else {
        out.set(payload.subarray(0, sp.uncompSize), sp.targetOffset);
      }
    } else {
      if (page.offset + sp.uncompSize > data.length) {
        throw new Error(`R2007: page ${sp.pageId} outside the file`);
      }
      out.set(data.subarray(page.offset, page.offset + sp.uncompSize), sp.targetOffset);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

/** Decompressed logical sections of an R2007 DWG, keyed by canonical name
 *  ('AcDb:Header', 'AcDb:Classes', 'AcDb:Handles', 'AcDb:AcDbObjects', ...). */
export function readSections2007(data: Uint8Array): Map<string, Uint8Array> {
  if (data.length < 6 || String.fromCharCode(...data.subarray(0, 6)) !== 'AC1021') {
    throw new Error('R2007: not an AC1021 (2007-2009) DWG');
  }
  const fh = readFileHeader(data);
  const pages = readPagesMap(data, fh);
  const sections = readSectionsMap(data, fh, pages);
  const out = new Map<string, Uint8Array>();
  for (const sec of sections) {
    if (sec.pages.length === 0) continue;
    try {
      out.set(sec.name, assembleSection(data, sec, pages));
    } catch {
      /* A damaged optional section must not kill the whole file; callers
       * notice a required section by its absent key. */
    }
  }
  return out;
}
