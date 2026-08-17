/* nasjidwg — R2004-family (AC1018/AC1024/AC1027/AC1032) file structure.
 *
 * These versions store the drawing as named logical sections split across
 * fixed-size pages scattered through the file. Three indirections stand
 * between the raw bytes and a section: a file header at 0x80, "encrypted"
 * with a pseudo-random XOR pad, that locates the page map; a compressed
 * system page mapping page numbers to file offsets; and a compressed
 * section map listing each named section's pages. Data pages then carry a
 * 32-byte header XORed with their own file address. R2010-R2018 reuse this
 * structure unchanged — only section contents differ, which is the next
 * layer's problem. R2007 (AC1021) is a different format and not ours.
 */

import { decompressR2004, decompressR2004Into } from './compress.js';

const PAGE_MAP_TYPE = 0x41630e3b;      /* system page: page map */
const SECTION_MAP_TYPE = 0x4163003b;   /* system page: section map */
const DATA_PAGE_MASK = 0x4164536b;     /* XORed with the page's file address */

const R2004_FAMILY = new Set(['AC1018', 'AC1024', 'AC1027', 'AC1032']);

/* ------------------------------------------------------------------ */

const asciiz = (bytes: Uint8Array, start: number, len: number): string => {
  let out = '';
  for (let i = start; i < start + len && i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
};

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/* File offsets fit comfortably in a double; avoids BigInt plumbing. */
const u64 = (dv: DataView, off: number): number =>
  dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;

/* ------------------------------------------------------------------ */

interface FileHeader2004 {
  /** Absolute file offset of the page map system page (stored + 0x100). */
  pageMapAddress: number;
  /** Page number of the section map system page. */
  sectionMapPage: number;
  /** Highest valid page number; larger ids are junk entries. */
  pageArraySize: number;
}

const decryptFileHeader = (data: Uint8Array): FileHeader2004 => {
  if (data.length < 0x80 + 0x6c) {
    throw new Error('DWG truncated before the R2004 file header at 0x80');
  }
  const dec = new Uint8Array(0x6c);
  let x = 1;
  for (let i = 0; i < dec.length; i++) {
    /* The "encryption" is a one-time pad from the MS CRT rand() LCG;
     * imul keeps the 32-bit multiply exact where * would lose low bits. */
    x = (Math.imul(x, 0x343fd) + 0x269ec3) >>> 0;
    dec[i] = data[0x80 + i] ^ ((x >>> 16) & 0xff);
  }
  if (asciiz(dec, 0, 12) !== 'AcFssFcAJMB') {
    throw new Error('R2004 file header failed to decrypt (bad id string)');
  }
  const dv = view(dec);
  return {
    pageMapAddress: u64(dv, 0x54) + 0x100,
    sectionMapPage: dv.getUint32(0x5c, true),
    pageArraySize: dv.getUint32(0x60, true),
  };
};

/** Read a system page (page map / section map) header at `addr` and inflate
 *  its payload. Both share a 20-byte header: type, decompressed size,
 *  compressed size, compression method, checksum (not verified). */
const readSystemPage = (
  data: Uint8Array, addr: number, expectType: number, what: string,
): Uint8Array => {
  if (addr < 0 || addr + 20 > data.length) {
    throw new Error(`${what} at 0x${addr.toString(16)} is past the end of the file`);
  }
  const dv = view(data);
  const type = dv.getUint32(addr, true);
  if (type !== expectType) {
    throw new Error(
      `${what}: page type 0x${type.toString(16)} != 0x${expectType.toString(16)}`);
  }
  const decompSize = dv.getUint32(addr + 4, true);
  const compSize = dv.getUint32(addr + 8, true);
  if (decompSize > 0xff000000) {
    throw new Error(`${what}: absurd decompressed size ${decompSize}`);
  }
  const end = Math.min(addr + 20 + compSize, data.length);
  return decompressR2004(data.subarray(addr + 20, end), decompSize);
};

/* ------------------------------------------------------------------ */

interface PageSlot { address: number; size: number; }

/** Page map: (number, size) pairs; addresses are implicit, each page
 *  following the previous one from 0x100 on. */
const parsePageMap = (map: Uint8Array, pageArraySize: number): Map<number, PageSlot> => {
  const dv = view(map);
  const pages = new Map<number, PageSlot>();
  let address = 0x100;
  let pos = 0;
  while (pos + 8 <= map.length) {
    const number = dv.getInt32(pos, true);
    const size = dv.getUint32(pos + 4, true);
    pos += 8;
    if (number > 0 && !pages.has(number)) pages.set(number, { address, size });
    /* Ids beyond the declared array size are junk; letting them advance
     * the address would shift every later page (negative ids are gaps
     * and do occupy space). */
    if (number <= pageArraySize) address += size;
    /* Gap entries carry four extra bookkeeping longs. */
    if (number < 0 && pos + 16 <= map.length) pos += 16;
  }
  return pages;
};

interface SectionDesc {
  name: string;
  /** Logical section length; pages may cover more (zero padding). */
  size: number;
  /** Decompressed capacity of one page of this section. */
  pageDecompSize: number;
  /** 1 = stored, 2 = LZ77. */
  compression: number;
  pages: { pageNumber: number; offset: number }[];
}

const parseSectionMap = (info: Uint8Array): SectionDesc[] => {
  if (info.length < 20) throw new Error('section map: truncated header');
  const dv = view(info);
  const numDesc = dv.getUint32(0, true);
  const descs: SectionDesc[] = [];
  let pos = 20;
  for (let i = 0; i < numDesc; i++) {
    if (pos + 96 > info.length) break;    /* truncated tail: keep what we have */
    const size = u64(dv, pos);
    const pageCount = dv.getUint32(pos + 8, true);
    const pageDecompSize = dv.getUint32(pos + 12, true);
    const compression = dv.getUint32(pos + 20, true);
    const name = asciiz(info, pos + 32, 64);
    pos += 96;
    if (pageCount > 0x100000) break;      /* not a plausible page count */
    const pages: SectionDesc['pages'] = [];
    /* Negative page numbers mark unused space and do not count against
     * the declared page count, so each one extends the loop by an entry. */
    let want = pageCount;
    for (let j = 0; j < want && pos + 16 <= info.length; j++) {
      const pageNumber = dv.getInt32(pos, true);
      const offset = u64(dv, pos + 8);
      pos += 16;
      if (pageNumber < 0) { want++; continue; }
      pages.push({ pageNumber, offset });
    }
    descs.push({ name, size, pageDecompSize, compression, pages });
  }
  return descs;
};

/* ------------------------------------------------------------------ */

/** Stitch one section together from its pages. Unreadable pages are left
 *  as zeros rather than failing the section; pages the section map never
 *  mentions (all-zero pages are not written out) stay zero the same way. */
const assembleSection = (
  data: Uint8Array, desc: SectionDesc, pageMap: Map<number, PageSlot>,
): Uint8Array | undefined => {
  let bufSize = desc.size;
  for (const p of desc.pages) {
    bufSize = Math.max(bufSize, p.offset + desc.pageDecompSize);
  }
  if (bufSize <= 0 || bufSize > 0x2f000000) return undefined;

  const dv = view(data);
  const out = new Uint8Array(bufSize);
  for (const p of desc.pages) {
    const slot = pageMap.get(p.pageNumber);
    if (!slot || slot.address + 32 > data.length) continue;
    const a = slot.address;
    /* The 32-byte data page header is XORed, longword by longword, with a
     * mask derived from the page's own file address. Beyond the fields
     * below it holds only a type tag and checksums we don't verify. */
    const mask = (DATA_PAGE_MASK ^ a) >>> 0;
    const compSize = (dv.getUint32(a + 8, true) ^ mask) >>> 0;
    const pageSize = (dv.getUint32(a + 12, true) ^ mask) >>> 0;
    const start = (dv.getUint32(a + 16, true) ^ mask) >>> 0;
    if (start >= bufSize) continue;
    if (desc.compression === 2) {
      const src = data.subarray(a + 32, Math.min(a + 32 + compSize, data.length));
      /* Inflate in place: the stream runs to its own terminator (pageSize
       * is NOT the decompressed length), and its back-references reach
       * into the previous pages' output. Any overshoot past this page's
       * slot is overwritten by the next page, which starts at its own
       * offset — the same discipline the reference uses. */
      try {
        decompressR2004Into(src, out, start);
      } catch {
        /* bad page: keep whatever landed, and the rest of the section */
      }
    } else {
      const n = Math.min(desc.size - start, pageSize, data.length - (a + 32));
      if (n > 0) out.set(data.subarray(a + 32, a + 32 + n), start);
    }
  }
  return out.subarray(0, Math.min(desc.size, bufSize));
};

/** Decompressed logical sections of an R2004+ (non-R2007) DWG, keyed by
 *  canonical name, e.g. 'AcDb:Header', 'AcDb:Classes', 'AcDb:Handles',
 *  'AcDb:AcDbObjects', 'AcDb:SummaryInfo'. */
export function readSections2004(data: Uint8Array): Map<string, Uint8Array> {
  const magic = asciiz(data, 0, 6);
  if (!R2004_FAMILY.has(magic)) {
    throw new Error(`not an R2004-family DWG (version "${magic}")`);
  }
  const fh = decryptFileHeader(data);
  const pageMap = parsePageMap(
    readSystemPage(data, fh.pageMapAddress, PAGE_MAP_TYPE, 'section page map'),
    fh.pageArraySize);
  const mapSlot = pageMap.get(fh.sectionMapPage);
  if (!mapSlot) {
    throw new Error(`section map page ${fh.sectionMapPage} missing from the page map`);
  }
  const descs = parseSectionMap(
    readSystemPage(data, mapSlot.address, SECTION_MAP_TYPE, 'section map'));

  const sections = new Map<string, Uint8Array>();
  for (const desc of descs) {
    if (!desc.name || desc.pages.length === 0 || sections.has(desc.name)) continue;
    const bytes = assembleSection(data, desc, pageMap);
    if (bytes) sections.set(desc.name, bytes);
  }
  return sections;
}
