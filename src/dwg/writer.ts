/* nasjidwg — DWG R2000 (AC1015) writer.
 *
 * Emits a complete R2000 file: file header with section locators, header
 * variables, classes, object data with per-object CRCs, the object map,
 * second header, ObjFreeSpace, measurement template and AuxHeader — the
 * exact mirror of the reader's decode path (which is oracle-validated
 * against independent decodes of real files).
 *
 * v1 entity coverage: line, point, circle, arc, ellipse, polyline (as
 * LWPOLYLINE), text, mtext, insert (without attribs), spline, solid,
 * ray/xline, 3dface. Everything else is skipped with a warning pushed to
 * the drawing's warnings array.
 */

import { BitWriter, crc16 } from './bitwriter.js';
import { BitReader } from './bitstream.js';
import { compressR2004 } from './compress.js';
import { SEAL_MAGIC, encodingGroup } from './objects.js';
import { assemble2007 } from './container2007.js';
import { buildAcDs } from './meta.js';
import { sabToSat } from '../acis/sab.js';
import type {
  DimStyle, Drawing, Entity, Layer, Linetype, Point2, Point3, TextStyle
} from '../core/model.js';
import { shapeArabic, mirrorBrackets, hasComplexScript } from '../text/arabic.js';
import { encodeCadSymbols } from '../text/escapes.js';

/* sentinels */
const SN_HEADER_END = [0x95, 0xA0, 0x4E, 0x28, 0x99, 0x82, 0x1A, 0xE5, 0x5E, 0x41, 0xE0, 0x5F, 0x9D, 0x3A, 0x4D, 0x00];
const SN_PREVIEW_BEGIN = [0x1F, 0x25, 0x6D, 0x07, 0xD4, 0x36, 0x28, 0x28, 0x9D, 0x57, 0xCA, 0x3F, 0x9D, 0x44, 0x10, 0x2B];
const SN_PREVIEW_END = [0xE0, 0xDA, 0x92, 0xF8, 0x2B, 0xC9, 0xD7, 0xD7, 0x62, 0xA8, 0x35, 0xC0, 0x62, 0xBB, 0xEF, 0xD4];
const SN_VARS_BEGIN = [0xCF, 0x7B, 0x1F, 0x23, 0xFD, 0xDE, 0x38, 0xA9, 0x5F, 0x7C, 0x68, 0xB8, 0x4E, 0x6D, 0x33, 0x5F];
const SN_VARS_END = [0x30, 0x84, 0xE0, 0xDC, 0x02, 0x21, 0xC7, 0x56, 0xA0, 0x83, 0x97, 0x47, 0xB1, 0x92, 0xCC, 0xA0];
const SN_CLASS_BEGIN = [0x8D, 0xA1, 0xC4, 0xB8, 0xC4, 0xA9, 0xF8, 0xC5, 0xC0, 0xDC, 0xF4, 0x5F, 0xE7, 0xCF, 0xB6, 0x8A];
const SN_CLASS_END = [0x72, 0x5E, 0x3B, 0x47, 0x3B, 0x56, 0x07, 0x3A, 0x3F, 0x23, 0x0B, 0xA0, 0x18, 0x30, 0x49, 0x75];
const SN_2ND_BEGIN = [0xD4, 0x7B, 0x21, 0xCE, 0x28, 0x93, 0x9F, 0xBF, 0x53, 0x24, 0x40, 0x09, 0x12, 0x3C, 0xAA, 0x01];
const SN_2ND_END = [0x2B, 0x84, 0xDE, 0x31, 0xD7, 0x6C, 0x60, 0x40, 0xAC, 0xDB, 0xBF, 0xF6, 0xED, 0xC3, 0x55, 0xFE];

/* ------------------------------------------------------------------ *
 * R2004 (AC1018) container assembly
 * ------------------------------------------------------------------ */

const PAGE_MAP_TYPE = 0x41630e3b;
const SECTION_MAP_TYPE = 0x4163003b;
const DATA_PAGE_MASK = 0x4164536b;

/** Decode the base64 the reader produced for a binary kernel payload. */
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

/** True when a base64 kernel payload is an ASM-dialect stream ("ASM
 *  BinaryFile" magic) rather than a pre-ASM "ACIS BinaryFile" one. */
const ASM_MAGIC = 'ASM BinaryFile';
const isAsmSab = (b64: string): boolean => {
  const head = fromBase64(b64.slice(0, 24));
  for (let i = 0; i < ASM_MAGIC.length; i++) {
    if (head[i] !== ASM_MAGIC.charCodeAt(i)) return false;
  }
  return true;
};

/** The 16-byte revision id an R2013+ ACIS record carries after its
 *  geometry defaults. AutoCAD mints a fresh random RFC-4122 v4 UUID for
 *  every body it saves; we compute ours from the record's own handle and
 *  payload instead, so the same drawing always writes the same id (tests
 *  stay reproducible) while two bodies never collide. AutoCAD does not
 *  read the value — an all-zero id audits 0/0 too — only the version and
 *  variant nibbles are shaped like its own, for readers that look. */
const revisionId = (handle: number, blob: Uint8Array): Uint8Array => {
  /* FNV-1a over the payload, seeded with the handle */
  let h = (0x811c9dc5 ^ handle) >>> 0;
  for (let i = 0; i < blob.length; i++) {
    h = Math.imul(h ^ blob[i], 0x01000193) >>> 0;
  }
  /* that hash seeds an LCG, whose high bytes fill the id */
  const out = new Uint8Array(16);
  let s = h || 1;
  for (let i = 0; i < 16; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  out[6] = (out[6] & 0x0f) | 0x40;        /* version 4 */
  out[8] = (out[8] & 0x3f) | 0x80;        /* RFC 4122 variant */
  return out;
};

/** Build an R2004 file around the already-encoded logical sections.
 *  Sections are written uncompressed (compression is optional in the
 *  format: the section map declares method 1 = stored). */
export function assemble2004(
  headerVars: Uint8Array, classes: Uint8Array,
  objects: Obj[], handseed: number,
  version: 2004 | 2007 | 2018,
  /** TEMP (header campaign): when given, these full section images replace
   *  everything built above — pure recontainerization for splice tests. */
  rawSections?: { name: string; data: Uint8Array }[],
  /** R2018: an AcDb:AcDsPrototype_1b image (solid-modeling payloads). */
  acds?: Uint8Array
): Uint8Array {
  const out: number[] = [];
  const push = (b: Uint8Array | readonly number[]): void => {
    for (let i = 0; i < b.length; i++) out.push((b as Uint8Array)[i] as number);
  };
  const u32 = (v: number): void => {
    out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const u64 = (v: number): void => { u32(v >>> 0); u32(Math.floor(v / 0x100000000)); };

  /* -- logical section payloads -- */
  const SN_VARS_B = Uint8Array.from(SN_VARS_BEGIN);
  const SN_VARS_E = Uint8Array.from(SN_VARS_END);
  const wrap = (
    begin: Uint8Array, payload: Uint8Array, end: Uint8Array, tailZeros = 0,
    tight = false
  ): Uint8Array => {
    const buf: number[] = [];
    for (const b of begin) buf.push(b);
    const sizeAt = buf.length;
    /* R2018 (R2010-family) trailer, splice-tested against AutoCAD 2027:
       the CRC16 always sits at byte 24 + RL (measured from the section
       start) and spans [16, 24 + RL). For the header AutoCAD writes
       RL = payload length (the 64-bit-size high dword counts, the four
       bytes before the CRC are junk the payload doesn't cover — zeros
       pass). For the Classes section it is strict: RL must equal the bit
       region's byte length exactly (high dword NOT counted, no slack
       before the CRC) or the file is rejected with ErrorStatus=53. */
    const rl = tight && version === 2018 && payload.length >= 4
      ? payload.length - 4 : payload.length;
    buf.push(rl & 0xff, (rl >>> 8) & 0xff, (rl >>> 16) & 0xff, (rl >>> 24) & 0xff);
    for (const b of payload) buf.push(b);
    if (version === 2018 && !(tight && payload.length >= 4)) buf.push(0, 0, 0, 0);
    const crc = crc16(0xC0C1, Uint8Array.from(buf.slice(sizeAt)));
    buf.push(crc & 0xff, (crc >> 8) & 0xff);
    for (const b of end) buf.push(b);
    /* AutoCAD writes (and on open, verifiably requires — splice-tested
       against 2027) eight zero bytes after the Classes end sentinel in
       every R2004-family file. */
    for (let i = 0; i < tailZeros; i++) buf.push(0);
    return Uint8Array.from(buf);
  };

  const headerSec = wrap(SN_VARS_B, headerVars, SN_VARS_E);
  /* AutoCAD requires the Classes section to exist even when no class is
   * registered — a wrapped empty payload decodes as zero classes. */
  const classesSec = wrap(Uint8Array.from(SN_CLASS_BEGIN), classes,
    Uint8Array.from(SN_CLASS_END), 8, true);

  /* objects section + handles map (offsets are section-relative here) */
  const objBytes: number[] = [];
  /* AutoCAD never places an object at offset 0 — its own R2004 and R2018
     files both open the section with the same four bytes (CA 0D 00 00)
     and put the first object at offset 4; offset 0 reads like the runtime
     map's "missing" sentinel. Reproduce the prefix. */
  objBytes.push(0xca, 0x0d, 0x00, 0x00);
  const mapEntries: { handle: number; offset: number }[] = [];
  for (const obj of objects.slice().sort((a, b) => a.handle - b.handle)) {
    const offset = objBytes.length;
    mapEntries.push({ handle: obj.handle, offset });
    let v = obj.bytes.length;
    for (;;) {
      const lo = v % 0x8000;
      v = Math.floor(v / 0x8000);
      const word = v === 0 ? lo : (lo | 0x8000);
      objBytes.push(word & 0xff, (word >> 8) & 0xff);
      if (v === 0) break;
    }
    if (obj.handleBits !== undefined) {
      /* R2010+: UMC bits-of-handle-stream, right after the size prefix */
      let hs = obj.handleBits;
      for (;;) {
        const lo = hs % 128;
        hs = Math.floor(hs / 128);
        if (hs === 0) { objBytes.push(lo); break; }
        objBytes.push(lo | 0x80);
      }
    }
    for (const b of obj.bytes) objBytes.push(b);
    const crc = crc16(0xC0C1, Uint8Array.from(objBytes.slice(offset)));
    objBytes.push(crc & 0xff, (crc >> 8) & 0xff);
  }
  const objectsSec = Uint8Array.from(objBytes);

  const mapBytes: number[] = [];
  {
    let idx = 0;
    while (idx < mapEntries.length) {
      const pageStart = mapBytes.length;
      mapBytes.push(0, 0);
      let lastH = 0, lastOff = 0;
      while (idx < mapEntries.length && mapBytes.length - pageStart < 2000) {
        const en = mapEntries[idx++];
        let dh = en.handle - lastH;
        for (;;) {
          const lo = dh % 128;
          dh = Math.floor(dh / 128);
          if (dh === 0) { mapBytes.push(lo); break; }
          mapBytes.push(lo | 0x80);
        }
        const neg = en.offset < lastOff;
        let m = Math.abs(en.offset - lastOff);
        const parts: number[] = [];
        for (;;) {
          const lo = m & 0x7f;
          m = Math.floor(m / 128);
          parts.push(lo);
          if (m === 0) break;
        }
        if (parts[parts.length - 1] & 0x40) parts.push(0);
        if (neg) parts[parts.length - 1] |= 0x40;
        for (let i = 0; i < parts.length; i++) {
          mapBytes.push(parts[i] | (i < parts.length - 1 ? 0x80 : 0));
        }
        lastH = en.handle;
        lastOff = en.offset;
      }
      const pageSize = mapBytes.length - pageStart;
      mapBytes[pageStart] = (pageSize >> 8) & 0xff;
      mapBytes[pageStart + 1] = pageSize & 0xff;
      const crc = crc16(0xC0C1, Uint8Array.from(mapBytes.slice(pageStart)));
      mapBytes.push((crc >> 8) & 0xff, crc & 0xff);
    }
    const tStart = mapBytes.length;
    mapBytes.push(0, 2);
    const tcrc = crc16(0xC0C1, Uint8Array.from(mapBytes.slice(tStart)));
    mapBytes.push((tcrc >> 8) & 0xff, tcrc & 0xff);
  }
  const handlesSec = Uint8Array.from(mapBytes);

  interface Sec { name: string; data: Uint8Array }
  const sections: Sec[] = [
    { name: 'AcDb:Header', data: headerSec },
    { name: 'AcDb:Handles', data: handlesSec },
    { name: 'AcDb:AcDbObjects', data: objectsSec }
  ];
  if (classesSec.length) {
    sections.splice(1, 0, { name: 'AcDb:Classes', data: classesSec });
  }
  if (acds) sections.push({ name: 'AcDb:AcDsPrototype_1b', data: acds });

  /* ------------------------------------------------------------ *
   * The page container. AutoCAD verifies far more of this than any
   * third-party reader: the encrypted header's CRC32, the Adler-style
   * page checksums, the page-size bookkeeping in the section map, the
   * trailing copy of the file header — and it refuses to open a file
   * that lacks any of the eight classic sections. Everything below was
   * validated field by field against files AutoCAD 2027 writes, by
   * splicing one change at a time into such a file until open + AUDIT
   * stayed at zero errors.
   * ------------------------------------------------------------ */

  /* The four bookkeeping sections AutoCAD insists on seeing alongside
   * header/classes/handles/objects. Their contents mirror what AutoCAD
   * 2027 itself writes, with our own counts and seeds patched in. */
  {
    const aux: number[] = [];
    const auxRS = (v: number): void => { aux.push(v & 0xff, (v >>> 8) & 0xff); };
    const auxRL = (v: number): void => { auxRS(v & 0xffff); auxRS(Math.floor(v / 0x10000)); };
    /* R2018 widened the three maintenance-version fields to 32 bits */
    const maint = (v: number): void => { if (version === 2018) auxRL(v); else auxRS(v); };
    aux.push(0xff, 0x77, 0x01);                 /* intro */
    auxRS(version === 2018 ? 0x21
      : version === 2007 ? 0x1b : 0x19);        /* dwg version */
    maint(0);                                   /* maintenance version */
    auxRL(1);                                   /* number of saves */
    auxRL(0xffffffff);
    auxRS(1); auxRS(0);                         /* save counters */
    auxRL(0);
    auxRS(0x16); maint(0x2e);                   /* constants in real files */
    auxRS(0x16); maint(0x2e);
    auxRS(4); auxRL(0x565);                     /* more fixed bookkeeping */
    auxRL(0); auxRL(1);
    for (let i = 0; i < 11; i++) aux.push(0);
    aux.push(1, 1, 1);                          /* three RC flags */
    auxRS(0x17); auxRS(1);
    auxRL(2461269); auxRL(36254536);            /* TDCREATE (julian, ms) */
    auxRL(2461269); auxRL(36254536);            /* TDUPDATE */
    auxRL(handseed); auxRL(0);                  /* HANDSEED */
    auxRS(0); auxRS(0x35);
    for (let i = 0; i < 3; i++) auxRL(0);
    auxRL(1);                                   /* saves again */
    for (let i = 0; i < 4; i++) auxRL(0);

    const ofs: number[] = [];
    const ofsRL = (v: number): void => {
      ofs.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    };
    const ofsRLL = (v: number): void => { ofsRL(v >>> 0); ofsRL(Math.floor(v / 0x100000000)); };
    ofsRLL(0);
    ofsRLL(objects.length);                     /* approximate object count */
    ofsRL(2461269); ofsRL(36254536);            /* TDUPDATE */
    ofs.push(4);                                /* four threshold records */
    for (const v of [0x32, 0x64, 0x200, 0xffffffff]) { ofsRLL(v); ofsRLL(0); }

    sections.push(
      { name: 'AcDb:AuxHeader', data: Uint8Array.from(aux) },
      /* Template: empty description + MEASUREMENT (metric) */
      { name: 'AcDb:Template', data: Uint8Array.from([0, 0, 1, 0]) },
      { name: 'AcDb:ObjFreeSpace', data: Uint8Array.from(ofs) },
      /* RevHistory: three zero revision counters, format flag 1 */
      { name: 'AcDb:RevHistory', data: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }
    );
  }

  if (rawSections) { sections.length = 0; sections.push(...rawSections); }

  /* R2007 wraps the same eight classic sections in its own Reed-Solomon
     envelope (moved below the bookkeeping four: AutoCAD requires them in
     every container family) */
  if (version === 2007) return assemble2007(sections);

  /* Every section's number is a fixed role id — AutoCAD looks sections
   * up by id, not by name, and rejects the drawing when a role between
   * 1 and 8 is missing. The same ids appear in each data page header. */
  const SECID: Record<string, number> = {
    'AcDb:Header': 1, 'AcDb:AuxHeader': 2, 'AcDb:Classes': 3,
    'AcDb:Handles': 4, 'AcDb:Template': 5, 'AcDb:ObjFreeSpace': 6,
    'AcDb:AcDbObjects': 7, 'AcDb:RevHistory': 8,
    'AcDb:AcDsPrototype_1b': 9
  };

  /* Data sections are cut into pages holding this many decompressed
   * bytes each. Every page inflates to the full page size: the last
   * slice is zero-padded before compression, because AutoCAD's reader
   * decompresses whole pages and treats a short stream as corruption. */
  const PAGE_CAP = 0x7400;

  /* Stream order (what sits where in the file) mirrors real files:
   * objects first, header last, then the two system pages. The section
   * map lists them in the same order, ids descending to 1. */
  const streamOrder = ['AcDb:AcDsPrototype_1b', 'AcDb:RevHistory',
    'AcDb:AcDbObjects',
    'AcDb:ObjFreeSpace', 'AcDb:Template', 'AcDb:Handles', 'AcDb:Classes',
    'AcDb:AuxHeader', 'AcDb:Header'];
  const ordered = streamOrder
    .map((nm) => sections.find((s) => s.name === nm))
    .filter((s): s is Sec => s !== undefined && s.data.length > 0);
  const secIdOf = (secIdx: number): number => SECID[ordered[secIdx].name] ?? 0;

  /* The rolling Adler-flavored checksum every page carries (OpenDesign
   * "section page checksum"): two mod-0xFFF1 sums folded every 0x15B0
   * bytes, seeded rather than started at 1 like real Adler-32. */
  const pageChecksum = (seed: number, bytes: Uint8Array): number => {
    let sum1 = seed & 0xffff;
    let sum2 = Math.floor(seed / 0x10000) & 0xffff;
    let at = 0;
    while (at < bytes.length) {
      const stop = Math.min(at + 0x15b0, bytes.length);
      for (; at < stop; at++) { sum1 += bytes[at]; sum2 += sum1; }
      sum1 %= 0xfff1;
      sum2 %= 0xfff1;
    }
    return (sum2 * 0x10000 + sum1) >>> 0;
  };

  /* CRC32 (standard reflected polynomial) for the encrypted header. */
  const CRC32_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC32_TABLE[n] = c >>> 0;
  }
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };

  /* Pages sit on 32-byte boundaries; the page map records the padded
   * slot, the section map the exact payload. */
  const align32 = (v: number): number => (v + 31) & ~31;

  /* -- plan the layout -- */
  interface PagePlan {
    number: number; address: number; diskSize: number;
    payload: Uint8Array;                        /* compressed slice */
    secIdx: number; chunk: number;              /* which slice of which section */
  }
  const dataPages: PagePlan[] = [];
  let cursor = 0x100;
  let nextPage = 1;
  ordered.forEach((sec, secIdx) => {
    const pageCount = Math.max(1, Math.ceil(sec.data.length / PAGE_CAP));
    for (let k = 0; k < pageCount; k++) {
      /* the whole window, zero-padded: AutoCAD inflates full pages */
      const window = new Uint8Array(PAGE_CAP);
      window.set(sec.data.subarray(k * PAGE_CAP,
        Math.min((k + 1) * PAGE_CAP, sec.data.length)));
      const payload = compressR2004(window);
      const diskSize = align32(32 + payload.length);
      dataPages.push({
        number: nextPage++, address: cursor, diskSize, payload, secIdx, chunk: k
      });
      cursor += diskSize;
    }
  });
  const dataPageCount = dataPages.length;
  /* The header's section-page count includes the two system pages, and
   * their page numbers sit ABOVE that count — real files leave a gap of
   * two unused numbers between the data pages and the system pages. */
  const numSections = dataPageCount + 2;
  const infoPageId = numSections + 1;
  const mapPageId = numSections + 2;

  /* -- outer file header (0x00-0x7F) -- */
  push(version === 2018
    ? [0x41, 0x43, 0x31, 0x30, 0x33, 0x32]        /* AC1032 */
    : [0x41, 0x43, 0x31, 0x30, 0x31, 0x38]);      /* AC1018 */
  push([0, 0, 0, 0, 0]);                        /* 0x06 five zero bytes */
  out.push(0x00);                               /* 0x0B maintenance version */
  out.push(0x03);                               /* 0x0C one of 0/1/3 */
  u32(0);                                       /* 0x0D preview address (none) */
  const dwgVer = version === 2018 ? 0x21 : 0x19; /* release byte: 2004=0x19 */
  out.push(dwgVer);                             /* 0x11 dwg version */
  out.push(0x00);                               /* 0x12 maintenance */
  out.push(30); out.push(0);                    /* 0x13 codepage (ANSI_1252) */
  out.push(0x00);                               /* 0x15 unknown */
  out.push(dwgVer);                             /* 0x16 app dwg version */
  out.push(0x00);                               /* 0x17 app maintenance */
  u32(0);                                       /* 0x18 security flags */
  u32(0);                                       /* 0x1C unknown */
  u32(0);                                       /* 0x20 summary info address */
  u32(0);                                       /* 0x24 VBA project address */
  u32(0x80);                                    /* 0x28 file header address */
  while (out.length < 0x80) out.push(0);
  const encHeaderAt = out.length;
  for (let i = 0; i < 0x6c; i++) out.push(0);   /* encrypted header (later) */
  /* The 20 bytes between the encrypted header and 0x100 are the same in
   * every file AutoCAD writes, because they are that keystream running
   * on over a zero plaintext — and the stream is indexed by the file
   * offset itself, so the run at 0xEC..0xFF is draws 236..255 of the
   * same MSVC LCG the header pad uses. Generated here rather than
   * transcribed: nothing in this repository is copied out of a file
   * another program produced. */
  {
    let pad = 1;
    for (let i = 0; i < 0x100; i++) {
      pad = (Math.imul(pad, 0x343fd) + 0x269ec3) >>> 0;
      if (i >= 0xEC) out.push((pad >>> 16) & 0xff);
    }
  }

  /* -- data pages: 32-byte masked header + compressed payload -- */
  for (const p of dataPages) {
    const dataCrc = pageChecksum(0, p.payload);
    /* Header fields: type, positional section id, payload size, padded
     * on-disk page size, 64-bit start offset within the decompressed
     * section, header checksum, data checksum. The header checksum is
     * seeded with the data checksum and taken over the header with its
     * own slot zeroed. Everything is then XORed with the address mask. */
    const hdr = new Uint8Array(32);
    const hv = new DataView(hdr.buffer);
    hv.setUint32(0, 0x4163043b, true);          /* data page type */
    hv.setUint32(4, secIdOf(p.secIdx), true);   /* section id */
    hv.setUint32(8, p.payload.length, true);    /* compressed size */
    hv.setUint32(12, p.diskSize, true);         /* on-disk page size */
    hv.setUint32(16, p.chunk * PAGE_CAP, true); /* start offset (64-bit) */
    hv.setUint32(20, 0, true);
    hv.setUint32(28, dataCrc, true);
    hv.setUint32(24, pageChecksum(dataCrc, hdr), true);
    const mask = (DATA_PAGE_MASK ^ p.address) >>> 0;
    for (let i = 0; i < 32; i += 4) {
      hv.setUint32(i, (hv.getUint32(i, true) ^ mask) >>> 0, true);
    }
    if (out.length !== p.address) {
      throw new Error(`layout drifted: page at ${out.length}, planned ${p.address}`);
    }
    push(hdr);
    push(p.payload);
    while (out.length < p.address + p.diskSize) out.push(0);
  }

  /* -- section map (system page): descriptors + page lists. Real files
   * open with one anonymous zero-size descriptor (id 0), then list the
   * named sections with ids counting down to 1; the two system pages
   * are not described here. -- */
  const numDesc = ordered.length + 1;
  const smBody: number[] = [];
  const smU32 = (v: number): void => {
    smBody.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const smU64 = (v: number): void => { smU32(v >>> 0); smU32(Math.floor(v / 0x100000000)); };
  smU32(numDesc);                               /* descriptor count */
  smU32(0x02);                                  /* compressed flag (header) */
  smU32(PAGE_CAP);                              /* max page size */
  smU32(0x00);                                  /* encrypted */
  smU32(numDesc);                               /* descriptor count again */
  const descFor = (
    name: string, size: number, typeId: number,
    pages: { number: number; size: number; offset: number }[]
  ): void => {
    smU64(size);                                /* logical section size */
    smU32(pages.length);                        /* page count */
    smU32(PAGE_CAP);                            /* max decompressed page size */
    smU32(1);                                   /* unknown, always 1 */
    smU32(2);                                   /* compression: 2 = LZ77 */
    smU32(typeId);                              /* positional section id */
    smU32(0);                                   /* not encrypted */
    const nameBytes = new Uint8Array(64);
    for (let k = 0; k < name.length && k < 63; k++) {
      nameBytes[k] = name.charCodeAt(k);
    }
    for (const b of nameBytes) smBody.push(b);
    for (const pg of pages) {                   /* number, payload size, offset */
      smU32(pg.number);
      smU32(pg.size);
      smU64(pg.offset);
    }
  };
  descFor('', 0, 0, []);                        /* the empty section */
  ordered.forEach((sec, secIdx) => {
    descFor(sec.name, sec.data.length, secIdOf(secIdx),
      dataPages.filter((p) => p.secIdx === secIdx).map((p) => ({
        number: p.number, size: p.payload.length, offset: p.chunk * PAGE_CAP
      })));
  });

  /* system page = 20-byte header + LZ-packed body; its checksum is
   * seeded from the header (checksum slot zero) then run over the body */
  const systemPage = (type: number, body: Uint8Array): number => {
    const packed = compressR2004(body);
    const hdr = new Uint8Array(20);
    const hv = new DataView(hdr.buffer);
    hv.setUint32(0, type, true);
    hv.setUint32(4, body.length, true);         /* decompressed size */
    hv.setUint32(8, packed.length, true);       /* compressed size */
    hv.setUint32(12, 2, true);                  /* compression method */
    const cs1 = pageChecksum(0, hdr);
    hv.setUint32(16, pageChecksum(cs1, packed), true);
    push(hdr);
    push(packed);
    return 20 + packed.length;
  };
  const infoAddr = out.length;
  const infoActual = systemPage(SECTION_MAP_TYPE, Uint8Array.from(smBody));
  const infoDisk = align32(infoActual);
  while (out.length < infoAddr + infoDisk) out.push(0);

  /* -- page map (system page): (number, padded size) pairs in stream
   * order, the two system pages included. Its own slot is declared with
   * generous slack — real files do the same so the map can be rewritten
   * in place — which resolves the self-reference: the slot only has to
   * be at least as large as whatever the compressor produces. -- */
  const mapAddr = infoAddr + infoDisk;
  const mapLen = (dataPageCount + 2) * 8;
  /* upper bound on the packed size (a stored stream never does worse),
   * plus room for the trailing second header inside the slot */
  const mapSlot = align32(20 + mapLen + Math.ceil(mapLen / 0xff) + 2 + 160);
  const pmBody: number[] = [];
  const pmU32 = (v: number): void => {
    pmBody.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  for (const p of dataPages) { pmU32(p.number); pmU32(p.diskSize); }
  pmU32(infoPageId); pmU32(infoDisk);
  pmU32(mapPageId); pmU32(mapSlot);
  const mapActual = systemPage(PAGE_MAP_TYPE, Uint8Array.from(pmBody));
  if (mapActual + 20 + 0x6c > mapSlot) {
    throw new Error(`page map outgrew its declared slot: ${mapActual} > ${mapSlot}`);
  }
  const secondHeaderAt = mapAddr + mapActual + 20;

  /* -- encrypted file header at 0x80 -- */
  {
    /* 0x6C bytes of bookkeeping XORed with the MS CRT rand() keystream;
     * CRC32 is over the plaintext with its own field zeroed. */
    const dec = new Uint8Array(0x6c);
    const dvv = new DataView(dec.buffer);
    const id = 'AcFssFcAJMB';
    for (let i = 0; i < id.length; i++) dec[i] = id.charCodeAt(i);
    dvv.setUint32(0x10, 0x6c, true);            /* header size */
    dvv.setUint32(0x14, 0x04, true);
    /* 0x18/0x1C/0x20: gap tree bookkeeping, all zero (no gaps) */
    dvv.setUint32(0x24, 1, true);               /* unknown, always 1 */
    dvv.setUint32(0x28, mapPageId, true);       /* last section page id */
    const setU64 = (at: number, v: number): void => {
      dvv.setUint32(at, v >>> 0, true);
      dvv.setUint32(at + 4, Math.floor(v / 0x100000000), true);
    };
    setU64(0x2c, mapAddr + mapSlot - 0x100);    /* last section page end */
    setU64(0x34, secondHeaderAt);               /* second header address */
    dvv.setUint32(0x3c, 0, true);               /* gap amount */
    dvv.setUint32(0x40, numSections, true);     /* section page amount */
    dvv.setUint32(0x44, 0x20, true);
    dvv.setUint32(0x48, 0x80, true);
    dvv.setUint32(0x4c, 0x40, true);
    dvv.setUint32(0x50, mapPageId, true);       /* section page map id */
    setU64(0x54, mapAddr - 0x100);              /* section page map address */
    dvv.setUint32(0x5c, infoPageId, true);      /* section map id */
    dvv.setUint32(0x60, mapPageId, true);       /* section page array size */
    dvv.setUint32(0x64, 0, true);               /* gap array size */
    dvv.setUint32(0x68, crc32(dec), true);
    let x = 1;
    for (let i = 0; i < dec.length; i++) {
      x = (Math.imul(x, 0x343fd) + 0x269ec3) >>> 0;
      out[encHeaderAt + i] = dec[i] ^ ((x >>> 16) & 0xff);
    }
  }

  /* -- trailing second header: a bare page-map header + a byte-for-byte
   * copy of the encrypted file header, nested in the page map's slack.
   * AutoCAD ends every file this way and recovery goes looking for it. */
  {
    const tail = new Uint8Array(20);
    new DataView(tail.buffer).setUint32(0, PAGE_MAP_TYPE, true);
    tail[12] = 0x02;                            /* compression method slot */
    push(tail);
    for (let i = 0; i < 0x6c; i++) out.push(out[encHeaderAt + i]);
  }
  void handseed;
  return Uint8Array.from(out);
}

/** Millimeters -> DWG lineweight code (29 = ByLayer). */
const LW_MM = [
  0.00, 0.05, 0.09, 0.13, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50,
  0.53, 0.60, 0.70, 0.80, 0.90, 1.00, 1.06, 1.20, 1.40, 1.58, 2.00, 2.11
];
const lwCode = (mm?: number): number => {
  if (mm === undefined) return 29;
  let best = 0, bd = Infinity;
  for (let i = 0; i < LW_MM.length; i++) {
    const d = Math.abs(LW_MM[i] - mm);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

/** Entity color -> R2000 CMC index (BS). */
const colorIndex = (e: Entity): number =>
  e.color.kind === 'byBlock' ? 0
  : e.color.kind === 'aci' ? (e.color.index & 0xff)
  : e.color.kind === 'rgb' ? 7 : 256;

/** Writer-side text: shape Arabic so any reader draws it joined. */
const outText = (s: string): string => {
  let v = encodeCadSymbols(s).replace(/\r\n?/g, '\n');
  if (hasComplexScript(v)) v = shapeArabic(mirrorBrackets(v, false));
  /* T strings are codepage bytes; anything above latin-1 goes as \U+ */
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    out += c > 0xFF
      ? '\\U+' + c.toString(16).toUpperCase().padStart(4, '0')
      : v[i];
  }
  return out;
};

export interface Obj {
  handle: number;
  bytes: Uint8Array;
  /** R2010+: bits of handle stream at the tail (written in the prefix). */
  handleBits?: number;
}

export interface DwgWriteResult {
  data: Uint8Array;
  /** Entities that could not be encoded (kept out of the file). */
  skipped: string[];
  /** Entities written as simpler geometry rather than their own record,
   *  so the drawing still shows them. */
  downgraded: string[];
}

export interface DwgWriteOptions {
  /** Keep the source file's handles: every entity and retained object
   *  that carries a `handle` is written under that number, and fresh
   *  structural handles are allocated above the highest one. Sealed
   *  records reference each other by handle; with the numbering stable,
   *  those references stay valid across any number of rewrites without
   *  the library understanding them.
   *
   *  From this release the same promise covers the symbol tables: a
   *  layer, linetype, text style or block header that carries a `handle`
   *  is written under it too, so a record that names a layer by handle
   *  still finds the same layer after the rewrite. */
  preserveHandles?: boolean;

  /** Byte-preserving rewrite. Off by default: `preserveHandles` alone
   *  keeps the classic behaviour of re-encoding every entity from the
   *  model.
   *
   *  When on (and only together with `preserveHandles` — on its own this
   *  option is a documented no-op, because retained bytes name their
   *  layers, styles and blocks by handle and are meaningless under a
   *  renumbering), an entity that still carries the `record` the reader
   *  sealed for it — `readDwg(bytes, { retainRecords: true })` — is
   *  emitted from those exact bytes instead of being re-encoded. The
   *  object map, the size prefix, the R2010+ handle-stream split, the
   *  per-object CRC, the sections and the container are built exactly as
   *  they always are: only the record body is substituted. An untouched
   *  entity therefore survives a read/write cycle byte for byte.
   *
   *  THE CONTRACT — read this before switching it on:
   *
   *  1. `record` means "these bytes still describe this entity". The
   *     writer TRUSTS it and does not diff the bytes against the model:
   *     a caller that changes an entity (geometry, layer, colour,
   *     linetype, its handle, the space it lives in) MUST
   *     `delete entity.record` so the writer re-encodes it. Nothing else
   *     is needed — the writer picks the change up from the model.
   *  2. Verbatim emission only happens when the retained bytes are of the
   *     target's own encoding generation (`record.encoding` equals
   *     `encodingGroup(version)`: 14, 2000, 2004, 2007 or 2018). Writing
   *     an R2018 record into an R2000 file would be writing foreign
   *     bytes, so those entities are re-encoded instead — the option is
   *     always safe to leave on across releases.
   *  3. The bytes name layers, linetypes, styles and blocks by their
   *     SOURCE handles, so verbatim emission is switched off wholesale
   *     for the drawing unless every symbol-table handle was preserved
   *     (missing or colliding, and it falls back to re-encoding).
   *  4. Entities whose records reach past the symbol tables into objects
   *     this library re-creates rather than preserves — dimension and
   *     leader (DIMSTYLE), mline (MLINESTYLE), image (IMAGEDEF), the
   *     class-numbered records (table, mleader, light, underlay, proxy,
   *     sealed unknowns), the ones with owned sub-entities (INSERT with
   *     attributes, the meshes) and ACIS solids (whose payload the writer
   *     re-builds into the R2018 AcDs section) — are always re-encoded;
   *     so is any entity carrying XDATA, which names its APPID by handle.
   *     Those entities still round-trip exactly as they do without this
   *     option.
   *  5. Pre-R2004 records carry the previous/next sibling handles inside
   *     the record, so there verbatim emission additionally requires that
   *     every entity in the drawing kept its own handle. */
  verbatimRecords?: boolean;
}

export const writeDwg2000 = (
  drawing: Drawing, opts?: DwgWriteOptions
): DwgWriteResult => writeDwgImpl(drawing, 2000, opts);

/** R2004 (AC1018) page container flavor of the same writer. */
export const writeDwg2004 = (
  drawing: Drawing, opts?: DwgWriteOptions
): DwgWriteResult => writeDwgImpl(drawing, 2004, opts);

/** R2018 (AC1032) — same page container, R2010+ object type/handle-size
 *  encoding. R2010 and R2013 share the layout. */
export const writeDwg2018 = (
  drawing: Drawing, opts?: DwgWriteOptions
): DwgWriteResult => writeDwgImpl(drawing, 2018, opts);

/** R2007 (AC1021) — the Reed-Solomon page container, with the string
 *  stream R2007 introduced. */
export const writeDwg2007 = (
  drawing: Drawing, opts?: DwgWriteOptions
): DwgWriteResult => writeDwgImpl(drawing, 2007, opts);

/** R13 (AC1012). The oldest release with the bit-packed object format:
 *  same flat section table as R2000, but each record carries its own
 *  handle-stream position mid-body, entity colour is a plain index, and
 *  there is no lineweight or plot style yet. */
export const writeDwgR13 = (
  drawing: Drawing, opts?: DwgWriteOptions
): DwgWriteResult => writeDwgImpl(drawing, 13, opts);

/** R14 (AC1014) — R13's layout under a later signature. */
export const writeDwgR14 = (
  drawing: Drawing, opts?: DwgWriteOptions
): DwgWriteResult => writeDwgImpl(drawing, 14, opts);

const writeDwgImpl = (
  drawing: Drawing, V: 13 | 14 | 2000 | 2004 | 2007 | 2018,
  opts: DwgWriteOptions = {}
): DwgWriteResult => {
  const skipped: string[] = [];

  /* ---------------- handle allocation ---------------- */
  const preserve = opts.preserveHandles === true;
  /* Byte-preserving rewrite. Without preserveHandles the retained bytes
     would name their layers and blocks by numbers this file no longer
     uses, so the option is a documented no-op on its own. */
  const verbatim = preserve && opts.verbatimRecords === true;
  let maxSrc = 0;
  if (preserve) {
    const scanH = (h?: string): void => {
      const v = h ? parseInt(h, 16) : NaN;
      if (Number.isFinite(v) && v > 0) maxSrc = Math.max(maxSrc, v);
    };
    for (const e of drawing.entities) scanH(e.handle);
    for (const e of drawing.paperSpace ?? []) scanH(e.handle);
    for (const b of Object.values(drawing.blocks)) {
      for (const e of b.entities) scanH(e.handle);
    }
    for (const p of drawing.proxyObjects ?? []) scanH(p.handle);
    for (const p of drawing.unknownObjects ?? []) scanH(p.handle);
    /* the symbol tables are preserved too, so their numbers have to sit
       under the fresh-handle watermark like everything else — a table
       record numbered above it would collide with a structural handle */
    for (const ly of drawing.layers) scanH(ly.handle);
    for (const lt of drawing.linetypes) scanH(lt.handle);
    for (const st of drawing.textStyles) scanH(st.handle);
    for (const b of Object.values(drawing.blocks)) scanH(b.handle);
  }
  let nextHandle = maxSrc;
  const H = (): number => ++nextHandle;
  const usedH = new Set<number>();
  /** The entity's own handle when preserving and it is free, else fresh. */
  const keepH = (h?: string): number => {
    if (preserve && h) {
      const v = parseInt(h, 16);
      if (Number.isFinite(v) && v > 0 && !usedH.has(v)) {
        usedH.add(v);
        return v;
      }
    }
    return H();
  };
  /** True while every symbol-table record kept its source handle. A
   *  retained entity record names its layer, linetype, style and owning
   *  block by those numbers, so one renumbered table poisons every
   *  verbatim record in the drawing — the flag turns them all off. */
  let tablesKept = true;
  /** keepH for a table record: the same rule, with the bookkeeping. */
  const tableH = (h?: string): number => {
    const v = keepH(h);
    if (!h || parseInt(h, 16) !== v) tablesKept = false;
    return v;
  };
  /** True while every entity kept its source handle: pre-R2004 records
   *  spell the sibling chain out inside the record, and a fresh handle
   *  anywhere in a space breaks the chain its neighbours remember. */
  let chainKept = true;
  const blockControl = H(), layerControl = H(), styleControl = H(),
    ltypeControl = H(), viewControl = H(), ucsControl = H(),
    vportControl = H(), appidControl = H(), dimstyleControl = H(),
    vxControl = H();
  const nod = H(), groupDict = H(), mlineDict = H();
  const appidAcad = H();
  /* ByLayer/ByBlock are synthesized rather than listed among the user
     linetypes, but a drawing that came from a file knows their numbers:
     keeping them keeps the references to them (header CELTYPE, the
     MLINESTYLE elements) pointing where the source pointed. */
  const srcLtH = (re: RegExp): string | undefined =>
    drawing.linetypes.find((lt) => re.test(lt.name))?.handle;
  const ltBylayer = keepH(srcLtH(/^bylayer$/i));
  const ltByblock = keepH(srcLtH(/^byblock$/i));
  /* Layouts arrived with R2000, and AutoCAD refuses to open a 2000+
   * drawing without the Model/paper LAYOUT objects behind the tabs. */
  const layoutDict = H(), layoutModelH = H(), layoutPaperH = H();
  const vportActive = H();

  const layers: Layer[] = drawing.layers.length ? drawing.layers : [{
    name: '0', color: { kind: 'aci', index: 7 } as const,
    on: true, frozen: false, locked: false
  }];
  const layerH = new Map<string, number>();
  for (const ly of layers) layerH.set(ly.name, tableH(ly.handle));

  const styles: TextStyle[] = drawing.textStyles.length
    ? drawing.textStyles : [{ name: 'Standard' }];
  const styleH = new Map<string, number>();
  for (const st of styles) styleH.set(st.name, tableH(st.handle));

  const userLtypes: Linetype[] = drawing.linetypes
    .filter((lt) => !/^(bylayer|byblock)$/i.test(lt.name));
  if (!userLtypes.some((lt) => /^continuous$/i.test(lt.name))) {
    userLtypes.unshift({ name: 'Continuous', description: 'Solid line', pattern: [] });
  }
  const ltypeH = new Map<string, number>();
  for (const lt of userLtypes) ltypeH.set(lt.name, tableH(lt.handle));
  const ltContinuous = [...ltypeH.entries()]
    .find(([n]) => /^continuous$/i.test(n))![1];

  /* Dimension styles: real AutoCAD files of every release carry at least
     the "Standard" record, and R13/R14 refuse to open without it — the
     empty DIMSTYLE table this writer used to emit was one of the pinned
     R14 poisons. The source drawing's styles are written faithfully and a
     Standard record is synthesized when absent. */
  const dimStyles: DimStyle[] = [];
  for (const ds of drawing.dimStyles ?? []) {
    if (!dimStyles.some((x) => x.name.toLowerCase() === ds.name.toLowerCase())) {
      dimStyles.push(ds);
    }
  }
  if (!dimStyles.some((ds) => /^standard$/i.test(ds.name))) {
    dimStyles.unshift({ name: 'Standard' });
  }
  const dimStyleH = new Map<string, number>();      /* lower-cased name */
  for (const ds of dimStyles) dimStyleH.set(ds.name.toLowerCase(), H());
  const dimStandardH = dimStyleH.get('standard')!;
  const dimStyleRef = (name?: string): number =>
    (name && dimStyleH.get(name.toLowerCase())) || dimStandardH;
  /* Every release gets the MLINESTYLE "STANDARD" object under an
     ACAD_MLINESTYLE dictionary entry: R13/R14 refuse to open without it,
     and R2000+ audits flag any MLINE whose style handle is NULL, so the
     record exists everywhere and MLINE + header CMLSTYLE point at it. */
  const mlineStandardH = H();

  /* block headers: model, paper, then user blocks */
  const msBH = H(), psBH = H();
  const userBlocks = Object.keys(drawing.blocks)
    .filter((nm) => !/^\*(model_space|paper_space)/i.test(nm) && !drawing.blocks[nm].isLayout);
  const blockH = new Map<string, number>();
  for (const nm of userBlocks) blockH.set(nm, tableH(drawing.blocks[nm].handle));

  /* entity lists per owner space */
  const SUPPORTED = new Set([
    'line', 'point', 'circle', 'arc', 'ellipse', 'polyline', 'text', 'mtext',
    'insert', 'spline', 'solid', 'ray', 'xline', 'face3d',
    'dimension', 'hatch', 'mline', 'tolerance', 'shape', 'leader',
    'viewport', 'mesh', 'image', 'acis', 'light', 'table', 'mleader',
    'underlay', 'proxy', 'ole'
  ]);
  /** Entities that exist only as application classes. */
  const CLASS_ONLY = new Set(['table', 'mleader', 'light', 'underlay']);

  const downgraded: string[] = [];
  /** R2018: the AcDs section carrying the first solid's SAB payload. */
  let acdsSection: Uint8Array | undefined;
  const filterEnts = (list: Entity[]): Entity[] =>
    list.filter((e) => {
      if (e.type === 'acis') {
        if (e.kind === 'surface') {
          skipped.push('acis(surface)');  /* needs its own class record */
          return false;
        }
        /* A binary kernel payload travels inline only where the
           container's kernel speaks its dialect: the pre-ASM
           "ACIS BinaryFile" form from R2007 on, the ASM form only from
           R2013. AutoCAD 2027 refuses an ASM stream inside an AC1021
           file (externally proven — the same drawing carrying a genuine
           ACIS-dialect blob opens at AUDIT 0), so an ASM payload leaves
           an R2007 target through its SAT text conversion, and is
           reported when it has no faithful text form: its asmheader
           record and kernel version postdate those containers. */
        const asm = !!e.sab && isAsmSab(e.sab);
        const sabTravels = !!e.sab && (asm ? V >= 2013 : V >= 2007);
        if (!e.sat && !sabTravels
          && !(e.sab && !asm && sabToSat(e.sab) !== null)) {
          skipped.push('acis(sab)');
          return false;
        }
      }

      /* ACAD_TABLE, MULTILEADER, LIGHT and the underlays are application
         classes, and a class needs a CLASSES record to be nameable. R13
         and R14 have no such record, so they cannot carry them at all. */
      if (V <= 14 && CLASS_ONLY.has(e.type)) {
        skipped.push(e.type + ' (needs R2000 or later)');
        return false;
      }
      /* OLE2FRAME arrived with R14; R13 has only the old OLEFRAME shape */
      if (V === 13 && e.type === 'ole') {
        skipped.push('ole (needs R14 or later)');
        return false;
      }
      /* Sealed unknowns pass through; a bare unknown (no retained bits,
         e.g. one that arrived through DXF) still has nothing to write. */
      if (e.type === 'unknown') {
        if (e.data || e.graphicsData) return true;
        skipped.push(e.sourceType);
        return false;
      }
      if (SUPPORTED.has(e.type)) return true;
      skipped.push(e.type);
      return false;
    });
  const modelEnts = filterEnts(drawing.entities);
  const paperEnts = filterEnts(drawing.paperSpace ?? []);
  const blockEnts = new Map<string, Entity[]>();
  for (const nm of userBlocks) {
    blockEnts.set(nm, filterEnts(drawing.blocks[nm].entities));
  }

  /* per-space entity handle lists + BLOCK/ENDBLK entities */
  const entH = new Map<Entity, number>();
  const allocEnts = (list: Entity[]): number[] => list.map((e) => {
    const h = keepH(e.handle);
    if (!e.handle || parseInt(e.handle, 16) !== h) chainKept = false;
    entH.set(e, h);
    return h;
  });
  const msEntH = allocEnts(modelEnts);
  const psEntH = allocEnts(paperEnts);
  const blockEntH = new Map<string, number[]>();
  for (const nm of userBlocks) blockEntH.set(nm, allocEnts(blockEnts.get(nm)!));
  const msBlockEnt = H(), msEndblk = H();
  const psBlockEnt = H(), psEndblk = H();
  const blockBeginH = new Map<string, number>();
  const blockEndH = new Map<string, number>();
  for (const nm of userBlocks) {
    blockBeginH.set(nm, H());
    blockEndH.set(nm, H());
  }
  const allEnts = [
    ...modelEntsAll(), ...paperEntsAll(),
    ...Object.values(drawing.blocks).flatMap((b) => b.entities)
  ];
  const usesImages = allEnts.some((e) => e.type === 'image');
  const usesLights = allEnts.some((e) => e.type === 'light');
  const usesTables = allEnts.some((e) => e.type === 'table');
  const usesMLeaders = allEnts.some((e) => e.type === 'mleader');
  const imageDefH = new Map<string, number>();
  /* CLASSES numbering: AutoCAD binds class records positionally — they
     must run densely from 500 in file order, or every object typed with
     one of the later numbers fails to resolve (externally proven: a file
     whose only class record was numbered 504 is refused with
     ErrorStatus=53, while the identical record numbered 500 opens).
     Numbers are therefore handed out in emission order, and only to the
     classes this drawing actually carries. */
  let clsNext = 500;
  const CLS_IMAGE = usesImages ? clsNext++ : 0;
  const CLS_IMAGEDEF = usesImages ? clsNext++ : 0;
  const CLS_WIPEOUT = usesImages ? clsNext++ : 0;
  const CLS_LIGHT = usesLights ? clsNext++ : 0;
  const CLS_TABLE = usesTables ? clsNext++ : 0;
  const CLS_MLEADER = usesMLeaders ? clsNext++ : 0;
  /* every MULTILEADER needs a style to resolve; the class pair travels
     together, and the "Standard" object below is synthesized with it */
  const CLS_MLEADERSTYLE = usesMLeaders ? clsNext++ : 0;
  const mleaderDictH = usesMLeaders ? H() : 0;
  const mleaderStyleH = usesMLeaders ? H() : 0;
  /* PDF/DGN/DWF underlays: a class pair and a shared definition per kind */
  const underlayKinds = [...new Set(allEnts
    .filter((e): e is Entity & { type: 'underlay' } => e.type === 'underlay')
    .map((e) => e.underlayKind))].sort();
  const underlayCls = new Map<string, { ent: number; def: number }>();
  underlayKinds.forEach((kind) => {
    underlayCls.set(kind, { ent: clsNext++, def: clsNext++ });
  });
  /* geographic placement: one object, listed in the root dictionary */
  const geoData = drawing.geoData;
  const CLS_GEODATA = geoData ? clsNext++ : 0;
  const geoDataH = geoData ? H() : 0;
  /* proxy passthrough: each distinct application class behind a proxy gets
     its own CLASSES record, and the proxy record's class id points at it —
     that is how a reader learns what the opaque object was. R13/R14 have
     no CLASSES section but predate the class-id indirection too: their
     zombie records carry the id verbatim, so passthrough still works. */
  const proxyClsH = new Map<string, {
    num: number; cpp: string; app: string; ent: boolean;
  }>();
  const addProxyCls = (
    appClass: { dxfName: string; cppName: string; appName: string } | undefined,
    sourceType: string | undefined, fallback: string, ent: boolean
  ): void => {
    const key = appClass?.dxfName ?? sourceType ?? fallback;
    if (!proxyClsH.has(key)) {
      proxyClsH.set(key, {
        num: clsNext++,
        cpp: appClass?.cppName ?? key,
        app: appClass?.appName ?? 'ObjectDBX Classes',
        ent
      });
    }
  };
  for (const e of allEnts) {
    if (e.type === 'proxy') {
      addProxyCls(e.appClass, e.sourceType, 'ACAD_PROXY_ENTITY', true);
    }
    /* sealed unknowns that are class records need their class re-emitted;
       fixed-type ones (typeCode) go out under their original number */
    if (e.type === 'unknown' && (e.data || e.graphicsData)
        && e.typeCode === undefined) {
      addProxyCls(e.appClass, e.sourceType, 'ACAD_PROXY_ENTITY', true);
    }
  }
  /* dictionary-owned proxy objects ride along under the NOD */
  const proxyObjs = drawing.proxyObjects ?? [];
  for (const p of proxyObjs) {
    addProxyCls(p.appClass, p.sourceType, 'ACAD_PROXY_OBJECT', false);
  }
  const proxyObjH = proxyObjs.map((p) => keepH(p.handle));
  /* sealed unknown objects: same discipline, same dictionary anchor */
  const unknownObjs = (drawing.unknownObjects ?? [])
    .filter((p) => p.data || p.typeCode !== undefined);
  for (const p of unknownObjs) {
    if (p.typeCode === undefined) {
      addProxyCls(p.appClass, p.sourceType, 'ACAD_PROXY_OBJECT', false);
    }
  }
  const unknownObjH = unknownObjs.map((p) => keepH(p.handle));
  /* dynamic blocks: the visibility parameter — the one member of the
     family that changes what a viewer draws — is written back as its own
     class object. R13/R14 cannot name classes, so there it is reported. */
  const dynBlocks = userBlocks.filter(
    (nm) => drawing.blocks[nm]?.visibilityStates?.length);
  const usesDynBlocks = dynBlocks.length > 0 && V >= 2000;
  const CLS_BLOCKVIS = usesDynBlocks ? clsNext++ : 0;
  const underlayDefH = new Map<string, number>();
  function modelEntsAll(): Entity[] { return drawing.entities; }
  function paperEntsAll(): Entity[] { return drawing.paperSpace ?? []; }

  /* ---------------- object encoding ---------------- */
  const objects: Obj[] = [];

  /** Object type + (pre-R2010) the inline bitsize field. R2010+ moves the
   *  handle-stream position out of the record into the size prefix, so
   *  there is no bitsize placeholder to patch — hence the -1. */
  /** R2007+ keeps its text in a string stream at the tail of the data
   *  area; hook one up so every t() call lands there. */
  const withStrings = (w: BitWriter): BitWriter | null => {
    if (V < 2007) return null;
    const sw = new BitWriter();
    sw.utf16 = true;
    w.utf16 = true;
    w.strTarget = sw;
    return sw;
  };

  /** Close the data area: append the string stream, its size and the
   *  end flag, and return the resulting bitsize. */
  const closeData = (w: BitWriter, sw: BitWriter | null): number => {
    if (!sw) return w.pos;
    w.strTarget = undefined;
    const size = sw.pos;
    if (size === 0) {
      /* no strings: AutoCAD writes a bare 0 flag bit, not an empty stream */
      w.b(0);
      return w.pos;
    }
    w.appendBits(sw);
    w.rs(size & 0x7fff);
    w.b(1);                               /* strings-present flag */
    return w.pos;
  };

  const objectPrologue = (w: BitWriter, type: number): number => {
    if (V >= 2018) {
      /* BOT encoding: 00 + RC, 01 + RC-0x1f0, else 10 + RS */
      if (type <= 0xff) { w.bb(0); w.rc(type); }
      else if (type >= 0x1f0 && type <= 0x2ef) { w.bb(1); w.rc(type - 0x1f0); }
      else { w.bb(2); w.rs(type); }
      return -1;
    }
    w.bs(type);
    /* R13/R14 do not put the handle-stream position here. It lives inside
     * the record, after the handle and the extended data, because those
     * two are the only things a reader needs before it can find it. */
    if (V <= 14) return -1;
    const at = w.pos;
    w.rl(0);
    return at;
  };

  /** Close a record: pad to a byte and stash it with its handle-stream
   *  split (R2010+ needs it in the object's size prefix). */
  const finishObject = (w: BitWriter, handle: number, bitsize: number): void => {
    w.align();
    objects.push({
      handle, bytes: w.bytes(),
      handleBits: V >= 2018 ? w.pos - bitsize : undefined
    });
  };

  /** Wrap one object: type + bitsize + body builder + handle builder. */
  const makeObject = (
    type: number, handle: number,
    data: (w: BitWriter) => void,
    handles: (w: BitWriter) => void
  ): void => {
    const w = new BitWriter();
    let sizePos = objectPrologue(w, type);
    const sw = withStrings(w);
    w.h(0, handle);
    w.bs(0);                              /* EED end */
    if (V <= 14) { sizePos = w.pos; w.rl(0); }  /* handle-stream position */
    w.bl(0);                              /* reactor count */
    if (V >= 2004) w.b(1);                /* xdict missing */
    if (V >= 2018) w.b(0);                /* has_ds_data (2013+) */
    data(w);
    const bitsize = closeData(w, sw);
    if (sizePos >= 0) w.patchRl(sizePos, bitsize);
    handles(w);
    finishObject(w, handle, bitsize);
  };

  /* ---- common entity data ---- */
  interface EntCtx {
    entmode: number;                      /* 2 model, 1 paper, 0 owned */
    owner?: number;
    prev?: number;
    next?: number;
    /** R2013+: this record's payload lives in the AcDs data section. */
    hasDs?: boolean;
  }

  const makeEntity = (
    type: number, handle: number, e: Entity, ctx: EntCtx,
    data: (w: BitWriter) => void,
    extraHandles?: (w: BitWriter) => void,
    graphics?: Uint8Array
  ): void => {
    const w = new BitWriter();
    let sizePos = objectPrologue(w, type);
    const sw = withStrings(w);
    w.h(0, handle);
    w.bs(0);                              /* EED */
    if (graphics && graphics.length) {
      /* cached display list (proxy graphics), byte for byte */
      w.b(1);
      if (V <= 2007) w.rl(graphics.length); else w.bll(graphics.length);
      w.raw(graphics);
    } else {
      w.b(0);                             /* no preview */
    }
    /* R13/R14 keep the handle-stream position here, right after the
     * cached-display-list flag and before anything else. */
    if (V <= 14) { sizePos = w.pos; w.rl(0); }
    w.bb(ctx.entmode);
    w.bl(0);                              /* reactors */
    const ltFlags = e.linetype && !/^bylayer$/i.test(e.linetype)
      ? (/^byblock$/i.test(e.linetype) ? 1
        : /^continuous$/i.test(e.linetype) ? 2 : 3)
      : 0;
    if (V <= 14) w.b(ltFlags === 0 ? 1 : 0);   /* isbylayerlt */
    if (V >= 2004) w.b(1);                /* xdict missing */
    if (V <= 2002) w.b(0);                /* nolinks = 0: chain present */
    if (V >= 2018) w.b(ctx.hasDs ? 1 : 0);  /* has_ds_data (2013+) */
    w.bs(colorIndex(e));
    w.bd(e.linetypeScale ?? 1);
    if (V >= 2000) {
      w.bb(ltFlags);
      w.bb(0);                            /* plotstyle: bylayer */
    }
    if (V >= 2007) {
      w.bb(0);                            /* material flags (2007+) */
      w.rc(0);                            /* shadow flags */
      if (V >= 2018) w.b(0), w.b(0), w.b(0);   /* visualstyle (2010+) */
    }
    w.bs(e.invisible ? 1 : 0);
    if (V >= 2000) w.rc(lwCode(e.lineweight));
    data(w);
    const bitsize = closeData(w, sw);
    if (sizePos >= 0) w.patchRl(sizePos, bitsize);

    /* handle stream */
    const layerHandle = layerH.get(e.layer)
      ?? layerH.get('0') ?? [...layerH.values()][0];
    if (ctx.entmode === 0 && ctx.owner !== undefined) w.h(4, ctx.owner);
    if (V < 2004) w.h(3, 0);              /* null xdict (2004+: missing) */
    if (V <= 14) {
      /* R13/R14 name the layer and linetype first, then the sibling
       * chain. R2000 swapped the two groups round. */
      w.h(5, layerHandle);
      if (ltFlags === 3) w.h(5, ltypeH.get(e.linetype!) ?? ltContinuous);
      w.h(4, ctx.prev ?? 0);
      w.h(4, ctx.next ?? 0);
    } else {
      if (V < 2004) {
        w.h(4, ctx.prev ?? 0);            /* prev entity */
        w.h(4, ctx.next ?? 0);            /* next entity */
      }
      w.h(5, layerHandle);
      if (ltFlags === 3) w.h(5, ltypeH.get(e.linetype!) ?? ltContinuous);
    }
    extraHandles?.(w);
    finishObject(w, handle, bitsize);
  };

  /** BT / BE: the one-bit "default" shortcuts are R2000 inventions.
   *  R13/R14 spell thickness as a plain BD and extrusion as a full 3BD —
   *  writing the shortcut forms there shifts AutoCAD's parse of every
   *  simple entity (externally proven: an R14 whose only entity was one
   *  LINE opened the moment the LINE was removed, ErrorStatus=53 with it;
   *  the same file with full-width fields audits clean). */
  const wbt = (w: BitWriter, v: number): void => {
    if (V <= 14) w.bd(v);
    else w.bt(v);
  };
  const wbe = (w: BitWriter, x: number, y: number, z: number): void => {
    if (V <= 14) w.bd3(x, y, z);
    else w.be(x, y, z);
  };

  /* ---- entity-specific encoders (mirror of the decoders) ---- */
  const encodeEntity = (
    e: Entity, handle: number, ctx: EntCtx
  ): void => {
    switch (e.type) {
      case 'line':
        makeEntity(19, handle, e, ctx, (w) => {
          if (V <= 14) {
            /* R13/R14 store both ends outright; the shared-Z shortcut and
               the delta encoding for the far end arrived with R2000. */
            w.bd3(e.start.x, e.start.y, e.start.z ?? 0);
            w.bd3(e.end.x, e.end.y, e.end.z ?? 0);
            wbt(w, 0); wbe(w, 0, 0, 1);
            return;
          }
          const zZero = (e.start.z ?? 0) === 0 && (e.end.z ?? 0) === 0;
          w.b(zZero ? 1 : 0);
          w.rd(e.start.x); w.dd(e.end.x, e.start.x);
          w.rd(e.start.y); w.dd(e.end.y, e.start.y);
          if (!zZero) { w.rd(e.start.z ?? 0); w.dd(e.end.z ?? 0, e.start.z ?? 0); }
          wbt(w, 0); wbe(w, 0, 0, 1);
        });
        return;
      case 'point':
        makeEntity(27, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          wbt(w, 0); wbe(w, 0, 0, 1); w.bd(0);
        });
        return;
      case 'circle':
        makeEntity(18, handle, e, ctx, (w) => {
          w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
          w.bd(e.radius);
          wbt(w, 0); wbe(w, 0, 0, 1);
        });
        return;
      case 'arc':
        makeEntity(17, handle, e, ctx, (w) => {
          w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
          w.bd(e.radius);
          wbt(w, 0); wbe(w, 0, 0, 1);
          w.bd(e.startAngle); w.bd(e.endAngle);
        });
        return;
      case 'ellipse':
        makeEntity(35, handle, e, ctx, (w) => {
          w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
          w.bd3(e.majorAxis.x, e.majorAxis.y, e.majorAxis.z ?? 0);
          w.bd3(0, 0, 1);
          w.bd(e.ratio);
          w.bd(e.startParam); w.bd(e.endParam);
        });
        return;
      case 'ray':
      case 'xline':
        makeEntity(e.type === 'ray' ? 40 : 41, handle, e, ctx, (w) => {
          w.bd3(e.basePoint.x, e.basePoint.y, e.basePoint.z ?? 0);
          const dir = e.direction ?? { x: 1, y: 0, z: 0 };
          w.bd3(dir.x, dir.y, dir.z ?? 0);
        });
        return;
      case 'solid':
        makeEntity(31, handle, e, ctx, (w) => {
          wbt(w, 0);
          w.bd(e.corners[0].z ?? 0);
          for (const c of e.corners) { w.rd(c.x); w.rd(c.y); }
          wbe(w, 0, 0, 1);
        });
        return;
      case 'face3d':
        makeEntity(28, handle, e, ctx, (w) => {
          if (V <= 14) {
            /* R13/R14: four plain points and the edge-visibility short,
               always present. The flag-elision and delta form came later. */
            for (const c of e.corners) w.bd3(c.x, c.y, c.z ?? 0);
            w.bs(e.invisibleEdges ?? 0);
            return;
          }
          const zZero = e.corners.every((c) => (c.z ?? 0) === 0);
          const noFlags = !e.invisibleEdges;
          w.b(noFlags ? 1 : 0);
          w.b(zZero ? 1 : 0);
          w.rd(e.corners[0].x); w.rd(e.corners[0].y);
          if (!zZero) w.rd(e.corners[0].z ?? 0);
          let [px, py, pz] = [e.corners[0].x, e.corners[0].y, e.corners[0].z ?? 0];
          for (let i = 1; i < 4; i++) {
            const c = e.corners[i];
            w.dd(c.x, px); w.dd(c.y, py); w.dd(c.z ?? 0, pz);
            px = c.x; py = c.y; pz = c.z ?? 0;
          }
          if (!noFlags) w.bs(e.invisibleEdges ?? 0);
        });
        return;
      case 'polyline': {
        makeEntity(77, handle, e, ctx, (w) => {
          const hasBulges = e.vertices.some((v) => v.bulge);
          const hasWidths = e.vertices.some((v) => v.startWidth || v.endWidth);
          let flag = 0;
          if (e.constantWidth) flag |= 4;
          if (e.elevation) flag |= 8;
          if (hasBulges) flag |= 16;
          if (hasWidths) flag |= 32;
          if (e.closed) flag |= 512;
          w.bs(flag);
          if (e.constantWidth) w.bd(e.constantWidth);
          if (e.elevation) w.bd(e.elevation);
          w.bl(e.vertices.length);
          if (hasBulges) w.bl(e.vertices.length);
          if (hasWidths) w.bl(e.vertices.length);
          let lx = 0, ly = 0;
          e.vertices.forEach((v, i) => {
            /* R13/R14 repeat the full pair for every vertex; the delta
               form against the previous point arrived with R2000. */
            if (i === 0 || V <= 14) { w.rd(v.x); w.rd(v.y); }
            else { w.dd(v.x, lx); w.dd(v.y, ly); }
            lx = v.x; ly = v.y;
          });
          if (hasBulges) for (const v of e.vertices) w.bd(v.bulge ?? 0);
          if (hasWidths) {
            for (const v of e.vertices) { w.bd(v.startWidth ?? 0); w.bd(v.endWidth ?? 0); }
          }
        });
        return;
      }
      case 'text': {
        makeEntity(1, handle, e, ctx, (w) => {
          const ha = { left: 0, center: 1, right: 2, aligned: 3, middle: 4, fit: 5 }[e.halign ?? 'left'] ?? 0;
          const va = { baseline: 0, bottom: 1, middle: 2, top: 3 }[e.valign ?? 'baseline'] ?? 0;
          const elev = e.position.z ?? 0;
          const wf = e.widthFactor ?? 1;
          if (V <= 14) {
            /* R13/R14 write every field out. The dataflags byte that lets
               R2000 omit the defaults did not exist yet. */
            const ap0 = e.alignmentPoint ?? e.position;
            w.bd(elev);
            w.rd(e.position.x); w.rd(e.position.y);
            w.rd(ap0.x); w.rd(ap0.y);
            w.bd3(0, 0, 1);                 /* extrusion */
            w.bd(0);                        /* thickness */
            w.bd(e.oblique ?? 0);
            w.bd(e.rotation);
            w.bd(e.height > 0 ? e.height : 5);
            w.bd(wf);
            w.t(outText(e.text));
            w.bs(0);                        /* generation */
            w.bs(ha); w.bs(va);
            return;
          }
          let df = 0;
          if (elev === 0) df |= 0x01;
          const ap = e.alignmentPoint;
          if (!ap || (ap.x === e.position.x && ap.y === e.position.y)) df |= 0x02;
          if (!e.oblique) df |= 0x04;
          if (!e.rotation) df |= 0x08;
          if (wf === 1) df |= 0x10;
          df |= 0x20;                     /* generation default */
          if (!ha) df |= 0x40;
          if (!va) df |= 0x80;
          w.rc(df);
          if (!(df & 0x01)) w.rd(elev);
          w.rd(e.position.x); w.rd(e.position.y);
          if (!(df & 0x02)) { w.dd(ap!.x, e.position.x); w.dd(ap!.y, e.position.y); }
          w.be(0, 0, 1);
          w.bt(0);
          if (!(df & 0x04)) w.rd(e.oblique ?? 0);
          if (!(df & 0x08)) w.rd(e.rotation);
          w.rd(e.height > 0 ? e.height : 5);
          if (!(df & 0x10)) w.rd(wf);
          w.t(outText(e.text));
          if (!(df & 0x40)) w.bs(ha);
          if (!(df & 0x80)) w.bs(va);
        }, (w) => {
          w.h(5, styleH.get(e.style ?? '') ?? styleH.get('Standard') ?? [...styleH.values()][0]);
        });
        return;
      }
      case 'mtext': {
        makeEntity(44, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          w.bd3(0, 0, 1);                 /* extrusion */
          const rot = e.rotation || 0;
          w.bd(Math.cos(rot)); w.bd(Math.sin(rot)); w.bd(0);
          w.bd(e.width ?? 0);
          if (V >= 2007) w.bd(0);         /* rect height (2007+) */
          w.bd(e.height > 0 ? e.height : 5);
          w.bs(e.attachment ?? 1);
          w.bs(1);                        /* flow: left to right */
          w.bd(0); w.bd(0);               /* extents */
          w.t(outText((e.raw ?? e.text).replace(/\n/g, '\\P')));
          /* R2000 line spacing — not part of the R13/R14 record (the
             decode-gap census read our own R14 MTEXT 13 bits short) */
          if (V >= 2000) { w.bs(1); w.bd(1); w.b(0); }
          if (V >= 2004) w.bl(0);         /* background flags */
          if (V >= 2018) {
            /* R2018 annotative/column block (walked GAP=0 against every
               MTEXT in famA_2018.dwg): a not-annotative marker, then an
               echo of the placement fields, then the column data. A
               record without it makes AutoCAD 2027 fail the open with
               ErrorStatus=53. */
            w.b(1);                       /* is_not_annotative */
            w.bs(4); w.b(1);              /* class version, default flag */
            /* null appid handle rides the handle stream */
            w.bl(e.attachment ?? 1);      /* attachment echo */
            w.bd(Math.cos(rot)); w.bd(Math.sin(rot)); w.bd(0);
            w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
            w.bd(e.width ?? 0); w.bd(0);  /* rect width / height echo */
            w.bd(0); w.bd(0);             /* extents width / height */
            w.bl(0);                      /* column type: none */
          }
        }, (w) => {
          w.h(5, styleH.get(e.style ?? '') ?? styleH.get('Standard') ?? [...styleH.values()][0]);
          if (V >= 2018) w.h(5, 0);       /* appid (null) */
        });
        return;
      }
      case 'underlay': {
        const key = e.underlayKind + '|' + (e.path ?? '') + '|' + (e.itemName ?? '');
        let defH = underlayDefH.get(key);
        if (defH === undefined) underlayDefH.set(key, defH = H());
        makeEntity(underlayCls.get(e.underlayKind)!.ent, handle, e, ctx, (w) => {
          w.bd3(0, 0, 1);                 /* normal */
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          w.bd(e.rotation || 0);
          w.bd(e.scale.x || 1); w.bd(e.scale.y || 1); w.bd(e.scale.z || 1);
          w.rc(e.flags ?? 2);
          w.rc(e.contrast ?? 100);
          w.rc(e.fade ?? 0);
          /* definition handle rides the handle stream */
          w.bl(e.clip?.length ?? 0);
          for (const p of e.clip ?? []) { w.rd(p.x); w.rd(p.y); }
        }, (w) => {
          w.h(5, defH!);
        });
        return;
      }

      case 'insert': {
        const bh = blockH.get(e.blockName);
        if (bh === undefined) { skipped.push('insert:' + e.blockName); return; }
        const attrs = (e.attributes ?? []).filter((a) => a.type === 'text');
        const attrHs = attrs.map(() => H());
        const seqH = attrs.length ? H() : 0;
        const isMinsert = (e.columnCount ?? 1) > 1 || (e.rowCount ?? 1) > 1;
        makeEntity(isMinsert ? 8 : 7, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          /* a hand-built insert may leave the scale off entirely */
          const sc = e.scale ?? { x: 1, y: 1, z: 1 };
          const sx = sc.x || 1, sy = sc.y || 1, sz = sc.z || 1;
          if (V <= 14) { w.bd(sx); w.bd(sy); w.bd(sz); }
          /* R2000 added a two-bit selector that elides the common cases */
          else if (sx === 1 && sy === 1 && sz === 1) w.bb(3);
          else if (sx === sy && sy === sz) { w.bb(2); w.rd(sx); }
          else if (sx === 1) { w.bb(1); w.dd(sy, 1); w.dd(sz, 1); }
          else { w.bb(0); w.rd(sx); w.dd(sy, sx); w.dd(sz, sx); }

          w.bd(e.rotation);
          w.bd3(0, 0, 1);
          w.b(attrs.length ? 1 : 0);
          if (V >= 2004 && attrs.length) w.bl(attrs.length);
          if (isMinsert) {
            w.bs(e.columnCount ?? 1); w.bs(e.rowCount ?? 1);
            w.bd(e.columnSpacing ?? 0); w.bd(e.rowSpacing ?? 0);
          }
        }, (w) => {
          w.h(5, bh);
          if (attrs.length) {
            if (V < 2004) {
              w.h(4, attrHs[0]);
              w.h(4, attrHs[attrHs.length - 1]);
            } else {
              for (const ah of attrHs) w.h(4, ah);
            }
            w.h(3, seqH);
          }
        });
        attrs.forEach((a, i) => {
          makeEntity(2, attrHs[i], a, {
            entmode: 0, owner: handle,
            prev: attrHs[i - 1] ?? 0, next: attrHs[i + 1] ?? 0
          }, (w) => {
            const elev = a.position.z ?? 0;
            if (V <= 14) {
              /* R13/R14 ATTRIB: every field explicit, like R13/R14 TEXT —
                 the dataflags byte below is an R2000 invention */
              w.bd(elev);
              w.rd(a.position.x); w.rd(a.position.y);
              w.rd(a.position.x); w.rd(a.position.y);   /* alignment pt */
              w.bd3(0, 0, 1);               /* extrusion */
              w.bd(0);                      /* thickness */
              w.bd(a.oblique ?? 0);
              w.bd(a.rotation);
              w.bd(a.height > 0 ? a.height : 5);
              w.bd(a.widthFactor ?? 1);
              w.t(outText(a.text));
              w.bs(0);                      /* generation */
              w.bs(0); w.bs(0);             /* halign, valign */
              /* ATTRIB closes with tag + field length + flags; the prompt
                 text exists only in ATTDEF */
              w.t(outText(r14Str('ATTR' + (i + 1))));   /* tag */
              w.bs(0);                      /* field length */
              w.rc(a.invisible ? 1 : 0);    /* flags */
              return;
            }
            let df = 0x20 | 0x40 | 0x80;  /* default gen/halign/valign */
            if (elev === 0) df |= 0x01;
            df |= 0x02;                   /* alignment = position */
            if (!a.oblique) df |= 0x04;
            if (!a.rotation) df |= 0x08;
            if ((a.widthFactor ?? 1) === 1) df |= 0x10;
            w.rc(df);
            if (!(df & 0x01)) w.rd(elev);
            w.rd(a.position.x); w.rd(a.position.y);
            w.be(0, 0, 1);
            w.bt(0);
            if (!(df & 0x04)) w.rd(a.oblique ?? 0);
            if (!(df & 0x08)) w.rd(a.rotation);
            w.rd(a.height > 0 ? a.height : 5);
            if (!(df & 0x10)) w.rd(a.widthFactor ?? 1);
            w.t(outText(a.text));
            if (V >= 2018) {
              /* R2010 added a class-version byte, R2018 the attribute
                 type (1 = single-line) — both sit before the tag, and
                 omitting them shifts AutoCAD's parse (ErrorStatus 53,
                 singleton-proven) */
              w.rc(0);                    /* class version */
              w.rc(1);                    /* attribute type: single-line */
            }
            w.t('ATTR' + (i + 1));        /* tag */
            w.bs(0);                      /* field length */
            w.rc(a.invisible ? 1 : 0);    /* flags */
            if (V >= 2007) w.b(0);        /* lock-position flag */
          }, (w) => {
            w.h(5, styleH.get(a.style ?? '') ?? [...styleH.values()][0]);
          });
        });
        if (attrs.length) {
          const fake: Entity = {
            type: 'point', layer: e.layer, color: { kind: 'byLayer' },
            position: { x: 0, y: 0, z: 0 }
          };
          makeEntity(6, seqH, fake, { entmode: 0, owner: handle },
            () => { /* SEQEND */ });
        }
        return;
      }
      case 'dimension': {
        const KIND_TYPE: Record<string, number> = {
          ordinate: 20, linear: 21, aligned: 22, angular3pt: 23,
          angular2ln: 24, radius: 25, diameter: 26
        };
        const kind = e.kind && e.kind !== 'arc' ? e.kind : 'linear';
        makeEntity(KIND_TYPE[kind], handle, e, ctx, (w) => {
          if (V >= 2018) w.rc(0);         /* class version (2010+) */
          w.bd3(0, 0, 1);                 /* extrusion */
          const tm = e.textMidpoint ?? e.definitionPoint;
          w.rd(tm.x); w.rd(tm.y);
          w.bd(e.elevation ?? 0);
          /* flag1: bit0 = default text position, bit1 = block reference */
          w.rc(((e.dimensionType & 128) ? 0 : 1) | 2);
          w.t(outText(e.text ?? ''));
          w.bd(e.textRotation ?? 0);
          w.bd(e.horizDirection ?? 0);
          w.bd3(1, 1, 1);                 /* ins scale */
          w.bd(0);                        /* ins rotation */
          if (V >= 2000) {
            /* text attachment and line spacing joined the record in R2000 */
            w.bs(e.attachment ?? 5);
            w.bs(e.lineSpacingStyle ?? 1);
            w.bd(e.lineSpacingFactor ?? 1);
            w.bd(e.measurement ?? 0);
          }
          if (V >= 2007) { w.b(0); w.b(0); w.b(0); }   /* flip arrows (2007+) */
          const ip = e.insertionPoint;
          w.rd(ip?.x ?? 0); w.rd(ip?.y ?? 0);
          const P = (p?: { x: number; y: number; z?: number }): void =>
            w.bd3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
          switch (kind) {
            case 'ordinate':
              P(e.definitionPoint); P(e.point13); P(e.point14);
              w.rc((e.dimensionType & 64) ? 1 : 0);
              break;
            case 'linear':
              P(e.point13); P(e.point14); P(e.definitionPoint);
              w.bd(e.obliqueAngle ?? 0); w.bd(e.rotation ?? 0);
              break;
            case 'aligned':
              P(e.point13); P(e.point14); P(e.definitionPoint);
              w.bd(e.obliqueAngle ?? 0);
              break;
            case 'angular3pt':
              P(e.definitionPoint); P(e.point13); P(e.point14); P(e.point15);
              break;
            case 'angular2ln':
              w.rd(e.point16?.x ?? 0); w.rd(e.point16?.y ?? 0);
              P(e.point13); P(e.point14); P(e.point15); P(e.definitionPoint);
              break;
            case 'radius':
              P(e.definitionPoint); P(e.point15);
              w.bd(e.leaderLength ?? 0);
              break;
            case 'diameter':
              P(e.point15); P(e.definitionPoint);
              w.bd(e.leaderLength ?? 0);
              break;
          }
        }, (w) => {
          w.h(5, dimStyleRef(e.style));   /* dimstyle */
          w.h(5, (e.blockName && blockH.get(e.blockName)) || 0);
        });
        return;
      }

      case 'hatch': {
        makeEntity(78, handle, e, ctx, (w) => {
          const TAU = Math.PI * 2;
          if (V >= 2004) {
            /* gradient block precedes the hatch data from R2004 on */
            const g = e.gradient;
            w.bl(g ? 1 : 0);
            w.bl(0);                      /* reserved */
            w.bd(g?.angle ?? 0);
            w.bd(g?.shift ?? 0);
            w.bl(g?.singleColor ? 1 : 0);
            w.bd(g?.tint ?? 0);
            const colors = g?.colors ?? [];
            w.bl(colors.length);
            for (const c of colors) {
              w.bd(c.shift);
              w.bs(c.color.kind === 'aci' ? c.color.index : 7);
              w.bl(c.color.kind === 'rgb' ? (0xc2000000 | c.color.rgb) >>> 0 : 0);
              w.rc(0);
            }
            w.t(outText(g?.name ?? ''));
          }
          w.bd(e.elevation ?? 0);
          w.bd3(0, 0, 1);
          w.t(outText(e.patternName || (e.solid ? 'SOLID' : 'ANSI31')));
          w.b(e.solid ? 1 : 0);
          w.b(e.associative ? 1 : 0);
          w.bl(e.loops.length);
          for (const loop of e.loops) {
            if (loop.kind === 'polyline') {
              w.bl(2);                    /* polyline path */
              const bulges = loop.vertices.some((p) => p.bulge);
              w.b(bulges ? 1 : 0);
              w.b(loop.closed ? 1 : 0);
              w.bl(loop.vertices.length);
              for (const p of loop.vertices) {
                w.rd(p.x); w.rd(p.y);
                if (bulges) w.bd(p.bulge ?? 0);
              }
            } else {
              w.bl(0);                    /* edge path */
              const edges = loop.kind === 'edges' ? loop.edges
                : loop.kind === 'circle'
                  ? [{ kind: 'arc', center: loop.center, radius: loop.radius,
                      startAngle: 0, endAngle: TAU, ccw: true } as const]
                  : [{ kind: 'ellipticalArc', center: loop.center,
                      majorAxis: loop.majorAxis, ratio: loop.ratio,
                      startAngle: 0, endAngle: TAU, ccw: true } as const];
              w.bl(edges.length);
              for (const ed of edges) {
                if (ed.kind === 'line') {
                  w.rc(1);
                  w.rd(ed.start.x); w.rd(ed.start.y);
                  w.rd(ed.end.x); w.rd(ed.end.y);
                } else if (ed.kind === 'arc') {
                  w.rc(2);
                  w.rd(ed.center.x); w.rd(ed.center.y);
                  w.bd(ed.radius);
                  w.bd(ed.startAngle); w.bd(ed.endAngle);
                  w.b(ed.ccw ? 1 : 0);
                } else if (ed.kind === 'ellipticalArc') {
                  w.rc(3);
                  w.rd(ed.center.x); w.rd(ed.center.y);
                  w.rd(ed.majorAxis.x); w.rd(ed.majorAxis.y);
                  w.bd(ed.ratio);
                  w.bd(ed.startAngle); w.bd(ed.endAngle);
                  w.b(ed.ccw ? 1 : 0);
                } else {
                  w.rc(4);
                  w.bl(ed.degree > 0 ? ed.degree : 3);
                  w.b(ed.weights?.length ? 1 : 0);
                  w.b(ed.periodic ? 1 : 0);
                  w.bl(ed.knots.length);
                  w.bl(ed.controlPoints.length);
                  for (const k of ed.knots) w.bd(k);
                  ed.controlPoints.forEach((p, i) => {
                    w.rd(p.x); w.rd(p.y);
                    if (ed.weights?.length) w.bd(ed.weights[i] ?? 1);
                  });
                }
              }
            }
            w.bl(0);                      /* boundary object handles */
          }
          w.bs(e.styleFlag ?? 0);
          w.bs(e.patternType ?? 1);
          if (!e.solid) {
            w.bd((e.angle || 0) * Math.PI / 180);
            w.bd(e.scale > 0 ? e.scale : 1);
            w.b(e.doubled ? 1 : 0);
            const dls = e.definitionLines ?? [];
            w.bs(dls.length);
            for (const dl of dls) {
              w.bd(dl.angle * Math.PI / 180);
              w.bd(dl.base.x); w.bd(dl.base.y);
              w.bd(dl.offset.x); w.bd(dl.offset.y);
              w.bs(dl.dashes.length);
              for (const d of dl.dashes) w.bd(d);
            }
          }
          const seeds = e.seeds ?? [];
          w.bl(seeds.length);
          for (const s of seeds) { w.rd(s.x); w.rd(s.y); }
        });
        return;
      }

      case 'mline': {
        makeEntity(47, handle, e, ctx, (w) => {
          w.bd(e.scale || 1);
          w.rc(e.justification & 0xff);
          w.bd3(e.basePoint.x, e.basePoint.y, e.basePoint.z ?? 0);
          w.bd3(0, 0, 1);
          w.bs(1 | (e.closed ? 2 : 0));
          const numLines = e.vertices[0]?.lines.length ?? 0;
          w.rc(numLines);
          w.bs(e.vertices.length);
          for (const v2 of e.vertices) {
            w.bd3(v2.position.x, v2.position.y, v2.position.z ?? 0);
            w.bd3(v2.direction.x, v2.direction.y, v2.direction.z ?? 0);
            w.bd3(v2.miterDirection.x, v2.miterDirection.y, v2.miterDirection.z ?? 0);
            for (let j = 0; j < numLines; j++) {
              const ln = v2.lines[j] ?? { segparms: [] };
              w.bs(ln.segparms.length);
              for (const s of ln.segparms) w.bd(s);
              w.bs(ln.areaFillParms?.length ?? 0);
              for (const s of ln.areaFillParms ?? []) w.bd(s);
            }
          }
        }, (w) => {
          /* the STANDARD style exists at R13/R14 (synthesized above); the
             later releases keep the proven null reference */
          w.h(5, mlineStandardH);         /* mlinestyle */
        });
        return;
      }

      case 'tolerance':
        makeEntity(46, handle, e, ctx, (w) => {
          if (V <= 14) {
            w.bs(0);                      /* unknown short */
            w.bd(0);                      /* text height */
            w.bd(0);                      /* dimgap */
          }
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          w.bd3(e.xDirection.x, e.xDirection.y, e.xDirection.z ?? 0);
          w.bd3(0, 0, 1);
          w.t(outText(e.text));
        }, (w) => {
          w.h(5, dimStandardH);           /* dimstyle */
        });
        return;

      case 'shape':
        makeEntity(33, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          w.bd(e.size > 0 ? e.size : 1);
          w.bd(e.rotation);
          w.bd(e.widthFactor ?? 1);
          w.bd(e.oblique ?? 0);
          w.bd(0);                        /* thickness */
          w.bs(e.styleId ?? 0);
          w.bd3(0, 0, 1);
        }, (w) => {
          w.h(5, styleH.get(e.style ?? '') ?? [...styleH.values()][0]);
        });
        return;

      case 'leader': {
        makeEntity(45, handle, e, ctx, (w) => {
          w.b(0);
          w.bs(e.annotationType ?? 3);
          w.bs(e.pathType ?? 0);
          w.bl(e.vertices.length);
          for (const p of e.vertices) w.bd3(p.x, p.y, p.z ?? 0);
          const last = e.vertices[e.vertices.length - 1] ?? { x: 0, y: 0, z: 0 };
          w.bd3(last.x, last.y, last.z ?? 0);   /* origin */
          w.bd3(0, 0, 1);                 /* extrusion */
          w.bd3(1, 0, 0);                 /* x direction */
          w.bd3(0, 0, 0);                 /* inspt offset */
          /* endptproj: R13c3 and every later version (AutoCAD 2027 keeps
             it in R2018 records); plain R13 (AC1012) has no such point */
          if (V > 13) w.bd3(0, 0, 0);
          if (V <= 14) w.bd(0);           /* dimgap, dropped in R2000 */
          if (V <= 2007) { w.bd(0); w.bd(0); }  /* box height/width,
                                             dropped in R2010+ (verified
                                             against a minted 2018 LEADER) */
          w.b(0);                         /* hookline dir */
          w.b(e.hasArrowhead === false ? 0 : 1);
          w.bs(0);                        /* arrowhead type */
          if (V <= 14) {
            /* R13/R14 close the record with a wider block of leader
               state; R2000 replaced the lot with two bits. */
            w.bd(0); w.b(0); w.b(0); w.bs(0); w.bs(0); w.b(0); w.b(0);
          } else {
            w.b(0); w.b(0);               /* two unknown bits (2000+) */
          }
        }, (w) => {
          w.h(2, 0);                      /* associated annotation */
          w.h(5, dimStandardH);           /* dimstyle */
        });
        return;
      }

      case 'viewport':
        makeEntity(34, handle, e, ctx, (w) => {
          w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
          w.bd(e.width); w.bd(e.height);
          const t = e.viewTarget ?? { x: 0, y: 0, z: 0 };
          w.bd3(t.x, t.y, t.z ?? 0);
          const d = e.viewDirection ?? { x: 0, y: 0, z: 1 };
          w.bd3(d.x, d.y, d.z ?? 0);
          w.bd(e.twistAngle ?? 0);
          w.bd(e.viewHeight ?? e.height);
          w.bd(e.lensLength ?? 50);
          w.bd(0); w.bd(0);               /* front/back clip */
          w.bd(0);                        /* snap angle */
          const vc = e.viewCenter ?? { x: e.center.x, y: e.center.y };
          w.rd(vc.x); w.rd(vc.y);
          w.rd(0); w.rd(0);               /* snap base */
          w.rd(10); w.rd(10);             /* snap unit */
          w.rd(10); w.rd(10);             /* grid unit */
          w.bs(100);                      /* circle zoom */
          if (V >= 2007) w.bs(0);         /* grid major (2007+) */
          w.bl(0);                        /* frozen layer count */
          w.bl(e.statusFlag ?? 0);
          w.t('');                        /* style sheet */
          w.rc(0);                        /* render mode */
          w.b(1); w.b(1);                 /* ucs at origin, UCSVP */
          w.bd3(0, 0, 0); w.bd3(1, 0, 0); w.bd3(0, 1, 0);
          w.bd(0);                        /* ucs elevation */
          w.bs(0);                        /* ortho view type */
          if (V >= 2004) w.bs(0);         /* shadeplot mode */
          if (V >= 2007) {
            w.b(1); w.rc(1); w.bd(0.5); w.bd(0.5);   /* lights (2007+) */
            w.bs(256); w.bl(0); w.rc(0);  /* ambient color CMC */
          }
        }, (w) => {
          w.h(5, 0);                      /* clip boundary */
          if (V <= 2004) w.h(5, 0);       /* vport entity header (<=2002) */
          w.h(5, 0); w.h(5, 0);           /* named/base ucs */
          if (V >= 2007) { w.h(4, 0); w.h(5, 0); w.h(4, 0); w.h(3, 0); }
        });
        return;

      case 'light':
        makeEntity(CLS_LIGHT, handle, e, ctx, (w) => {
          w.bl(0);                        /* class version */
          w.t(e.name ?? '');
          w.bl(e.lightType ?? 1);
          w.b(e.on === false ? 0 : 1);
          const aci = e.lightColor?.kind === 'aci' ? e.lightColor.index : 7;
          w.bs(aci);
          if (V >= 2004) { w.bl(0); w.rc(0); }        /* CMC rgb + flags */
          w.b(0);                         /* plot glyph */
          w.bd(e.intensity ?? 1);
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          const tgt = e.target ?? { x: 0, y: 0, z: 0 };
          w.bd3(tgt.x, tgt.y, tgt.z ?? 0);
          w.bl(0);                        /* attenuation type */
          w.b(0);                         /* use attenuation limits */
          w.bd(0); w.bd(1);               /* attenuation start / end */
          w.bd(e.hotspotAngle ?? 0);
          w.bd(e.falloffAngle ?? 0);
          w.b(e.castShadows ? 1 : 0);
        });
        return;

      case 'mleader': {
        /* CMC colour: index, then the 2004+ rgb/method dword + name flags.
           AutoCAD 2027 writes the method in the dword's top byte: 0xC0
           ByLayer, 0xC1 ByBlock (leading BS left 0) — mirrored bit for bit
           from famD_2018.dwg / famD_2010.dwg. */
        const cmc = (w: BitWriter, method = 0xC1): void => {
          if (V >= 2004) { w.bs(0); w.bl((method << 24) >>> 0); w.rc(0); }
          else w.bs(method === 0xC0 ? 256 : 0);
        };
        const blockH2 = e.blockName !== undefined
          ? blockH.get(e.blockName) : undefined;
        const hasText = e.text !== undefined && !!e.textPosition;
        const hasBlock = !hasText && blockH2 !== undefined && !!e.blockPosition;
        makeEntity(CLS_MLEADER, handle, e, ctx, (w) => {
          if (V >= 2018) w.bs(2);         /* class version */
          w.bl(e.leaders.length);
          for (const ld of e.leaders) {
            w.b(ld.landing ? 1 : 0);
            w.b(ld.doglegVector ? 1 : 0);
            if (ld.landing) {
              w.bd3(ld.landing.x, ld.landing.y, ld.landing.z ?? 0);
            }
            if (ld.doglegVector) {
              w.bd3(ld.doglegVector.x, ld.doglegVector.y, ld.doglegVector.z ?? 0);
            }
            w.bl(0);                      /* break count */
            w.bl(0);                      /* branch index */
            w.bd(ld.doglegLength ?? 0);
            w.bl(ld.lines.length);
            ld.lines.forEach((line, li) => {
              w.bl(line.length);
              for (const p of line) w.bd3(p.x, p.y, p.z ?? 0);
              w.bl(0);                    /* line break count */
              w.bl(li);                   /* line index */
              if (V >= 2018) {
                w.bs(1);                  /* path type */
                cmc(w);                   /* line colour */
                w.bl(-2);                 /* line weight: ByBlock */
                w.bd(0);                  /* arrow size (no override) */
                w.bl(0);                  /* override flags */
              }
            });
            if (V >= 2018) w.bs(0);       /* attachment direction */
          }
          /* context data */
          w.bd(e.scale ?? 1);
          {                               /* content base: dogleg end */
            const l0 = e.leaders[0];
            const cb = l0?.landing && l0.doglegVector
              ? {
                  x: l0.landing.x + l0.doglegVector.x * (l0.doglegLength ?? 0),
                  y: l0.landing.y + l0.doglegVector.y * (l0.doglegLength ?? 0),
                  z: (l0.landing.z ?? 0)
                    + (l0.doglegVector.z ?? 0) * (l0.doglegLength ?? 0)
                }
              : e.textPosition ?? e.blockPosition ?? { x: 0, y: 0, z: 0 };
            w.bd3(cb.x, cb.y, cb.z ?? 0);
          }
          w.bd(e.textHeight ?? 0);
          w.bd(e.arrowSize ?? 0);
          w.bd(0);                        /* landing gap */
          w.bs(1); w.bs(1);               /* left/right attachment */
          w.bs(0); w.bs(0);               /* text angle type, alignment */
          w.b(hasText ? 1 : 0);
          if (hasText) {
            w.t(outText(e.text!));
            w.bd3(0, 0, 1);               /* normal */
            const p = e.textPosition!;
            w.bd3(p.x, p.y, p.z ?? 0);
            w.bd3(1, 0, 0);               /* direction */
            w.bd(e.textRotation ?? 0);
            w.bd(0); w.bd(0);             /* width, height */
            w.bd(1); w.bs(1);             /* line spacing factor + style */
            cmc(w, 0xC0);                 /* colour (ByLayer) */
            w.bs(1); w.bs(5);             /* alignment, flow (by style) */
            cmc(w, 0xC0);                 /* background colour */
            w.bd(0); w.bl(0);             /* bg scale, transparency */
            w.b(0); w.b(0);               /* bg fill flags */
            w.bs(0);                      /* column type */
            w.b(0);                       /* auto height */
            w.bd(0); w.bd(0);             /* column width, gutter */
            w.b(0);                       /* flow reversed */
            w.bl(0);                      /* column sizes */
            w.b(0); w.b(0);               /* word break, unknown */
          } else {
            w.b(hasBlock ? 1 : 0);
            if (hasBlock) {
              w.bd3(0, 0, 1);             /* normal */
              const p = e.blockPosition!;
              w.bd3(p.x, p.y, p.z ?? 0);
              const s = e.blockScale ?? { x: 1, y: 1, z: 1 };
              w.bd3(s.x, s.y, s.z ?? 1);
              w.bd(e.blockRotation ?? 0);
              cmc(w);                     /* colour */
              /* identity transform matrix */
              for (let r2 = 0; r2 < 4; r2++) {
                for (let c2 = 0; c2 < 4; c2++) w.bd(r2 === c2 ? 1 : 0);
              }
            }
          }
          w.bd3(0, 0, 0);                 /* base point */
          w.bd3(1, 0, 0);                 /* base direction */
          w.bd3(0, 1, 0);                 /* base vertical */
          w.b(0);                         /* normal reversed */
          if (V >= 2018) { w.bs(9); w.bs(9); }  /* text top/bottom attach */
          /* trailing common mleader data — the full record AutoCAD's
             parser expects (walked bit-for-bit against famD_2018.dwg /
             famD_2010.dwg). A truncated tail makes AutoCAD read the
             string stream as counts and hang. */
          w.bl(0);                        /* property override flags */
          w.bs(1);                        /* leader line type: straight */
          cmc(w);                         /* line colour (ByBlock) */
          w.bl(-2);                       /* line weight: ByBlock */
          w.b(e.hasLanding ? 1 : 0);
          w.b(e.hasDogleg ? 1 : 0);
          w.bd(e.leaders[0]?.doglegLength ?? 0);   /* landing distance */
          w.bd(e.arrowSize ?? 0);         /* arrowhead size */
          w.bs(hasBlock ? 1 : 2);         /* content type: block / mtext */
          /* text style handle rides the handle stream */
          w.bs(1); w.bs(1);               /* text left/right attachment */
          w.bs(1);                        /* text angle type */
          w.bs(0);                        /* text alignment */
          cmc(w);                         /* text colour */
          w.b(0);                         /* no text frame */
          /* block content style handle rides the handle stream */
          cmc(w);                         /* block colour */
          w.bd3(1, 1, 1);                 /* block scale */
          w.bd(0);                        /* block rotation */
          w.bs(0);                        /* block connection type */
          w.b(0);                         /* not annotative */
          if (V >= 2018) {
            /* 17-bit undocumented island before the attachment trio,
               constant across AutoCAD 2027 mints at 2010 and 2018 */
            for (const bit of [1,0,0,1,0,0,1,0,0,0,0,0,0,0,1,0,1]) w.b(bit);
            w.bs(0);                      /* attachment direction */
            w.bs(9); w.bs(9);             /* top / bottom attachment */
            w.b(0);                       /* 2013+ trailing flag */
          } else {
            w.bl(0);                      /* arrowhead count */
            w.bl(0);                      /* block label count */
            w.b(0);                       /* text direction negative */
            w.bs(0); w.bs(0);             /* IPE align, justification */
          }
        }, (w) => {
          if (V >= 2018) {
            /* per-line linetype + arrow references, in decode order */
            for (const ld of e.leaders) {
              for (const line of ld.lines) { void line; w.h(5, 0); w.h(5, 0); }
            }
          }
          if (hasText) {
            w.h(5, styleH.get(e.textStyle ?? '') ?? styleH.get('Standard')
              ?? [...styleH.values()][0]);
          } else if (hasBlock) {
            w.h(5, blockH2!);
          }
          w.h(5, mleaderStyleH);          /* mleader style: Standard */
          w.h(5, 0);                      /* line linetype */
          w.h(5, 0);                      /* arrow head */
          /* the common section's own content references (text style +
             block style), present in every AutoCAD-minted record */
          w.h(5, styleH.get(e.textStyle ?? '') ?? styleH.get('Standard')
            ?? [...styleH.values()][0]);
          w.h(5, hasBlock ? blockH2! : 0);
        });
        return;
      }

      case 'table': {
        if (V >= 2018) {
          /* R2010 on: AutoCAD folds the whole TABLECONTENT structure into
             the entity behind a block-reference prologue and twelve
             constant bits, and closes it with merges, the horizontal
             direction and one break-data range (token-walked against five
             AutoCAD-2027-minted tables; every constant below mirrors
             them). The old stub + TABLECONTENT companion pair is gone,
             but the reader keeps accepting it in files we wrote before. */
          makeEntity(CLS_TABLE, handle, e, ctx, (w) => {
            const value = (text: string): void => {
              w.bl(0);                    /* format flags */
              w.bl(4);                    /* data type: string */
              const s = outText(text);
              w.bs((s.length + 1) * 2);
              for (let i = 0; i < s.length; i++) {
                const c = s.charCodeAt(i);
                w.rc(c & 0xff); w.rc((c >> 8) & 0xff);
              }
              w.rc(0); w.rc(0);           /* terminator */
              w.bl(0);                    /* unit type */
              w.t('');                    /* format string */
              w.t('');                    /* rendered form */
            };
            const style = (kind: number): void => { w.bl(kind); w.bs(0); };
            w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
            w.bb(3);                      /* unit scale */
            w.bd(0);                      /* rotation */
            w.bd3(0, 0, 1);               /* extrusion */
            w.b(0);                       /* no attribs */
            w.rc(0); w.bl(0); w.bl(0);    /* the twelve constant bits */
            w.t(''); w.t('');             /* linked data name, description */
            w.bl(e.numColumns);
            for (let c = 0; c < e.numColumns; c++) {
              w.t('');                    /* column name */
              w.bl(0); w.bl(0);           /* custom data flag + count */
              style(3);
              w.bl(0);                    /* style id */
              w.bd(e.columnWidths[c] ?? 1);
            }
            w.bl(e.numRows);
            for (let r2 = 0; r2 < e.numRows; r2++) {
              w.bl(e.numColumns);         /* cells in this row */
              for (let c = 0; c < e.numColumns; c++) {
                const cell = e.cells[r2 * e.numColumns + c] ?? {};
                w.bl(0);                  /* cell flag */
                w.t('');                  /* tooltip */
                w.bl(0); w.bl(0);         /* custom data flag + count */
                w.bl(0);                  /* not externally linked */
                if (cell.text) {
                  w.bl(1);                /* one content */
                  w.bl(1);                /* content type: value */
                  value(cell.text);
                  w.bl(0);                /* attributes */
                  w.bs(0);                /* no content format */
                } else {
                  w.bl(0);                /* no contents */
                }
                style(1);
                w.bl(0);                  /* style id */
                /* the geometry block every real cell carries; AutoCAD
                   recomputes the real extents on open */
                w.bl(1);                  /* has geometry */
                w.bl(7);                  /* geometry flag */
                w.bd(0.12); w.bd(0.12);   /* width/height incl. gap */
                w.bl(0);                  /* no geometry records */
              }
              w.bl(0); w.bl(0);           /* row custom data flag + count */
              style(2);
              w.bl(r2 === 0 ? 1 : r2 === 1 ? 2 : 3);   /* title/header/data */
              w.bd(e.rowHeights[r2] ?? 1);
            }
            w.bl(0);                      /* field references */
            w.bl(4); w.bl(0);             /* constants in real files */
            const merges: number[][] = [];
            e.cells.forEach((cell, i) => {
              if (!cell) return;
              const sc = cell.spanColumns ?? 1, sr = cell.spanRows ?? 1;
              if (sc <= 1 && sr <= 1) return;
              const row = Math.floor(i / e.numColumns), col = i % e.numColumns;
              merges.push([row, col, row + sr - 1, col + sc - 1]);
            });
            w.bl(merges.length);
            for (const m of merges) { w.bl(m[0]); w.bl(m[1]); w.bl(m[2]); w.bl(m[3]); }
            w.bl(6);                      /* constant in real files */
            const dir = e.direction ?? { x: 1, y: 0, z: 0 };
            w.bd3(dir.x, dir.y, dir.z ?? 0);
            /* break data: no breaks, the whole table as one row range —
               the record is five fields wide (four zeros, then the last
               row index; miscounting it as four leaves the record two
               bits short of its declared size and AutoCAD refuses the
               drawing with ErrorStatus=53) */
            w.bl(0); w.bl(1);
            w.bl(0); w.bl(0); w.bl(0); w.bl(0);
            w.bl(Math.max(0, e.numRows - 1));
          }, (w) => {
            w.h(5, 0);                    /* geometry block header (NULL ok) */
            for (let i = 0; i < e.numRows * e.numColumns; i++) {
              w.h(4, 0);                  /* per-cell geometry object */
            }
            w.h(4, 0);                    /* trailing unknown */
            w.h(5, 0);                    /* table style */
          });
          return;
        }
        /* the pre-R2010 record: a block reference followed by the grid */
        makeEntity(CLS_TABLE, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          if (V >= 2000) w.bb(3);         /* scale flag: all ones */
          else { w.bd(1); w.bd(1); w.bd(1); }
          w.bd(0);                        /* rotation */
          w.bd3(0, 0, 1);                 /* extrusion */
          w.b(0);                         /* no attribs */
          if (V >= 2004) { /* no owned attribs to count */ }
          w.bs(22);                       /* flags for table value (AutoCAD: 22) */
          const dir = e.direction ?? { x: 1, y: 0, z: 0 };
          w.bd3(dir.x, dir.y, dir.z ?? 0);
          w.bl(e.numColumns);
          w.bl(e.numRows);
          for (let i = 0; i < e.numColumns; i++) w.bd(e.columnWidths[i] ?? 1);
          for (let i = 0; i < e.numRows; i++) w.bd(e.rowHeights[i] ?? 1);
          for (let i = 0; i < e.numRows * e.numColumns; i++) {
            const cell = e.cells[i] ?? {};
            w.bs(1);                      /* text cell */
            w.rc(0);                      /* flags */
            w.b(0);                       /* merged */
            w.b(0);                       /* autofit */
            w.bl(cell.spanColumns ?? 1);
            w.bl(cell.spanRows ?? 1);
            w.bd(0);                      /* rotation */
            /* R2007 alone inserts a BD (1.0) after the rotation, and its
               cell content is a full table VALUE rather than a bare
               string: the additional-data flag comes first, then the
               format flags, the data type, the text inline as
               byte-counted UTF-16, the unit type, and finally the two
               string-stream entries (the value's format string and its
               rendered form). Pinned against AutoCAD-minted AC1021
               tables: each 1-character cell is 109 bits, and the walk
               lands on the four override bits exactly, on a 2x2 grid of
               single letters and a 3x2 grid of 1-to-8 character cells. */
            if (V === 2007) {
              w.bd(1);
              w.b(0);                     /* no per-cell overrides */
              w.bl(4);                    /* format flags: value inline */
              w.bl(4);                    /* data type: string */
              const s = cell.text ?? '';
              w.bs((s.length + 1) * 2);   /* bytes, NUL included */
              for (let k = 0; k < s.length; k++) {
                const cu = s.charCodeAt(k);
                w.rc(cu & 0xff); w.rc((cu >> 8) & 0xff);
              }
              w.rc(0); w.rc(0);           /* the terminator */
              w.bl(0);                    /* unit type */
              w.t('');                    /* format string */
              w.t(s);                     /* the rendered form */
            } else {
              w.t(outText(cell.text ?? '')); /* the style handle is below */
              w.b(0);                     /* no per-cell overrides */
            }
          }
          /* the four override-presence flags: table, border colour,
             border lineweight, border visibility. AutoCAD reads them
             unconditionally — omitting them shifts its handle-stream
             parse by four bits and the drawing is refused (splice-proven
             against AutoCAD 2027). */
          w.b(0); w.b(0); w.b(0); w.b(0);
        }, (w) => {
          /* NULL block header and NULL table style are both accepted —
             splice-proven against AutoCAD 2027 (it regenerates the grid
             from the record itself) */
          w.h(5, 0);                      /* block header */
          w.h(5, 0);                      /* table style */
          /* one text-style handle per cell, in cell order — NULL even in
             AutoCAD-authored files */
          for (let i = 0; i < e.numRows * e.numColumns; i++) w.h(5, 0);
        });
        return;
      }

      case 'acis': {
        const typeNum = e.kind === 'region' ? 37 : e.kind === 'solid3d' ? 38 : 39;
        if (V >= 2018 && e.sab && !e.surfaceKind && !acdsSection) {
          /* AC1032: the SAB payload rides the AcDs data section and the
             entity record itself is the empty-inline form AutoCAD's own
             2018 saves carry — written out field by field below.

             The R2013+ record is: the acis-empty flag, the cached
             wireframe block (a base point as 3BD, the isoline count and
             the wire/silhouette counts, empty here), one flag every
             AutoCAD save sets with the material count beside it, then the
             revision block — a present flag, a 16-byte id spelled the way
             a GUID struct is (BL, BS, BS, 8 raw bytes) and a zero BL to
             close it. The two flags are load-bearing: clearing either the
             revision one or the wireframe one is refused with
             ErrorStatus 53. The values are not — the origin, zero counts
             and an id of our own audit 0/0 in AutoCAD 2027, as a 3DSOLID
             and as a BODY singleton and in the full corpus. The record's
             one type-specific handle is the solid-history reference, null
             here (SOLIDHIST off). */
          const blob = fromBase64(e.sab);
          const ds = buildAcDs(handle, blob);
          if (ds) {
            acdsSection = ds;
            makeEntity(typeNum, handle, e, { ...ctx, hasDs: true }, (w) => {
              w.b(1);                     /* acis empty: the blob is in AcDs */
              w.b(1);                     /* wireframe data present */
              w.bd3(0, 0, 0);             /* cached base point: origin */
              w.bl(4);                    /* isolines: the ISOLINES default */
              w.b(1);                     /* isoline data present */
              w.bl(0);                    /* no cached wires */
              w.bl(0);                    /* no cached silhouettes */
              w.b(1);                     /* set in every AutoCAD save */
              w.bl(0);                    /* no per-face materials */
              w.b(1);                     /* revision id present */
              const g = revisionId(handle, blob);
              w.bl(g[0] | (g[1] << 8) | (g[2] << 16) | (g[3] << 24));
              w.bs(g[4] | (g[5] << 8));
              w.bs(g[6] | (g[7] << 8));
              for (let i = 8; i < 16; i++) w.rc(g[i]);
              w.bl(0);                    /* end of the revision block */
            }, (w) => {
              w.h(3, 0);                  /* solid history: none */
            });
            return;
          }
        }
        /* a container without the binary kernel form (pre-2007) takes the
           SAB payload as its SAT text conversion */
        /* AC1032 (R2013+) stores ACIS data in the AcDs data section; the
           branch above carries the first solid's SAB there (proven: the
           singleton opens in AutoCAD 2027 with AUDIT 0/0, while every
           inline form is refused with ErrorStatus 53).
           KNOWN LIMITS: one solid per drawing rides AcDs — buildAcDs
           emits the whole section for a single solid handle, and a
           drawing carries one such section — and AutoCAD only accepts
           modern ASM-format blobs: a pre-ASM "ACIS BinaryFile" payload
           still makes it refuse the drawing, whichever way it is stored.
           Any solid the AcDs branch cannot take falls through to the
           inline SAB below: it round-trips through this library and other
           readers losslessly, which beats discarding the payload. */
        /* the same dialect rule the filter above applies: a payload the
           target's kernel cannot read inline leaves as SAT text */
        const sabInline = !!e.sab && (isAsmSab(e.sab) ? V >= 2013 : V >= 2007);
        const sat = e.sat
          ?? (e.sab && !sabInline ? sabToSat(e.sab) ?? undefined : undefined);
        /** What follows the kernel payload from R2007 on: the cached
         *  wireframe block AutoCAD writes on every save. Our reader stops
         *  at the payload's end marker and never consumed it, so the
         *  writer never emitted it — and AutoCAD refuses the record
         *  without it, exactly as it refuses the R2018 inline form. Same
         *  fields the AcDs branch above writes, minus the R2013 revision
         *  block. */
        const acisTail = (w: BitWriter, afterPayload: boolean): void => {
          if (V < 2007) return;
          /* one flag closes the kernel payload before the cache block —
             recovered by fitting the field sequence to genuine AC1021
             records: every one of them reads B B 3BD BL B BL BL B BL from
             the payload's end marker and lands exactly on the string flag,
             with the values [1, 1, basepoint, 4, 1, 0, 0, 1, 0]. */
          if (afterPayload) w.b(1);
          w.b(1);                         /* wireframe data present */
          w.bd3(0, 0, 0);                 /* cached base point: origin */
          w.bl(4);                        /* isolines: the ISOLINES default */
          w.b(1);                         /* isoline data present */
          w.bl(0);                        /* no cached wires */
          w.bl(0);                        /* no cached silhouettes */
          w.b(1);                         /* set in every AutoCAD save */
          w.bl(0);                        /* no per-face materials */
        };
        makeEntity(typeNum, handle, e, ctx, (w) => {
          if (!sat) {
            if (!e.sab) { w.b(1); acisTail(w, false); return; }  /* empty */
            /* R2007 introduced the binary kernel form; the blob already
               carries its own end marker, which is what bounds it.
               It starts on the very next BIT after the version field —
               not on a byte boundary. Measured on genuine AC1021 records
               (the magic lands at bit 114, 452 and 534 of three records,
               each exactly ten bits — one BS(2) — past the version), and
               AutoCAD 2027 refuses the byte-aligned spelling. Our own
               reader hid this: it probes 64 bit offsets for the magic
               rather than trusting the framing. */
            w.b(0); w.b(0);
            w.bs(2);
            for (const byte of fromBase64(e.sab)) w.rc(byte);
            acisTail(w, true);
            return;
          }
          w.b(0);                         /* not empty */
          w.b(0);                         /* unknown */
          w.bs(1);                        /* version 1: SAT */
          const ciphered: number[] = [];
          for (let i = 0; i < sat.length; i++) {
            const c = sat.charCodeAt(i) & 0xff;
            ciphered.push(c <= 32 ? c : (159 - c) & 0xff);
          }
          w.bl(ciphered.length);
          for (const c of ciphered) w.rc(c);
          w.bl(0);                        /* terminator */
          acisTail(w, false);
        });
        return;
      }

      case 'mesh': {
        /* heavy polyline family: vertices + faces are chained entities */
        const isGrid = e.meshKind === 'grid';
        const vertHs = e.vertices.map(() => H());
        const faceHs = (!isGrid ? (e.faces ?? []) : []).map(() => H());
        const chainHs = [...vertHs, ...faceHs];
        const seqendH = H();
        makeEntity(isGrid ? 30 : 29, handle, e, ctx, (w) => {
          if (isGrid) {
            w.bs((e.closedM ? 1 : 0) | 16 | (e.closedN ? 32 : 0));
            w.bs(0);                      /* curve type */
            w.bs(e.mSize ?? e.vertices.length);
            w.bs(e.nSize ?? 1);
            w.bs(0); w.bs(0);             /* densities */
          } else {
            w.bs(e.vertices.length);
            w.bs(e.faces?.length ?? 0);
          }
          if (V >= 2004) w.bl(chainHs.length);
        }, (w) => {
          if (V < 2004) {
            w.h(4, chainHs[0] ?? 0);      /* first vertex */
            w.h(4, chainHs[chainHs.length - 1] ?? 0);
          } else {
            for (const vh of chainHs) w.h(4, vh);
          }
          w.h(3, seqendH);
        });
        const vType = isGrid ? 12 : 13;
        e.vertices.forEach((p, i) => {
          const fake: Entity = {
            type: 'point', layer: e.layer, color: { kind: 'byLayer' },
            position: p
          };
          makeEntity(vType, vertHs[i], fake, {
            entmode: 0, owner: handle,
            prev: chainHs[i - 1] ?? 0, next: chainHs[i + 1] ?? 0
          }, (w) => {
            w.rc(isGrid ? 64 : 192);      /* vertex flags */
            w.bd3(p.x, p.y, p.z ?? 0);
          });
        });
        if (!isGrid) {
          (e.faces ?? []).forEach((f, k) => {
            const i = vertHs.length + k;
            const fake: Entity = {
              type: 'point', layer: e.layer, color: { kind: 'byLayer' },
              position: { x: 0, y: 0, z: 0 }
            };
            makeEntity(14, faceHs[k], fake, {
              entmode: 0, owner: handle,
              prev: chainHs[i - 1] ?? 0, next: chainHs[i + 1] ?? 0
            }, (w) => {
              for (let j = 0; j < 4; j++) w.bs(f[j] ?? 0);
            });
          });
        }
        {
          const fake: Entity = {
            type: 'point', layer: e.layer, color: { kind: 'byLayer' },
            position: { x: 0, y: 0, z: 0 }
          };
          makeEntity(6, seqendH, fake, { entmode: 0, owner: handle },
            () => { /* SEQEND: no data */ });
        }
        return;
      }

      case 'image': {
        const key = (e.path ?? '') + '|' + e.widthPx + 'x' + e.heightPx;
        let defH = imageDefH.get(key);
        if (defH === undefined) imageDefH.set(key, defH = H());
        makeEntity(e.wipeout ? CLS_WIPEOUT : CLS_IMAGE, handle, e, ctx, (w) => {
          w.bl(0);                        /* class version */
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          w.bd3(e.uVector.x, e.uVector.y, e.uVector.z ?? 0);
          w.bd3(e.vVector.x, e.vVector.y, e.vVector.z ?? 0);
          w.rd(e.widthPx); w.rd(e.heightPx);
          w.bs(3);                        /* display props */
          w.b(e.clip?.length ? 1 : 0);
          w.rc(e.brightness ?? 50);
          w.rc(e.contrast ?? 50);
          w.rc(e.fade ?? 0);
          if (V >= 2018) w.b(0);          /* clip mode (2010+) */
          const clip = e.clip?.length ? e.clip
            : [{ x: -0.5, y: -0.5 }, { x: e.widthPx - 0.5, y: e.heightPx - 0.5 }];
          w.bs(clip.length === 2 ? 1 : 2);
          if (clip.length !== 2) w.bl(clip.length);
          for (const p of clip) { w.rd(p.x); w.rd(p.y); }
        }, (w) => {
          w.h(5, defH!);                  /* imagedef */
          w.h(3, 0);                      /* imagedef reactor */
        });
        return;
      }

      case 'spline': {
        makeEntity(36, handle, e, ctx, (w) => {
          const hasCtrl = e.controlPoints.length >= 2;
          if (hasCtrl) {
            w.bl(1);                      /* scenario: full spline */
            if (V >= 2018) { w.bl(0); w.bl(0); }   /* flags1, knotparam */
            w.bl(e.degree > 0 ? e.degree : 3);
            w.b(e.weights?.length ? 1 : 0);
            w.b(e.closed ? 1 : 0);
            w.b(0);                       /* periodic */
            w.bd(1e-7); w.bd(1e-7);       /* tolerances */
            w.bl(e.knots.length);
            w.bl(e.controlPoints.length);
            w.b(e.weights?.length ? 1 : 0);
            for (const k of e.knots) w.bd(k);
            e.controlPoints.forEach((p, i) => {
              w.bd3(p.x, p.y, p.z ?? 0);
              if (e.weights?.length) w.bd(e.weights[i] ?? 1);
            });
          } else {
            w.bl(2);                      /* scenario: fit points */
            if (V >= 2018) { w.bl(1); w.bl(0); }   /* flags1 (fit), knotparam */
            w.bl(e.degree > 0 ? e.degree : 3);
            w.bd(1e-7);
            w.bd3(0, 0, 0); w.bd3(0, 0, 0);
            w.bl(e.fitPoints?.length ?? 0);
            for (const p of e.fitPoints ?? []) w.bd3(p.x, p.y, p.z ?? 0);
          }
        });
        return;
      }
      case 'proxy': {
        /* Passthrough. The record is rebuilt around the retained pieces:
           our own common data and handle links, then the application
           payload bit-for-bit and the reference list code-for-code as the
           source file carried them. The class id points at the CLASSES
           record emitted for the original application class, so a reader
           still knows what the object was. */
        const key = e.appClass?.dxfName ?? e.sourceType ?? 'ACAD_PROXY_ENTITY';
        const cls = proxyClsH.get(key);
        makeEntity(0x1f2, handle, e, ctx, (w) => {
          w.bl(cls?.num ?? 0x1f2);
          w.bl(e.proxyVersion ?? 0);
          if (V >= 2018) w.bl(e.proxyMaint ?? 0);
          if (V >= 2000) w.b(e.fromDxf ? 1 : 0);
          if (e.data && e.dataBits) w.putBits(fromBase64(e.data), e.dataBits);
        }, (w) => {
          for (const ref of e.refs ?? []) {
            w.h(ref.code, parseInt(ref.value, 16) || 0);
          }
        }, e.graphicsData ? fromBase64(e.graphicsData) : undefined);
        return;
      }
      case 'unknown': {
        /* Universal passthrough. Bits sealed in this target's own
           encoding generation go out as the native record (original
           fixed type, or the re-emitted application class). Bits from a
           foreign generation travel wrapped in a proxy record — the
           format's own idiom for data the host release cannot hold —
           tagged with their generation, and unwrap back to the native
           form the next time the generations match (A→B→A). */
        if (!e.data && !e.graphicsData) { skipped.push(e.sourceType); return; }
        const graphics = e.graphicsData ? fromBase64(e.graphicsData) : undefined;
        const refs = (w: BitWriter): void => {
          for (const ref of e.refs ?? []) {
            w.h(ref.code, parseInt(ref.value, 16) || 0);
          }
        };
        const key = e.appClass?.dxfName ?? e.sourceType;
        if (e.encoding === encodingGroup(V) || e.data === undefined) {
          const typeNum = e.typeCode ?? proxyClsH.get(key)?.num ?? 0x1f2;
          makeEntity(typeNum, handle, e, ctx, (w) => {
            if (e.data && e.dataBits) w.putBits(fromBase64(e.data), e.dataBits);
            if (e.strData && e.strBits) {
              w.strTarget?.putBits(fromBase64(e.strData), e.strBits);
            }
          }, refs, graphics);
        } else {
          makeEntity(0x1f2, handle, e, ctx, (w) => {
            w.bl(e.typeCode === undefined ? (proxyClsH.get(key)?.num ?? 0) : 0);
            w.bl((SEAL_MAGIC | (e.encoding ?? 0)) >>> 0);
            if (V >= 2018) w.bl(0);
            if (V >= 2000) w.b(0);
            w.rl(e.dataBits ?? 0);
            if (e.data && e.dataBits) w.putBits(fromBase64(e.data), e.dataBits);
            w.rl(e.strBits ?? 0);
            if (e.strData && e.strBits) {
              w.putBits(fromBase64(e.strData), e.strBits);
            }
          }, refs, graphics);
        }
        return;
      }
      case 'ole': {
        /* OLE2FRAME. The frame corners live in the first 0x62 bytes of the
           payload, ahead of the compound document; an entity built by hand
           (no retained payload) gets that header synthesized from its
           corners so the frame still displays. */
        let data: Uint8Array;
        if (e.data && e.data.length >= 0x62) {
          data = e.data;
        } else {
          data = new Uint8Array(0x62 + (e.data?.length ?? 0));
          const dv = new DataView(data.buffer);
          dv.setUint16(0, 2, true);       /* frame version word */
          e.corners.forEach((c, i) => {
            dv.setFloat64(2 + i * 24, c.x, true);
            dv.setFloat64(10 + i * 24, c.y, true);
            dv.setFloat64(18 + i * 24, c.z ?? 0, true);
          });
          if (e.data) data.set(e.data, 0x62);
        }
        makeEntity(74, handle, e, ctx, (w) => {
          w.bs(e.oleType ?? 2);
          if (V >= 2000) w.bs(e.tileMode ?? 1);
          w.bl(data.length);
          w.raw(data);
          if (V >= 2000) w.rc(e.lockAspect ? 1 : 0);
        });
        return;
      }
      default:
        skipped.push(e.type);
    }
  };

  /* ---- table records ---- */

  /** Name and xref state, the head of every table record.
   *
   *  R13-R2004 spell this out as three fields: the "used 64" flag, the
   *  xref index, and the xref-dependent flag. R2007 collapsed them into a
   *  single short. Writing the older, wider form into an R2007 file leaves
   *  the stream two bits out of step, which quietly corrupts the flag word
   *  and the colour that follow — so the width has to track the version. */
  /* R13/R14 symbol names are NUL-terminated C strings, and the built-in
     names are stored uppercase — AutoCAD's own R14 output spells
     "*ACTIVE\0", "CONTINUOUS\0", "*MODEL_SPACE\0". User names keep their
     case (AutoCAD stashes the original in an EXTNAMES EED; readers accept
     the record name as-is). */
  const R14_UPPER = new Set(['*active', '*model_space', '*paper_space',
    'standard', 'continuous', 'bylayer', 'byblock', 'acad']);
  const r14Name = (name: string): string => {
    if (V > 14) return name;
    const n = R14_UPPER.has(name.toLowerCase()) ? name.toUpperCase() : name;
    return V === 14 ? n + '\0' : n;
  };
  /** R14 inline strings are C strings: every non-empty one AutoCAD writes
   *  ends in NUL — fonts, linetype descriptions, dictionary keys
   *  (value-walked against AutoCAD-minted refR14.dwg). R13 does NOT: the
   *  vintage AC1012 reference stores "BYBLOCK" as TV length 7 with no
   *  terminator where its R14 twin stores length 8 and a trailing zero.
   *  Writing the R14 form under an AC1012 signature is what made every
   *  R13 file we have ever produced fail to load (ErrorStatus 53) while
   *  the byte-identical AC1014 relabel opened clean. */
  const r14Str = (s: string): string => V === 14 && s ? s + '\0' : s;

  /** Symbol names and dictionary keys. R2007+ strings are native UTF-16,
   *  and AutoCAD 2027 audits any name it has to normalize — a literal
   *  \U+XXXX escape or an Arabic presentation form is renamed on AUDIT
   *  ("Un-normalized symbol name") — so names travel raw there. The
   *  codepage containers keep the escaped/shaped legacy spelling, which
   *  the same AutoCAD audits clean. */
  const nameText = (s: string): string => V >= 2007 ? s : outText(s);

  const tableFlags = (w: BitWriter, name: string): void => {
    w.t(nameText(r14Name(name)));
    if (V <= 2004) {
      /* the "used" 64-flag: AutoCAD writes 1 on every record it mints
         (bit-walked in refR14.dwg and ref2000.dwg) */
      w.b(1);
      w.bs(0);                            /* xrefindex + 1 */
      w.b(0);                             /* xref dependent */
    } else {
      w.bs(0);                            /* is_xref_resolved */
    }
  };

  const makeLayer = (ly: Layer): void => {
    makeObject(51, layerH.get(ly.name)!, (w) => {
      tableFlags(w, ly.name);
      if (V <= 14) {
        /* R13/R14 spell the layer's state out as four separate bits
         * rather than packing it into one short. */
        w.b(ly.frozen ? 1 : 0);
        w.b(ly.on === false ? 1 : 0);
        w.b(0);                           /* frozen in new viewports */
        w.b(ly.locked ? 1 : 0);
      } else {
        let f = 0;
        if (ly.frozen) f |= 1;
        if (ly.locked) f |= 8;
        if (ly.plottable !== false) f |= 16;
        f |= (lwCode(ly.lineweight) & 0x1f) << 5;
        if (ly.on === false) f |= 2;      /* the flag word carries off too */
        w.bs(f);
      }
      /* Layer colour. Through R2000 it is a bare signed index — negative
       * means the layer is off. From R2004 it is a full CMC: the index,
       * then a dword whose top byte says how to read the rest (0xC2 true
       * colour, 0xC3 an index in the low byte), then a byte of name flags.
       * Writing the bare form into an R2004 file desynchronises everything
       * the reader takes after it, so the two must agree exactly. */
      const aci = ly.color.kind === 'aci' ? (ly.color.index & 0xff)
        : ly.color.kind === 'byBlock' ? 0 : 7;
      /* The negative-index "off" convention is a DXF spelling only. In the
         DWG record the off state lives in the flag word (bit 2, written
         above) and the index stays positive: AutoCAD 2027's own R2000 save
         of an off layer carries flags ...10 with color +30, and its audit
         flags a negative index as "Color Out of Range" at R14 and R2000
         alike (value-walked against refoff2000.dwg). */
      w.bs(aci);
      if (V >= 2004) {
        w.bl(ly.color.kind === 'rgb'
          ? (0xc2000000 | (ly.color.rgb & 0xffffff)) >>> 0
          : (0xc3000000 | aci) >>> 0);
        w.rc(0);                          /* no colour-book name follows */
      }
    }, (w) => {
      w.h(4, layerControl);               /* owner */
      if (V < 2004) w.h(3, 0);            /* xdict */
      w.h(5, 0);                          /* xref block (from tableFlags) */
      if (V >= 2000) w.h(5, 0);           /* plotstyle — R2000 and later */
      if (V >= 2007) w.h(5, 0);           /* material */
      const lt = ly.linetype && ltypeH.get(ly.linetype);
      w.h(5, lt || ltContinuous);         /* linetype */
      if (V >= 2018) w.h(5, 0);           /* unknown trailing (R2013+) */
    });
  };

  const makeStyle = (st: TextStyle): void => {
    makeObject(53, styleH.get(st.name)!, (w) => {
      tableFlags(w, st.name);
      w.b(0); w.b(0);                     /* shape, vertical */
      w.bd(st.fixedHeight ?? 0);
      w.bd(st.widthFactor ?? 1);
      w.bd(0);                            /* oblique */
      w.rc(0);                            /* generation */
      w.bd(2.5);                          /* last height */
      w.t(outText(r14Str(st.font ?? 'txt')));
      w.t(outText(r14Str(st.bigFont ?? '')));
    }, (w) => {
      w.h(4, styleControl);
      if (V < 2004) w.h(3, 0);
      w.h(5, 0);                          /* xref */
    });
  };

  const makeLtype = (name: string, h: number, lt?: Linetype): void => {
    makeObject(57, h, (w) => {
      tableFlags(w, name);
      w.t(outText(r14Str(lt?.description ?? '')));
      const pattern = lt?.pattern ?? [];
      w.bd(pattern.reduce((s, d) => s + Math.abs(d), 0));
      w.rc(65);                           /* alignment 'A' */
      w.rc(pattern.length);
      for (const d of pattern) {
        w.bd(d);
        w.bs(0);                          /* shape code */
        w.rd(0); w.rd(0);                 /* offsets */
        w.bd(0);                          /* scale */
        w.bd(0);                          /* rotation */
        w.bs(0);                          /* shape flag */
      }
      /* the 256-byte strings area is unconditional through R2004 only;
         R2007+ writes a (512-byte) area only when a dash carries the text
         flag — ours never do, and AutoCAD's own R2018 files omit it */
      if (V <= 2004) for (let i = 0; i < 256; i++) w.rc(0);
    }, (w) => {
      w.h(4, ltypeControl);
      if (V < 2004) w.h(3, 0);
      w.h(5, 0);                          /* xref */
      for (const d of lt?.pattern ?? []) { void d; w.h(5, 0); }  /* per-dash style */
    });
  };

  const makeAppid = (): void => {
    makeObject(67, appidAcad, (w) => {
      tableFlags(w, 'ACAD');
      w.rc(0);                            /* unknown */
    }, (w) => {
      w.h(4, appidControl);
      if (V < 2004) w.h(3, 0);
      w.h(5, 0);
    });
  };

  /** DIMSTYLE table record. Layouts bit-walked out of AutoCAD-minted
   *  files (refR14.dwg / ref2000.dwg): the R13/R14 record is the header's
   *  dim-block shape (11 B flags, RC pairs, six BS, seventeen BD, five
   *  texts, three BS colours); R2000+ is the header's 2000+ dim-var order.
   *  Both end with one unknown flag bit (0 in every minted record) before
   *  the handle stream, and both are marked "used" (the 64-flag) — AutoCAD
   *  writes 1 there for every DIMSTYLE. Defaults are the minted STANDARD
   *  values, overridden by the style's decoded DXF variables. */
  const makeDimStyle = (ds: DimStyle): void => {
    const vars = ds.vars ?? {};
    const num = (k: string, dflt: number): number => {
      const x = vars[k];
      return typeof x === 'number' && Number.isFinite(x) ? x : dflt;
    };
    const iv = (k: string, dflt: number): number => Math.round(num(k, dflt));
    const flag = (k: string, dflt = 0): number => {
      const x = vars[k];
      return x === undefined ? dflt : (x ? 1 : 0);
    };
    const txt = (k: string): string =>
      r14Str(typeof vars[k] === 'string' ? vars[k] as string : '');
    /* CMC colour: bare BS index through R2000, method dword from R2004 */
    const clr = (w: BitWriter, k: string): void => {
      const idx = iv(k, 0) & 0xff;
      if (V <= 2000) { w.bs(idx); return; }
      w.bs(0);
      w.bl((idx ? 0xc3000000 | idx : 0xc1000000) >>> 0);
      w.rc(0);
    };
    const txstyName = typeof vars.DIMTXSTY === 'string' ? vars.DIMTXSTY : '';
    const txsty = styleH.get(txstyName)
      ?? styleH.get('Standard') ?? [...styleH.values()][0];
    makeObject(69, dimStyleH.get(ds.name.toLowerCase())!, (w) => {
      tableFlags(w, ds.name);
      if (V <= 14) {
        w.b(flag('DIMTOL')); w.b(flag('DIMLIM'));
        w.b(flag('DIMTIH', 1)); w.b(flag('DIMTOH', 1));
        w.b(flag('DIMSE1')); w.b(flag('DIMSE2'));
        w.b(flag('DIMALT')); w.b(flag('DIMTOFL'));
        w.b(flag('DIMSAH')); w.b(flag('DIMTIX')); w.b(flag('DIMSOXD'));
        w.rc(iv('DIMALTD', 2)); w.rc(iv('DIMZIN', 0));
        w.b(flag('DIMSD1')); w.b(flag('DIMSD2'));
        w.rc(iv('DIMTOLJ', 1)); w.rc(iv('DIMJUST', 0)); w.rc(iv('DIMFIT', 3));
        w.b(flag('DIMUPT'));
        w.rc(iv('DIMTZIN', 0)); w.rc(iv('DIMALTZ', 0));
        w.rc(iv('DIMALTTZ', 0)); w.rc(iv('DIMTAD', 0));
        w.bs(iv('DIMUNIT', 2)); w.bs(iv('DIMAUNIT', 0));
        w.bs(iv('DIMDEC', 4)); w.bs(iv('DIMTDEC', 4));
        w.bs(iv('DIMALTU', 2)); w.bs(iv('DIMALTTD', 2));
        w.bd(num('DIMSCALE', 1)); w.bd(num('DIMASZ', 0.18));
        w.bd(num('DIMEXO', 0.0625)); w.bd(num('DIMDLI', 0.38));
        w.bd(num('DIMEXE', 0.18)); w.bd(num('DIMRND', 0));
        w.bd(num('DIMDLE', 0)); w.bd(num('DIMTP', 0)); w.bd(num('DIMTM', 0));
        w.bd(num('DIMTXT', 0.18)); w.bd(num('DIMCEN', 0.09));
        w.bd(num('DIMTSZ', 0)); w.bd(num('DIMALTF', 25.4));
        w.bd(num('DIMLFAC', 1)); w.bd(num('DIMTVP', 0));
        w.bd(num('DIMTFAC', 1)); w.bd(num('DIMGAP', 0.09));
        w.t(outText(txt('DIMPOST'))); w.t(outText(txt('DIMAPOST')));
        w.t(outText(txt('DIMBLK'))); w.t(outText(txt('DIMBLK1')));
        w.t(outText(txt('DIMBLK2')));
        w.bs(iv('DIMCLRD', 0)); w.bs(iv('DIMCLRE', 0)); w.bs(iv('DIMCLRT', 0));
      } else {
        w.t(outText(txt('DIMPOST'))); w.t(outText(txt('DIMAPOST')));
        w.bd(num('DIMSCALE', 1)); w.bd(num('DIMASZ', 0.18));
        w.bd(num('DIMEXO', 0.0625)); w.bd(num('DIMDLI', 0.38));
        w.bd(num('DIMEXE', 0.18)); w.bd(num('DIMRND', 0));
        w.bd(num('DIMDLE', 0)); w.bd(num('DIMTP', 0)); w.bd(num('DIMTM', 0));
        if (V >= 2007) {
          w.bd(num('DIMFXL', 1));
          w.bd(num('DIMJOGANG', 0.7853981633974483));
          w.bs(iv('DIMTFILL', 0));
          w.bs(0); w.bl(0xc1000000); w.rc(0);   /* DIMTFILLCLR: ByBlock */
        }
        w.b(flag('DIMTOL')); w.b(flag('DIMLIM'));
        w.b(flag('DIMTIH', 1)); w.b(flag('DIMTOH', 1));
        w.b(flag('DIMSE1')); w.b(flag('DIMSE2'));
        w.bs(iv('DIMTAD', 0)); w.bs(iv('DIMZIN', 0)); w.bs(iv('DIMAZIN', 0));
        if (V >= 2007) w.bs(iv('DIMARCSYM', 0));
        w.bd(num('DIMTXT', 0.18)); w.bd(num('DIMCEN', 0.09));
        w.bd(num('DIMTSZ', 0)); w.bd(num('DIMALTF', 25.4));
        w.bd(num('DIMLFAC', 1)); w.bd(num('DIMTVP', 0));
        w.bd(num('DIMTFAC', 1)); w.bd(num('DIMGAP', 0.09));
        w.bd(num('DIMALTRND', 0));
        w.b(flag('DIMALT')); w.bs(iv('DIMALTD', 2));
        w.b(flag('DIMTOFL')); w.b(flag('DIMSAH'));
        w.b(flag('DIMTIX')); w.b(flag('DIMSOXD'));
        clr(w, 'DIMCLRD'); clr(w, 'DIMCLRE'); clr(w, 'DIMCLRT');
        w.bs(iv('DIMADEC', 0)); w.bs(iv('DIMDEC', 4)); w.bs(iv('DIMTDEC', 4));
        w.bs(iv('DIMALTU', 2)); w.bs(iv('DIMALTTD', 2));
        w.bs(iv('DIMAUNIT', 0)); w.bs(iv('DIMFRAC', 0));
        w.bs(iv('DIMLUNIT', 2)); w.bs(iv('DIMDSEP', 46));
        w.bs(iv('DIMTMOVE', 0)); w.bs(iv('DIMJUST', 0));
        w.b(flag('DIMSD1')); w.b(flag('DIMSD2'));
        w.bs(iv('DIMTOLJ', 1)); w.bs(iv('DIMTZIN', 0));
        w.bs(iv('DIMALTZ', 0)); w.bs(iv('DIMALTTZ', 0));
        w.b(flag('DIMUPT')); w.bs(iv('DIMATFIT', 3));
        if (V >= 2007) w.b(flag('DIMFXLON'));
        if (V >= 2010) {
          w.b(0);                       /* DIMTXTDIRECTION */
          w.bd(num('DIMALTMZF', 100)); w.t('');   /* DIMALTMZF/MZS */
          w.bd(num('DIMMZF', 100)); w.t('');      /* DIMMZF/MZS */
        }
        w.bs(iv('DIMLWD', -2)); w.bs(iv('DIMLWE', -2));
      }
      w.b(0);                           /* unknown flag bit, always 0 */
    }, (w) => {
      w.h(4, dimstyleControl);
      if (V < 2004) w.h(3, 0);          /* xdict */
      w.h(5, 0);                        /* xref block */
      w.h(5, txsty);                    /* DIMTXSTY */
      if (V >= 2000) {
        w.h(5, 0); w.h(5, 0); w.h(5, 0); w.h(5, 0);   /* DIMLDRBLK, DIMBLK/1/2 */
      }
      if (V >= 2007) { w.h(5, 0); w.h(5, 0); w.h(5, 0); }   /* DIMLTYPE, DIMLTEX1/2 */
    });
  };

  /** The MLINESTYLE "STANDARD" object — present in every real file,
   *  owned by the ACAD_MLINESTYLE dictionary. Values mirrored from
   *  AutoCAD-minted refs (refR14, ref2004, ref2018): no fill, 90° end
   *  caps, two elements at ±0.5 with ByLayer colour and the BYLAYER
   *  linetype (index 32767 through R2013, a linetype handle per element
   *  from R2018 on — 155 genuine AC1021/AC1024/AC1027 files carry the
   *  index in the data stream and nothing in the handle stream). The
   *  colour takes the 2004+ CMC spelling — index 0
   *  plus the 0xC0 "ByLayer" method dword — where the container does. */
  const makeMlineStandard = (): void => {
    const byLayerCmc = (w: BitWriter): void => {
      if (V >= 2004) { w.bs(0); w.bl(0xc0000000); w.rc(0); }
      else w.bs(256);
    };
    makeObject(73, mlineStandardH, (w) => {
      w.t(outText(r14Name('STANDARD')));   /* real files spell it uppercase */
      w.t('');                          /* description */
      w.bs(0);                          /* flags */
      byLayerCmc(w);                    /* fill colour */
      w.bd(Math.PI / 2); w.bd(Math.PI / 2);   /* start / end angle */
      w.rc(2);
      for (const off of [0.5, -0.5]) {
        w.bd(off);
        byLayerCmc(w);                  /* element colour */
        if (V < 2018) w.bs(32767);      /* linetype index: BYLAYER */
      }
    }, (w) => {
      w.h(4, mlineDict);                /* owner */
      if (V < 2004) w.h(3, 0);          /* xdict (2004+ says "missing") */
      if (V >= 2018) { w.h(5, ltBylayer); w.h(5, ltBylayer); }
    });
  };

  /** The MLEADERSTYLE "Standard" object — the record every MULTILEADER's
   *  style handle must resolve to (AutoCAD 2027 audits a null style:
   *  "found 1 fixed 1" on an otherwise clean singleton). Field-walked
   *  bit-for-bit against the Standard style in an AutoCAD 2027 save
   *  (famD_2018.dwg: the walk consumes its data stream to the exact bit).
   *  Values are AutoCAD's own defaults: mtext content, two-point
   *  straight leaders, ByBlock colours and linetype, 0.09 landing gap,
   *  0.36 dogleg, 0.18 arrowhead/text height, 0.125 break size. */
  const makeMLeaderStyleStandard = (): void => {
    const byBlockCmc = (w: BitWriter): void => {
      if (V >= 2004) { w.bs(0); w.bl(0xC1000000); w.rc(0); }
      else w.bs(0);
    };
    makeObject(CLS_MLEADERSTYLE, mleaderStyleH, (w) => {
      if (V >= 2010) w.bs(2);           /* class version */
      w.bs(2);                          /* content type: mtext */
      w.bs(1);                          /* draw-mleader order */
      w.bs(0);                          /* draw-leader order */
      w.bl(2);                          /* max leader points */
      w.bd(0); w.bd(0);                 /* first/second segment angles */
      w.bs(1);                          /* leader type: straight */
      byBlockCmc(w);                    /* line colour */
      w.bl(-2);                         /* lineweight: ByBlock */
      w.b(1);                           /* landing enabled */
      w.bd(0.09);                       /* landing gap */
      w.b(1);                           /* dogleg enabled */
      w.bd(0.36);                       /* dogleg length */
      w.t('Standard');                  /* description */
      w.bd(0.18);                       /* arrowhead size */
      w.t('');                          /* default mtext contents */
      w.bs(1); w.bs(1);                 /* attachment left / right */
      w.bs(1);                          /* text angle type */
      w.bs(0);                          /* text alignment type */
      byBlockCmc(w);                    /* text colour */
      w.bd(0.18);                       /* text height */
      w.b(0);                           /* text frame */
      w.b(0);                           /* text always left */
      w.bd(0.18);                       /* align space */
      byBlockCmc(w);                    /* block colour */
      w.bd(1); w.bd(1); w.bd(1);        /* block scale */
      w.b(1);                           /* use block scale */
      w.bd(0);                          /* block rotation */
      w.b(1);                           /* use block rotation */
      w.bs(0);                          /* block connection */
      w.bd(1);                          /* overall scale */
      w.b(0);                           /* property changed */
      w.b(0);                           /* annotative */
      w.bd(0.125);                      /* break size */
      if (V >= 2010) { w.bs(0); w.bs(9); w.bs(9); }  /* attach dir/top/bottom */
      if (V >= 2013) w.b(0);            /* extended text */
    }, (w) => {
      w.h(4, mleaderDictH);             /* owner */
      if (V < 2004) w.h(3, 0);          /* xdict */
      w.h(5, ltByblock);                /* leader linetype */
      w.h(5, 0);                        /* arrowhead: default */
      w.h(5, styleH.get('Standard') ?? [...styleH.values()][0]);
      w.h(5, 0);                        /* block content */
    });
  };

  const makeBlockHeader = (
    h: number, name: string, blockEnt: number, endblkEnt: number,
    ownedEnts: number[], base = { x: 0, y: 0, z: 0 }, layoutHandle = 0
  ): void => {
    makeObject(49, h, (w) => {
      tableFlags(w, name);
      /* the two space blocks start with '*' but are NOT anonymous —
         AutoCAD's audit flags them when marked so */
      w.b(name.startsWith('*')
        && !/^\*(model_space|paper_space)/i.test(name) ? 1 : 0);
      w.b(0);                             /* has attdefs */
      w.b(0);                             /* xref */
      w.b(0);                             /* overlaid */
      if (V >= 2000) w.b(0);              /* loaded (R2000+) */
      if (V >= 2004) w.bl(ownedEnts.length);
      w.bd3(base.x, base.y, base.z ?? 0);
      w.t('');                            /* xref path */
      if (V >= 2000) {
        /* R2000 additions — a real R14 BLOCK_HEADER ends at the xref
           path (decode-gap 0 against AutoCAD-minted R14) */
        w.rc(0);                          /* insert-count run terminator */
        w.t('');                          /* description */
        w.bl(0);                          /* preview size */
      }
      /* units/explodable/scaling close the record — AFTER the preview,
         not before the base point (real 2018 files decode with zero gap
         there; the old placement overran AutoCAD's parse into the handle
         stream, ErrorStatus 53) */
      if (V >= 2007) { w.bs(0); w.b(1); w.rc(0); }
    }, (w) => {
      w.h(4, blockControl);
      if (V < 2004) w.h(3, 0);            /* xdict */
      w.h(5, 0);                          /* xref */
      w.h(3, blockEnt);                   /* block begin entity */
      if (V < 2004) {
        w.h(4, ownedEnts[0] ?? 0);        /* first entity in chain */
        w.h(4, ownedEnts[ownedEnts.length - 1] ?? 0);
      } else {
        for (const eh of ownedEnts) w.h(4, eh);
      }
      w.h(3, endblkEnt);                  /* endblk */
      if (V >= 2000) w.h(5, layoutHandle);   /* layout (R2000+) */
    });
  };

  /** BLOCK / ENDBLK structural entities (entmode 0, owned by their BH). */
  /** entmode for a block's BLOCK/ENDBLK: the two space blocks imply their
   *  owner (2 model, 1 paper — AutoCAD writes no owner handle for them);
   *  user blocks link explicitly. */
  const spaceEntmode = (owner: number): number =>
    owner === msBH ? 2 : owner === psBH ? 1 : 0;
  const makeBlockEnt = (h: number, owner: number, name: string): void => {
    const fake: Entity = {
      type: 'unknown', sourceType: 'BLOCK', layer: layers[0].name,
      color: { kind: 'byLayer' }
    };
    const em = spaceEntmode(owner);
    makeEntity(4, h, fake, { entmode: em, owner: em === 0 ? owner : undefined }, (w) => {
      w.t(nameText(r14Name(name)));
    });
  };
  const makeEndblk = (h: number, owner: number): void => {
    const fake: Entity = {
      type: 'unknown', sourceType: 'ENDBLK', layer: layers[0].name,
      color: { kind: 'byLayer' }
    };
    const em = spaceEntmode(owner);
    makeEntity(5, h, fake, { entmode: em, owner: em === 0 ? owner : undefined },
      () => { /* no data */ });
  };

  /* ---- control objects ---- */

  /** Control object: BL count, then INLINE handles (R2000 layout). */
  const makeControl = (
    type: number, handle: number, entries: number[],
    tail?: (w: BitWriter) => void
  ): void => {
    const w = new BitWriter();
    let sizePos = objectPrologue(w, type);
    const sw = withStrings(w);
    w.h(0, handle);
    w.bs(0);                              /* EED */
    if (V <= 14) { sizePos = w.pos; w.rl(0); }  /* handle-stream position */
    w.bl(0);                              /* reactors */
    if (V >= 2004) w.b(1);                /* xdict missing */
    if (V >= 2018) w.b(0);                /* has_ds_data (2013+) */
    w.bl(entries.length);
    /* the R2000+ DIMSTYLE control carries an extra RC: the count of
       additional code-5 style handles that follow the entries (AutoCAD's
       own files duplicate every entry there; zero is valid and what we
       register). R13/R14 have no such field — a bit-walk of an
       AutoCAD-minted R14 control ends right after the entry count. */
    if (type === 68 && V >= 2000) w.rc(0);
    const bitsize = closeData(w, sw);
    if (sizePos >= 0) w.patchRl(sizePos, bitsize);
    w.h(4, 0);                            /* owner (null) */
    if (V < 2004) w.h(3, 0);              /* xdict */
    for (const h of entries) w.h(2, h);
    tail?.(w);
    finishObject(w, handle, bitsize);
  };

  /* Note: our reader reads BlockTable as: BL num (data), then handles
     inline: owner, reactors, xdict, entries, model, paper. The generic
     makeControl matches that shape (num in data stream, rest as handles). */

  const makeDictionary = (
    handle: number, owner: number, items: [string, number][]
  ): void => {
    makeObject(42, handle, (w) => {
      w.bl(items.length);
      if (V >= 2000) w.bs(1);             /* cloning (R2000+ only) */
      if (V >= 14) w.rc(0);               /* hard owner (R13c3 and later) */
      for (const [name] of items) w.t(nameText(r14Str(name)));
    }, (w) => {
      w.h(4, owner);
      if (V < 2004) w.h(3, 0);
      for (const [, h] of items) w.h(2, h);
    });
  };

  /* ---------------- build all objects ---------------- */

  /* ---- byte-preserving rewrite ----
   *
   * An entity that still carries the record the reader sealed for it is
   * written from those exact bytes rather than re-encoded, so an
   * untouched drawing survives a read/write cycle byte for byte. The
   * contract behind `record` (mutate the entity, delete the record) is
   * spelled out on DwgWriteOptions.verbatimRecords; the guards below are
   * the mechanical half — the cases where the bytes would be right about
   * the entity but wrong about the file around it.
   *
   * Only fixed-type entities whose handle stream stops at the symbol
   * tables qualify. Everything else reaches into objects this writer
   * mints fresh (DIMSTYLE, MLINESTYLE, IMAGEDEF, the class records and
   * their positional numbering, owned sub-entities, the R2018 AcDs
   * payload), and a retained record naming those by their source numbers
   * would dangle. Those entities are re-encoded, exactly as they are
   * without the option.
   */
  const VERBATIM_TYPE: Partial<Record<Entity['type'], number>> = {
    line: 19, point: 27, circle: 18, arc: 17, ellipse: 35, ray: 40,
    xline: 41, solid: 31, face3d: 28, polyline: 77, spline: 36, text: 1,
    mtext: 44, shape: 33, hatch: 78, ole: 74
  };

  /** The object type the record names in its own first field — the same
   *  encoding objectPrologue writes. */
  const recordType = (bytes: Uint8Array): number => {
    try {
      const r = new BitReader(bytes);
      if (V < 2018) return r.bs();
      switch (r.bb()) {                     /* R2010+ BOT */
        case 0: return r.rc();
        case 1: return r.rc() + 0x1f0;
        case 2: return r.rs();
        default: return -1;
      }
    } catch { return -1; }
  };

  /** The retained record as an object-map entry, or undefined when this
   *  entity has to be re-encoded from the model. */
  const verbatimObj = (e: Entity, handle: number): Obj | undefined => {
    if (!verbatim || !tablesKept) return undefined;
    const rec = e.record;
    if (!rec || !rec.data) return undefined;
    /* never emit foreign bytes as native: a record only goes out whole
       into a container of its own encoding generation */
    if (rec.encoding !== encodingGroup(V)) return undefined;
    /* an INSERT with attributes owns them: they are emitted by the
       encoder, and the record names them by handle */
    if (e.type === 'insert' && e.attributes?.length) return undefined;
    const want = e.type === 'insert'
      ? ((e.columnCount ?? 1) > 1 || (e.rowCount ?? 1) > 1 ? 8 : 7)
      : VERBATIM_TYPE[e.type];
    if (want === undefined) return undefined;
    /* EED names its APPID by handle, and APPIDs are minted fresh */
    if (e.xdata?.length) return undefined;
    /* the record spells out its own handle, so it has to be the one the
       object map is about to file it under */
    if (!e.handle || parseInt(e.handle, 16) !== handle) return undefined;
    /* pre-R2004 records carry the sibling chain inside the record */
    if (V <= 2002 && !chainKept) return undefined;
    /* R2010+ splits the record at a bit position the size prefix carries;
       without that split the bytes cannot be filed */
    if (V >= 2018 && rec.handleBits === undefined) return undefined;
    const bytes = fromBase64(rec.data);
    if (!bytes.length) return undefined;
    /* The record has to be the very record this writer would produce for
       this entity. The model flattens several DWG spellings into one
       type — a 2D POLYLINE with its own VERTEX records reads back as the
       same `polyline` an inline LWPOLYLINE does, and only the second is
       self-contained — so the type the bytes name is checked against the
       type the encoder would have written. Anything else re-encodes. */
    if (recordType(bytes) !== want) return undefined;
    return {
      handle, bytes,
      handleBits: V >= 2018 ? rec.handleBits : undefined
    };
  };

  const emitSpace = (
    list: Entity[], hs: number[], entmode: number, owner: number
  ): void => {
    list.forEach((e, i) => {
      const kept = verbatimObj(e, hs[i]);
      if (kept) { objects.push(kept); return; }
      encodeEntity(e, hs[i], {
        entmode, owner: entmode === 0 ? owner : undefined,
        prev: hs[i - 1] ?? 0, next: hs[i + 1] ?? 0
      });
    });
  };

  /* model/paper space live in the two code-3 slots only — AutoCAD's own
     files do not list them among the entries */
  makeControl(48, blockControl,
    userBlocks.map((nm) => blockH.get(nm)!),
    (w) => { w.h(3, msBH); w.h(3, psBH); });
  makeControl(50, layerControl, layers.map((ly) => layerH.get(ly.name)!));
  makeControl(52, styleControl, styles.map((st) => styleH.get(st.name)!));
  /* the two special slots list BYBLOCK first — AutoCAD's own R14/R2000
     files both do, and the R14 audit renames the records when the order
     is reversed ("Special Name Incorrect", 2 errors) */
  makeControl(56, ltypeControl, userLtypes.map((lt) => ltypeH.get(lt.name)!),
    (w) => { w.h(3, ltByblock); w.h(3, ltBylayer); });
  makeControl(60, viewControl, []);
  makeControl(62, ucsControl, []);
  makeControl(64, vportControl, [vportActive]);
  makeControl(66, appidControl, [appidAcad]);
  makeControl(68, dimstyleControl,
    dimStyles.map((ds) => dimStyleH.get(ds.name.toLowerCase())!));
  /* the VX table died with R2000; AutoCAD's own later files omit it */
  if (V <= 2000) makeControl(70, vxControl, []);

  makeDictionary(nod, 0, [
    ...(V >= 2000 ? [['ACAD_LAYOUT', layoutDict] as [string, number]] : []),
    ['ACAD_GROUP', groupDict],
    ['ACAD_MLINESTYLE', mlineDict],
    ...(usesMLeaders
      ? [['ACAD_MLEADERSTYLE', mleaderDictH] as [string, number]] : []),
    ...(geoData ? [['ACAD_GEOGRAPHICDATA', geoDataH] as [string, number]] : []),
    /* proxy objects keep their dictionary names; an unnamed one (its
       owner was not the NOD in the source) still needs a key here */
    ...proxyObjs.map((p, i): [string, number] =>
      [p.name ?? `PROXY_OBJECT_${i + 1}`, proxyObjH[i]]),
    ...unknownObjs.map((p, i): [string, number] =>
      [p.name ?? `SEALED_OBJECT_${i + 1}`, unknownObjH[i]])
  ]);
  makeDictionary(groupDict, nod, []);
  /* the dictionary names the STANDARD style in every release */
  makeDictionary(mlineDict, nod, [['STANDARD', mlineStandardH]]);
  if (usesMLeaders) {
    makeDictionary(mleaderDictH, nod, [['Standard', mleaderStyleH]]);
    makeMLeaderStyleStandard();
  }

  /* ---- layouts (R2000+): the objects behind the drawing tabs.
     AutoCAD's open path walks Model and at least one paper layout via
     the ACAD_LAYOUT dictionary; without them the drawing is refused. ---- */
  if (V >= 2000) {
    const metas = drawing.layouts ?? [];
    const modelMeta = metas.find((l) => /^model$/i.test(l.name));
    const paperMeta = metas.find((l) => !/^model$/i.test(l.name));
    const paperName = paperMeta?.name ?? 'Layout1';
    makeDictionary(layoutDict, nod, [
      ['Model', layoutModelH], [paperName, layoutPaperH]
    ]);
    const makeLayout = (
      handle: number, name: string, tabOrder: number, blockHdr: number,
      meta: typeof metas[number] | undefined
    ): void => {
      makeObject(82, handle, (w) => {
        /* AcDbPlotSettings — a no-printer default plot setup */
        w.t('');                          /* printer config */
        w.t('');                          /* paper size */
        w.bs(0);                          /* plot flags */
        for (let i = 0; i < 6; i++) w.bd(0);  /* margins + paper size */
        w.t('');                          /* canonical media name */
        w.bd(0); w.bd(0);                 /* plot origin */
        w.bs(0); w.bs(0); w.bs(0);        /* paper unit, rotation, type */
        w.bd(0); w.bd(0); w.bd(0); w.bd(0);   /* plot window */
        if (V <= 2002) w.t('');           /* plot view (handle from 2004) */
        w.bd(1); w.bd(1);                 /* paper / drawing units */
        w.t('');                          /* stylesheet */
        w.bs(0);                          /* standard scale type */
        w.bd(1);                          /* standard scale factor */
        w.bd(0); w.bd(0);                 /* paper image origin */
        if (V >= 2004) { w.bs(0); w.bs(0); w.bs(0); }  /* shade plot */
        /* AcDbLayout */
        w.t(nameText(name));
        w.bs(tabOrder);
        w.bs(1);                          /* layout flags */
        const ins = meta?.insBase ?? { x: 0, y: 0, z: 0 };
        w.bd3(ins.x, ins.y, ins.z ?? 0);
        w.rd(meta?.limMin?.x ?? 0); w.rd(meta?.limMin?.y ?? 0);
        w.rd(meta?.limMax?.x ?? 12); w.rd(meta?.limMax?.y ?? 9);
        w.bd3(0, 0, 0);                   /* UCS origin */
        w.bd3(1, 0, 0); w.bd3(0, 1, 0);   /* UCS axes */
        w.bd(0);                          /* elevation */
        w.bs(0);                          /* orthographic view type */
        w.bd3(0, 0, 0); w.bd3(0, 0, 0);   /* extents */
        if (V >= 2004) w.bl(0);           /* viewport count */
      }, (w) => {
        w.h(4, layoutDict);               /* owner */
        if (V < 2004) w.h(3, 0);          /* xdict */
        if (V >= 2004) w.h(4, 0);         /* plot view */
        if (V >= 2007) w.h(4, 0);         /* shade plot */
        w.h(4, blockHdr);                 /* the space it lays out */
        w.h(4, 0);                        /* active viewport */
        w.h(5, 0); w.h(5, 0);             /* base / named UCS */
      });
    };
    makeLayout(layoutModelH, 'Model', modelMeta?.tabOrder ?? 0, msBH, modelMeta);
    makeLayout(layoutPaperH, paperName, paperMeta?.tabOrder ?? 1, psBH, paperMeta);
  }

  /* ---- the active model viewport: every AutoCAD drawing has one ---- */
  {
    /* The saved view goes out as the drawing carries it — the twist above
       all, since a drawing laid out at an angle is drawn turned without
       it. A drawing with no view of its own gets the defaults that were
       here before. */
    const av = (drawing.vports ?? []).find((p) => /^\*active$/i.test(p.name));
    const p2 = (p: Point2 | undefined, dx: number, dy: number): [number, number] =>
      p ? [p.x, p.y] : [dx, dy];
    const p3v = (p: Point3 | undefined, d: readonly [number, number, number])
      : [number, number, number] => p ? [p.x, p.y, p.z ?? 0] : [d[0], d[1], d[2]];
    makeObject(65, vportActive, (w) => {
      tableFlags(w, '*Active');
      const avH = av?.height && av.height > 0 ? av.height : 100;
      w.bd(av?.height ?? 100);            /* view height */
      /* the slot stores the view WIDTH; the model speaks DXF's 41 =
         width / height, so the ratio multiplies back out here (the
         1.5 x 100 default is the same 150 this always wrote) */
      w.bd((av?.aspectRatio && av.aspectRatio > 0 ? av.aspectRatio : 1.5) * avH);
      const [ccx, ccy] = p2(av?.center, 50, 50);
      w.rd(ccx); w.rd(ccy);               /* view center */
      const [ttx, tty, ttz] = p3v(av?.target, [0, 0, 0]);
      w.bd3(ttx, tty, ttz);               /* view target */
      const [ddx, ddy, ddz] = p3v(av?.direction, [0, 0, 1]);
      w.bd3(ddx, ddy, ddz);               /* view direction */
      w.bd(av?.twist ?? 0);               /* VIEWTWIST, radians */
      w.bd(av?.lensLength ?? 50);         /* lens length */
      w.bd(av?.frontClip ?? 0); w.bd(av?.backClip ?? 0);
      /* three view-mode flags, low bit first, then the fourth bit every
         genuine file sets (see the reader for how that was graded) */
      const vm = av?.viewMode ?? 0;
      w.b(vm & 1); w.b((vm >> 1) & 1); w.b((vm >> 2) & 1); w.b(1);
      if (V >= 2000) w.rc(av?.renderMode ?? 0);
      if (V >= 2007) {
        w.b(1);                           /* default lights */
        w.rc(1);                          /* default lighting type */
        w.bd(0); w.bd(0);                 /* brightness, contrast */
        w.bs(250); w.bl(0); w.rc(0);      /* ambient color (CMC) */
      }
      const [llx, lly] = p2(av?.lowerLeft, 0, 0);
      const [urx, ury] = p2(av?.upperRight, 1, 1);
      w.rd(llx); w.rd(lly);               /* lower left */
      w.rd(urx); w.rd(ury);               /* upper right */
      w.b(av?.ucsFollow ? 1 : 0);         /* UCSFOLLOW */
      w.bs(av?.circleSides ?? 1000);      /* circle sides */
      w.b(av?.fastZoom === false ? 0 : 1);
      const icon = av?.ucsIcon ?? 3;      /* icon on / at origin, low bit first */
      w.b(icon & 1); w.b((icon >> 1) & 1);
      w.b(av?.gridOn ? 1 : 0);
      const [gsx, gsy] = p2(av?.gridSpacing, 10, 10);
      w.rd(gsx); w.rd(gsy);               /* grid spacing */
      w.b(av?.snapOn ? 1 : 0);
      w.b(av?.snapStyle ?? 0);
      w.bs(av?.snapIsoPair ?? 0);
      w.bd(av?.snapAngle ?? 0);
      const [sbx, sby] = p2(av?.snapBase, 0, 0);
      w.rd(sbx); w.rd(sby);               /* snap base */
      const [ssx, ssy] = p2(av?.snapSpacing, 10, 10);
      w.rd(ssx); w.rd(ssy);               /* snap spacing */
      if (V >= 2000) {
        w.b((icon >> 2) & 1);             /* UCSICON's third bit */
        w.b(av?.ucsPerViewport === false ? 0 : 1);
        const hu = drawing.header.ucs;
        const [uox, uoy, uoz] = p3v(av?.ucsOrigin ?? hu?.origin, [0, 0, 0]);
        const [uxx, uxy, uxz] = p3v(av?.ucsXAxis ?? hu?.xAxis, [1, 0, 0]);
        const [uyx, uyy, uyz] = p3v(av?.ucsYAxis ?? hu?.yAxis, [0, 1, 0]);
        w.bd3(uox, uoy, uoz);             /* UCS origin */
        w.bd3(uxx, uxy, uxz); w.bd3(uyx, uyy, uyz);
        w.bd(av?.ucsElevation ?? 0);      /* UCS elevation */
        w.bs(av?.ucsOrthoType ?? 0);      /* orthographic view type */
      }
      if (V >= 2007) { w.bs(3); w.bs(5); }  /* grid flags, major */
    }, (w) => {
      w.h(4, vportControl);
      if (V < 2004) w.h(3, 0);            /* xdict */
      w.h(5, 0);                          /* xref */
      if (V >= 2007) { w.h(4, 0); w.h(5, 0); w.h(3, 0); }  /* bg, style, sun */
      if (V >= 2000) { w.h(5, 0); w.h(5, 0); }  /* named / base UCS */
    });
  }

  /* ---- dictionary-owned proxy objects: passthrough, same discipline as
     the entity form — retained prologue, payload bits, reference codes ---- */
  proxyObjs.forEach((p, i) => {
    const key = p.appClass?.dxfName ?? p.sourceType ?? 'ACAD_PROXY_OBJECT';
    const cls = proxyClsH.get(key);
    makeObject(0x1f3, proxyObjH[i], (w) => {
      w.bl(cls?.num ?? 0x1f3);
      w.bl(p.proxyVersion ?? 0);
      if (V >= 2018) w.bl(p.proxyMaint ?? 0);
      if (V >= 2000) w.b(p.fromDxf ? 1 : 0);
      if (p.data && p.dataBits) w.putBits(fromBase64(p.data), p.dataBits);
    }, (w) => {
      w.h(4, nod);                        /* owner: the root dictionary */
      if (V < 2004) w.h(3, 0);
      for (const ref of p.refs ?? []) {
        w.h(ref.code, parseInt(ref.value, 16) || 0);
      }
    });
  });

  /* ---- sealed unknown objects: universal passthrough, object side.
     Same generation → the record goes out native (original fixed type or
     re-emitted class); foreign generation → wrapped in a proxy object
     tagged with its encoding, unwrapped when the generations match. ---- */
  unknownObjs.forEach((p, i) => {
    const key = p.appClass?.dxfName ?? p.sourceType;
    const refs = (w: BitWriter): void => {
      w.h(4, nod);                        /* owner: the root dictionary */
      if (V < 2004) w.h(3, 0);
      for (const ref of p.refs ?? []) {
        w.h(ref.code, parseInt(ref.value, 16) || 0);
      }
    };
    if (p.encoding === encodingGroup(V) || p.data === undefined) {
      makeObject(p.typeCode ?? proxyClsH.get(key)?.num ?? 0x1f3,
        unknownObjH[i], (w) => {
          if (p.data && p.dataBits) w.putBits(fromBase64(p.data), p.dataBits);
          if (p.strData && p.strBits) {
            w.strTarget?.putBits(fromBase64(p.strData), p.strBits);
          }
        }, refs);
    } else {
      makeObject(0x1f3, unknownObjH[i], (w) => {
        w.bl(p.typeCode === undefined ? (proxyClsH.get(key)?.num ?? 0) : 0);
        w.bl((SEAL_MAGIC | (p.encoding ?? 0)) >>> 0);
        if (V >= 2018) w.bl(0);
        if (V >= 2000) w.b(0);
        w.rl(p.dataBits ?? 0);
        if (p.data && p.dataBits) w.putBits(fromBase64(p.data), p.dataBits);
        w.rl(p.strBits ?? 0);
        if (p.strData && p.strBits) w.putBits(fromBase64(p.strData), p.strBits);
      }, refs);
    }
  });

  for (const ly of layers) makeLayer(ly);
  for (const st of styles) makeStyle(st);
  makeLtype('ByLayer', ltBylayer);
  makeLtype('ByBlock', ltByblock);
  for (const lt of userLtypes) makeLtype(lt.name, ltypeH.get(lt.name)!, lt);
  makeAppid();
  for (const ds of dimStyles) makeDimStyle(ds);
  makeMlineStandard();

  makeBlockHeader(msBH, '*MODEL_SPACE', msBlockEnt, msEndblk, msEntH,
    undefined, V >= 2000 ? layoutModelH : 0);
  makeBlockHeader(psBH, '*PAPER_SPACE', psBlockEnt, psEndblk, psEntH,
    undefined, V >= 2000 ? layoutPaperH : 0);
  for (const nm of userBlocks) {
    makeBlockHeader(blockH.get(nm)!, nm,
      blockBeginH.get(nm)!, blockEndH.get(nm)!,
      blockEntH.get(nm)!,
      drawing.blocks[nm].basePoint);
  }

  makeBlockEnt(msBlockEnt, msBH, '*MODEL_SPACE');
  makeEndblk(msEndblk, msBH);
  makeBlockEnt(psBlockEnt, psBH, '*PAPER_SPACE');
  makeEndblk(psEndblk, psBH);
  for (const nm of userBlocks) {
    makeBlockEnt(blockBeginH.get(nm)!, blockH.get(nm)!, nm);
    makeEndblk(blockEndH.get(nm)!, blockH.get(nm)!);
  }

  emitSpace(modelEnts, msEntH, 2, msBH);
  emitSpace(paperEnts, psEntH, 1, psBH);
  for (const nm of userBlocks) {
    emitSpace(blockEnts.get(nm)!, blockEntH.get(nm)!, 0, blockH.get(nm)!);
  }

  /* ---- dynamic blocks: one BLOCKVISIBILITYPARAMETER per block that
     defines visibility states. The record mirrors the reader field for
     field (AcDbEvalExpr prologue, element block, member list, states).
     Member and per-state references name the block's entities: the model
     carries them as the source file's handles, so they are remapped here
     through each entity's retained `handle`. The reader binds the record
     to its block through the members' owner, which is the block header
     written above. ---- */
  for (const nm of dynBlocks) {
    const def = drawing.blocks[nm];
    if (V <= 14) {
      skipped.push(`dynamic-block visibility of ${nm} (needs R2000 or later)`);
      continue;
    }
    const ents = blockEnts.get(nm)!;
    const hs = blockEntH.get(nm)!;
    const byOldHandle = new Map<string, number>();
    ents.forEach((be, i) => {
      if (be.handle) byOldHandle.set(be.handle.toUpperCase(), hs[i]);
    });
    const mapState = (visible: string[]): number[] => visible
      .map((h2) => byOldHandle.get(h2.toUpperCase()))
      .filter((h2): h2 is number => h2 !== undefined);
    const states = def.visibilityStates!.map((st) => ({
      name: st.name, visible: mapState(st.visible)
    }));
    makeObject(CLS_BLOCKVIS, H(), (w) => {
      w.bl(0); w.bl(0); w.bl(0);          /* eval expr: parent, version pair */
      w.bs(-9999);                        /* no inline value */
      w.bl(1);                            /* node id */
      w.t(outText('Visibility'));         /* element name */
      w.bl(0); w.bl(0);                   /* element version pair */
      w.bl(0);                            /* extended-data marker */
      w.b(1); w.b(0);                     /* show properties, chain actions */
      w.bd3(def.basePoint?.x ?? 0, def.basePoint?.y ?? 0,
        def.basePoint?.z ?? 0);           /* definition point */
      w.bl(0); w.bl(0);                   /* two empty property-info blocks */
      w.bl(0);                            /* property-info count */
      w.b(1);                             /* is initialized */
      w.t(outText(def.visibilityName ?? 'Visibility'));
      w.t(outText(def.visibilityPrompt ?? ''));
      w.b(0);
      w.bl(hs.length);                    /* members: every block entity */
      w.bl(states.length);
      for (const st of states) {
        w.t(outText(st.name));
        w.bl(st.visible.length);
        w.bl(0);                          /* state parameters */
      }
    }, (w) => {
      w.h(4, blockH.get(nm)!);            /* owner: the block header */
      if (V < 2004) w.h(3, 0);
      for (const h2 of hs) w.h(5, h2);    /* members */
      for (const st of states) {
        for (const h2 of st.visible) w.h(5, h2);
      }
    });
  }

  /* geographic placement, in the R2013 field order the reader expects */
  if (geoData) {
    makeObject(CLS_GEODATA, geoDataH, (w) => {
      w.bl(geoData.version ?? 3);
      /* host block handle rides the handle stream, below */
      w.bs(geoData.coordinatesType ?? 1);
      const p3 = (q: { x: number; y: number; z?: number } | undefined): void => {
        w.bd3(q?.x ?? 0, q?.y ?? 0, q?.z ?? 0);
      };
      p3(geoData.designPoint);
      p3(geoData.referencePoint);
      w.bd(geoData.horizontalUnitScale ?? 1);
      w.bl(geoData.horizontalUnits ?? 1);
      w.bd(geoData.verticalUnitScale ?? geoData.horizontalUnitScale ?? 1);
      w.bl(geoData.verticalUnits ?? geoData.horizontalUnits ?? 1);
      p3(geoData.upDirection ?? { x: 0, y: 0, z: 1 });
      const north = geoData.northDirection ?? { x: 0, y: 1 };
      w.rd(north.x); w.rd(north.y);
      w.bl(geoData.scaleEstimation ?? 1);
      w.bd(geoData.userScaleFactor ?? 1);
      w.b(geoData.seaLevelCorrection ? 1 : 0);
      w.bd(geoData.seaLevelElevation ?? 0);
      w.bd(geoData.projectionRadius ?? 0);
      w.t(outText(geoData.coordinateSystem ?? ''));
      w.t(outText(geoData.geoRssTag
        ?? (geoData.latitude !== undefined
          ? `<georss:point>${geoData.latitude} ${geoData.longitude ?? 0}</georss:point>`
          : '')));
      w.t(''); w.t(''); w.t('');          /* observation tags */
      w.bl(0);                            /* mesh points */
      w.bl(0);                            /* mesh faces */
    }, (w) => {
      w.h(4, nod);                        /* owner: the root dictionary */
      if (V < 2004) w.h(3, 0);
      w.h(5, msBH);                       /* host block */
    });
  }

  /* underlay definition objects for the entities emitted above */
  for (const [key, defH] of underlayDefH) {
    const [kind, path, itemName] = key.split('|');
    makeObject(underlayCls.get(kind)!.def, defH, (w) => {
      w.t(outText(path));
      w.t(outText(itemName));
    }, (w) => {
      w.h(4, 0);
      if (V < 2004) w.h(3, 0);
    });
  }

  /* IMAGEDEF objects for the image entities emitted above */
  for (const [key, defH] of imageDefH) {
    const path = key.slice(0, key.lastIndexOf('|'));
    const dims = key.slice(key.lastIndexOf('|') + 1).split('x');
    makeObject(CLS_IMAGEDEF, defH, (w) => {
      w.bl(0);                            /* class version */
      w.rd(parseFloat(dims[0]) || 1); w.rd(parseFloat(dims[1]) || 1);
      w.t(outText(path));
      w.b(1);                             /* loaded */
      w.rc(0);                            /* resunits */
      w.rd(1); w.rd(1);                   /* pixel size */
    }, (w) => {
      w.h(4, 0);
      if (V < 2004) w.h(3, 0);
    });
  }

  const handseed = nextHandle + 1;

  /* ---------------- header variables section ----------------
   * R2007+ splits this section the same way it splits objects: values in
   * the data stream, handles in their own stream at a bit offset the
   * section's bitsize field names, strings in a UTF-16 stream at the tail.
   * Writing it R2000-style produced a section our own (oracle-validated)
   * reader could not parse — every variable in an R2007/2018 file we wrote
   * was lost. H() and the version-conditional fields below keep the two
   * sides in step.
   */
  const hvHnd = V >= 2007 ? new BitWriter() : null;
  const hvStr = V >= 2007 ? new BitWriter() : null;
  const hv = new BitWriter();
  {
    const w = hv;
    if (hvStr) { hvStr.utf16 = true; w.utf16 = true; w.strTarget = hvStr; }
    /** a handle the reader takes from the handle stream (R2007+) */
    const H = (code: number, value: number): void => (hvHnd ?? w).h(code, value);
    /** a numeric header variable the source drawing carried, else a default */
    const hdrNum = (k: string, dflt: number): number => {
      const x = drawing.header.vars?.[k];
      return typeof x === 'number' && Number.isFinite(x) ? x : dflt;
    };
    if (V >= 2013) w.bll(0);              /* REQUIREDVERSIONS */
    /* unit ratios: the first is the ancient 412148564080.0 constant every
       AutoCAD writes; genuine files carry 1.0 for the other three */
    w.bd(412148564080); w.bd(1); w.bd(1); w.bd(1);
    /* unit names exist in every release: inline (NUL-terminated when
       non-empty, as AutoCAD writes them) through R2004, string-stream
       entries from R2007 on */
    w.t(V >= 2007 ? 'm' : 'm\0'); w.t(''); w.t(''); w.t('');
    w.bl(0); w.bl(0);                     /* unknown 8, 9 (AutoCAD: 0, 0) */
    if (V <= 14) w.bs(256);               /* unknown 10 (R13/R14; AutoCAD: 256) */
    if (V < 2004) w.h(5, 0);              /* VX record (R13-R2000 only) */
    w.b(1); w.b(1);                       /* DIMASO, DIMSHO */
    if (V <= 14) w.b(0);                  /* DIMSAV */
    w.b(0); w.b(0); w.b(1); w.b(1); w.b(0); w.b(1); w.b(0);  /* PLINEGEN..LIMCHECK */
    if (V <= 14) w.b(0);                  /* BLIPMODE */
    if (V >= 2004) w.b(0);                /* unknown_11 */
    w.b(1); w.b(0); w.b(0); w.b(0);       /* USRTIMER..SPLFRAME */
    if (V <= 14) { w.b(1); w.b(0); }      /* ATTREQ, ATTDIA */
    w.b(0); w.b(1);                       /* MIRRTEXT, WORLDVIEW */
    if (V <= 14) w.b(0);                  /* WIREFRAME */
    w.b(1); w.b(0); w.b(1);               /* TILEMODE, PLIMCHECK, VISRETAIN */
    if (V <= 14) w.b(1);                  /* DELOBJ */
    w.b(0); w.b(0);                       /* DISPSILH, PELLIPSE */
    w.bs(1);                              /* PROXYGRAPHICS */
    if (V <= 14) w.bs(2);                 /* DRAGMODE */
    w.bs(3020);                           /* TREEDEPTH */
    w.bs(2); w.bs(4); w.bs(0); w.bs(0);   /* LUNITS..AUPREC */
    if (V <= 14) w.bs(0);                 /* OSMODE */
    w.bs(1);                              /* ATTMODE */
    if (V <= 14) w.bs(1);                 /* COORDS */
    w.bs(Math.round(hdrNum('PDMODE', 0)));   /* PDMODE */
    if (V <= 14) w.bs(1);                 /* PICKSTYLE */
    if (V >= 2004) { w.bl(0); w.bl(0); w.bl(0); }
    for (let i = 0; i < 5; i++) w.bs(0);  /* USERI1-5 */
    w.bs(8); w.bs(6); w.bs(6); w.bs(6);   /* SPLINESEGS, SURFU/V/TYPE */
    w.bs(6); w.bs(6); w.bs(6);            /* SURFTAB1/2, SPLINETYPE */
    w.bs(3); w.bs(70); w.bs(0); w.bs(64); /* SHADEDGE, SHADEDIF, UNITMODE, MAXACTVP */
    w.bs(4); w.bs(0); w.bs(50);           /* ISOLINES, CMLJUST, TEXTQLTY */
    w.bd(drawing.header.linetypeScale ?? 1);  /* LTSCALE */
    w.bd(2.5); w.bd(1); w.bd(1); w.bd(0); w.bd(0);  /* TEXTSIZE..THICKNESS */
    w.bd(0); w.bd(hdrNum('PDSIZE', 0)); w.bd(0);  /* ANGBASE, PDSIZE, PLINEWID */
    for (let i = 0; i < 5; i++) w.bd(0);  /* USERR1-5 */
    for (let i = 0; i < 4; i++) w.bd(0);  /* CHAMFERA-D */
    w.bd(0.5); w.bd(1); w.bd(1);          /* FACETRES, CMLSCALE, CELTSCALE */
    w.t(V >= 2007 ? '.' : '.\0');         /* MENU (string stream in R2007+) */
    w.bl(2451545); w.bl(0);               /* TDUCREATE */
    w.bl(2451545); w.bl(0);               /* TDUUPDATE */
    if (V >= 2004) { w.bl(0); w.bl(0); w.bl(0); }
    w.bl(0); w.bl(0);                     /* TDINDWG */
    w.bl(0); w.bl(0);                     /* TDUSRTIMER */
    /* CECOLOR = ByLayer. R2004+ speaks through the AcCmEntityColor method
       byte (C0 = ByLayer) with the BS index left at 0, exactly as AutoCAD
       writes it; earlier releases use ACI 256. */
    if (V >= 2004) { w.bs(0); w.bl(0xC0000000); w.rc(0); }
    else w.bs(256);                       /* CECOLOR: bylayer */
    w.h(0, handseed);                     /* HANDSEED (data stream) */
    H(5, layerH.get('0') ?? [...layerH.values()][0]);  /* CLAYER */
    H(5, styleH.get('Standard') ?? [...styleH.values()][0]);
    H(5, ltBylayer);                      /* CELTYPE */
    if (V >= 2007) H(5, 0);               /* CMATERIAL */
    H(5, dimStandardH);                   /* DIMSTYLE */
    H(5, mlineStandardH);                 /* CMLSTYLE (STANDARD at R13/R14) */
    if (V >= 2000) w.bd(0);               /* PSVPSCALE (R2000+) */
    /* paper space vars */
    w.bd3(0, 0, 0);                       /* PINSBASE */
    w.bd3(0, 0, 0); w.bd3(0, 0, 0);       /* PEXTMIN/MAX */
    w.rd(0); w.rd(0); w.rd(12); w.rd(9);  /* PLIMMIN/MAX */
    w.bd(0);                              /* PELEVATION */
    const pu = drawing.header.pUcs;
    w.bd3(pu?.origin.x ?? 0, pu?.origin.y ?? 0, pu?.origin.z ?? 0);   /* PUCSORG */
    w.bd3(pu?.xAxis.x ?? 1, pu?.xAxis.y ?? 0, pu?.xAxis.z ?? 0);      /* PUCSXDIR */
    w.bd3(pu?.yAxis.x ?? 0, pu?.yAxis.y ?? 1, pu?.yAxis.z ?? 0);      /* PUCSYDIR */
    H(5, 0);                              /* PUCSNAME */
    if (V >= 2000) {
      H(5, 0); w.bs(0); H(5, 0);          /* PUCSORTHOREF/VIEW/BASE */
      for (let i = 0; i < 6; i++) w.bd3(0, 0, 0);  /* PUCSORG* */
    }
    /* model space vars */
    const ext = {
      min: drawing.header.extMin ?? { x: 1e20, y: 1e20, z: 0 },
      max: drawing.header.extMax ?? { x: -1e20, y: -1e20, z: 0 }
    };
    w.bd3(0, 0, 0);                       /* INSBASE */
    w.bd3(ext.min.x, ext.min.y, ext.min.z ?? 0);
    w.bd3(ext.max.x, ext.max.y, ext.max.z ?? 0);
    const lim = {
      min: drawing.header.limMin ?? { x: 0, y: 0 },
      max: drawing.header.limMax ?? { x: 420, y: 297 }
    };
    w.rd(lim.min.x); w.rd(lim.min.y); w.rd(lim.max.x); w.rd(lim.max.y);
    w.bd(0);                              /* ELEVATION */
    /* the current UCS: a drawing laid out at an angle keeps its rotation
       here, and writing the world default instead turns the model back */
    const hu = drawing.header.ucs;
    w.bd3(hu?.origin.x ?? 0, hu?.origin.y ?? 0, hu?.origin.z ?? 0);   /* UCSORG */
    w.bd3(hu?.xAxis.x ?? 1, hu?.xAxis.y ?? 0, hu?.xAxis.z ?? 0);      /* UCSXDIR */
    w.bd3(hu?.yAxis.x ?? 0, hu?.yAxis.y ?? 1, hu?.yAxis.z ?? 0);      /* UCSYDIR */
    H(5, 0);                              /* UCSNAME */
    if (V >= 2000) {
      H(5, 0); w.bs(0); H(5, 0);          /* UCSORTHOREF/VIEW/BASE */
      for (let i = 0; i < 6; i++) w.bd3(0, 0, 0);
      w.t(''); w.t('');                   /* DIMPOST, DIMAPOST */
    }
    if (V <= 14) {
      /* The R13/R14 dimension flag block — its own layout, mirrored
         field-for-field from the reader (headervars.ts). Written in the
         R2000 order this whole section failed to parse and every
         document-level value (extents, limits, LTSCALE) was lost. */
      w.b(0); w.b(0); w.b(0); w.b(0);     /* DIMTOL, DIMLIM, DIMTIH, DIMTOH */
      w.b(0); w.b(0);                     /* DIMSE1, DIMSE2 */
      w.b(0); w.b(1); w.b(0);             /* DIMALT, DIMTOFL, DIMSAH */
      w.b(0); w.b(0);                     /* DIMTIX, DIMSOXD */
      w.rc(3); w.rc(8);                   /* DIMALTD, DIMZIN */
      w.b(0); w.b(0);                     /* DIMSD1, DIMSD2 */
      w.rc(0); w.rc(0); w.rc(3);          /* DIMTOLJ, DIMJUST, DIMFIT */
      w.b(0);                             /* DIMUPT */
      w.rc(8); w.rc(0); w.rc(0); w.rc(1); /* DIMTZIN, DIMALTZ, DIMALTTZ, DIMTAD */
      w.bs(2); w.bs(0);                   /* DIMUNIT, DIMAUNIT */
      w.bs(Math.round(hdrNum('DIMDEC', 2))); w.bs(2);  /* DIMDEC, DIMTDEC */
      w.bs(2); w.bs(3);                   /* DIMALTU, DIMALTTD */
      H(5, styleH.get('Standard') ?? [...styleH.values()][0]);  /* DIMTXSTY */
    }
    /* the source drawing's dimensioning sizes when it carried them,
       this writer's own defaults otherwise */
    w.bd(hdrNum('DIMSCALE', 1)); w.bd(hdrNum('DIMASZ', 2.5)); w.bd(hdrNum('DIMEXO', 0.625));
    w.bd(hdrNum('DIMDLI', 3.75)); w.bd(hdrNum('DIMEXE', 1.25));   /* DIMSCALE..DIMEXE */
    w.bd(hdrNum('DIMRND', 0)); w.bd(hdrNum('DIMDLE', 0));
    w.bd(hdrNum('DIMTP', 0)); w.bd(hdrNum('DIMTM', 0));           /* DIMRND..DIMTM */
    if (V >= 2007) {
      w.bd(1); w.bd(0.7853981633974483);   /* DIMFXL, DIMJOGANG */
      w.bs(0);                             /* DIMTFILL */
      w.bs(0); w.bl(0xC1000000); w.rc(0);  /* DIMTFILLCLR: ByBlock CMC */
    }
    if (V >= 2000) {
      w.b(0); w.b(0); w.b(0); w.b(0); w.b(0); w.b(0);  /* DIMTOL..DIMSE2 */
      w.bs(1); w.bs(8); w.bs(0);          /* DIMTAD, DIMZIN, DIMAZIN */
    }
    if (V >= 2007) w.bs(0);               /* DIMARCSYM */
    w.bd(hdrNum('DIMTXT', 2.5)); w.bd(hdrNum('DIMCEN', 2.5));
    w.bd(hdrNum('DIMTSZ', 0));                /* DIMTXT, DIMCEN, DIMTSZ */
    w.bd(hdrNum('DIMALTF', 0.03937007874016)); w.bd(hdrNum('DIMLFAC', 1));
    w.bd(hdrNum('DIMTVP', 0));                /* DIMALTF, DIMLFAC, DIMTVP */
    w.bd(hdrNum('DIMTFAC', 1)); w.bd(hdrNum('DIMGAP', 0.625));    /* DIMTFAC, DIMGAP */
    if (V <= 14) {
      /* DIMPOST, DIMAPOST, DIMBLK, DIMBLK1, DIMBLK2 — inline texts here */
      w.t(''); w.t(''); w.t(''); w.t(''); w.t('');
    }
    if (V >= 2000) {
      w.bd(0);                            /* DIMALTRND */
      w.b(0); w.bs(3);                    /* DIMALT, DIMALTD */
      w.b(1); w.b(0); w.b(0); w.b(0);     /* DIMTOFL, DIMSAH, DIMTIX, DIMSOXD */
    }
    /* DIMCLRD/E/T = ByBlock: method byte C1 in R2004+, ACI 0 before */
    if (V >= 2004) {
      for (let i = 0; i < 3; i++) { w.bs(0); w.bl(0xC1000000); w.rc(0); }
    } else { w.bs(0); w.bs(0); w.bs(0); }   /* DIMCLRD/E/T */
    if (V >= 2000) {
      w.bs(0); w.bs(Math.round(hdrNum('DIMDEC', 2))); w.bs(2);  /* DIMADEC, DIMDEC, DIMTDEC */
      w.bs(2); w.bs(3); w.bs(0);          /* DIMALTU, DIMALTTD, DIMAUNIT */
      w.bs(0); w.bs(2); w.bs(44);         /* DIMFRAC, DIMLUNIT, DIMDSEP */
      w.bs(0); w.bs(0);                   /* DIMTMOVE, DIMJUST */
      w.b(0); w.b(0);                     /* DIMSD1, DIMSD2 */
      w.bs(0); w.bs(8); w.bs(0); w.bs(0); /* DIMTOLJ, DIMTZIN, DIMALTZ, DIMALTTZ */
      w.b(0); w.bs(3);                    /* DIMUPT, DIMATFIT */
    }
    if (V >= 2007) w.b(0);                /* DIMFXLON */
    if (V >= 2010) {
      w.b(0);                             /* DIMTXTDIRECTION */
      w.bd(100); w.t('');                 /* DIMALTMZF, DIMALTMZS */
      w.bd(100); w.t('');                 /* DIMMZF, DIMMZS */
    }
    if (V >= 2000) {
      H(5, styleH.get('Standard') ?? [...styleH.values()][0]);  /* DIMTXSTY */
      H(5, 0); H(5, 0); H(5, 0); H(5, 0); /* DIMLDRBLK, DIMBLK/1/2 */
      if (V >= 2007) { H(5, 0); H(5, 0); H(5, 0); }  /* DIMLTYPE, DIMLTEX1/2 */
      w.bs(-2); w.bs(-2);                 /* DIMLWD, DIMLWE */
    }
    /* control objects and root dictionaries — all soft-owner (code 3)
       references, matching AutoCAD's own files */
    H(3, blockControl); H(3, layerControl); H(3, styleControl);
    H(3, ltypeControl); H(3, viewControl); H(3, ucsControl);
    H(3, vportControl); H(3, appidControl); H(3, dimstyleControl);
    if (V <= 2000) H(3, vxControl);
    H(5, groupDict); H(5, mlineDict); H(3, nod);
    if (V >= 2000) {
      w.bs(1); w.bs(70);                  /* TSTACKALIGN, TSTACKSIZE */
      w.t(''); w.t('');                   /* HYPERLINKBASE, STYLESHEET */
      H(5, layoutDict); H(5, 0); H(5, 0); /* LAYOUT/PLOTSETTINGS/PLOTSTYLE dicts */
      if (V >= 2004) { H(5, 0); H(5, 0); }  /* material, color dicts */
      if (V >= 2007) H(5, 0);             /* visualstyle dict */
      if (V >= 2013) H(5, 0);             /* lightlist dict */
      w.bl(0x2A1D);                       /* FLAGS (AutoCAD's default) */
      w.bs(drawing.header.insUnits ?? 4); /* INSUNITS */
      w.bs(0);                            /* CEPSNTYPE */
      /* GUID strings: NUL-terminated inline text through R2004, bare in
         the R2007+ string stream — the two shapes AutoCAD writes */
      const guid = '{00000000-0000-0000-0000-000000000000}'
        + (V >= 2007 ? '' : '\0');
      w.t(guid);                          /* FINGERPRINTGUID */
      w.t(guid);                          /* VERSIONGUID */
    }
    if (V >= 2004) {
      w.rc(hdrNum('SORTENTS', 127));      /* SORTENTS */
      w.rc(0);                            /* INDEXCTL */
      w.rc(hdrNum('HIDETEXT', 1));        /* HIDETEXT */
      w.rc(hdrNum('XCLIPFRAME', 2));      /* XCLIPFRAME */
      w.rc(hdrNum('DIMASSOC', 2));        /* DIMASSOC */
      w.rc(hdrNum('HALOGAP', 0));         /* HALOGAP */
      w.bs(257); w.bs(257);               /* OBSCUREDCOLOR, INTERSECTIONCOLOR */
      w.rc(0); w.rc(0);                   /* OBSCUREDLTYPE, INTERSECTIONDISPLAY */
      w.t('');                            /* PROJECTNAME */
    }
    H(5, psBH); H(5, msBH);
    H(5, ltBylayer); H(5, ltByblock); H(5, ltContinuous);
    if (V >= 2007) {
      /* the R2007+ camera / solids / geolocation block, with the defaults
         a virgin AutoCAD drawing carries (read out of a minted reference
         file by our own reader) */
      w.b(drawing.header.vars?.CAMERADISPLAY === true ? 1 : 0);
      w.bl(0); w.bl(10); w.bd(1);         /* unknowns 21-23 */
      w.bd(hdrNum('STEPSPERSEC', 2));     /* STEPSPERSEC */
      w.bd(hdrNum('STEPSIZE', 6));        /* STEPSIZE */
      w.bd(hdrNum('3DDWFPREC', 2));       /* 3DDWFPREC */
      w.bd(hdrNum('LENSLENGTH', 50));     /* LENSLENGTH */
      w.bd(hdrNum('CAMERAHEIGHT', 0));    /* CAMERAHEIGHT */
      w.rc(hdrNum('SOLIDHIST', 0));       /* SOLIDHIST */
      w.rc(hdrNum('SHOWHIST', 1));        /* SHOWHIST */
      w.bd(hdrNum('PSOLWIDTH', 0.25));    /* PSOLWIDTH */
      w.bd(hdrNum('PSOLHEIGHT', 4));      /* PSOLHEIGHT */
      w.bd(hdrNum('LOFTANG1', Math.PI / 2));  /* LOFTANG1 */
      w.bd(hdrNum('LOFTANG2', Math.PI / 2));  /* LOFTANG2 */
      w.bd(hdrNum('LOFTMAG1', 0));        /* LOFTMAG1 */
      w.bd(hdrNum('LOFTMAG2', 0));        /* LOFTMAG2 */
      w.bs(hdrNum('LOFTPARAM', 7));       /* LOFTPARAM */
      w.rc(hdrNum('LOFTNORMALS', 1));     /* LOFTNORMALS */
      w.bd(hdrNum('LATITUDE', 37.795));   /* LATITUDE */
      w.bd(hdrNum('LONGITUDE', -122.394));  /* LONGITUDE */
      w.bd(hdrNum('NORTHDIRECTION', 0));  /* NORTHDIRECTION */
      w.bl(hdrNum('TIMEZONE', -8000));    /* TIMEZONE */
      w.rc(hdrNum('LIGHTGLYPHDISPLAY', 1));   /* LIGHTGLYPHDISPLAY */
      w.rc(hdrNum('TILEMODELIGHTSYNCH', 1));  /* TILEMODELIGHTSYNCH */
      w.rc(hdrNum('DWFFRAME', 2));        /* DWFFRAME */
      w.rc(hdrNum('DGNFRAME', 0));        /* DGNFRAME */
      w.b(1);                             /* unknown 47 */
      w.bs(0); w.bl(0xC3000001); w.rc(0); /* INTERFERECOLOR: ACI 1 (red) */
      H(5, 0); H(5, 0); H(5, 0);          /* INTERFEREOBJVS/VPVS, DRAGVS */
      w.rc(hdrNum('CSHADOW', 0));         /* CSHADOW */
      w.bd(0);                            /* unknown 53 */
    }
    /* four unknown shorts close the data: R13 through R2004 — R2007+
       dropped them. They are present in real AC1012 files too (the
       vintage reference ends its header section with four BS(-1) before
       the padding), and AutoCAD's R13 loader reads them, so leaving them
       out truncates the section under its cursor. */
    if (V >= 13 && V < 2007) { w.bs(0); w.bs(0); w.bs(0); w.bs(0); }
    /* flat streams pad to the byte before the section CRC; the R2007+
       string stream follows the last data bit immediately, unpadded —
       AutoCAD's own files leave no gap there */
    if (V < 2007) w.align();
  }

  /** The header section payload. R2000/R2004 is the one stream built
   *  above; R2007+ prefixes the data stream's bit length (measured from
   *  that field, as the reader does) and appends the handle stream, with
   *  the strings already closed into the data stream's tail. */
  const hvBytes = (): Uint8Array => {
    if (!hvHnd) return hv.bytes();
    hv.strTarget = undefined;
    const strSize = hvStr ? hvStr.pos : 0;
    if (hvStr) {
      hv.appendBits(hvStr);
      hv.rs(strSize & 0x7fff);
      hv.b(1);                            /* strings-present flag */
    }
    const out = new BitWriter();
    if (V >= 2018) out.rl(0);             /* high-order size word */
    out.rl(32 + hv.pos);                  /* bitsize, from this field on */
    out.appendBits(hv);
    out.appendBits(hvHnd);
    out.align();
    return out.bytes();
  };

  /** CLASSES payload (records only; the section wrapper differs by version). */
  function clsBytes(): Uint8Array {
    const clsW = new BitWriter();
    const noClasses = !usesImages && !usesLights && !usesTables
        && !usesMLeaders && !underlayKinds.length && !geoData
        && !proxyClsH.size && !usesDynBlocks;
    /* AutoCAD 2027 refuses an AC1032 drawing whose CLASSES section is
       empty — the R2018 'tight' wrap has no accepted empty form
       (externally proven: the same minimal drawing opens once a single
       benign record is registered). Older versions accept the wrapped
       empty payload. */
    if (noClasses && V < 2007) return clsW.bytes();
    /* R2007+ prefixes the records with their bit length and moves the
       class names into a trailing string stream. */
    let sizePos = -1;
    let strW: BitWriter | null = null;
    if (V >= 2007) {
      /* R2018 (R2010-family) prefixes the bitsize with the high dword of
         a 64-bit size, exactly as the header section does — AutoCAD reads
         it unconditionally and misparses the whole section without it. */
      if (V >= 2018) clsW.rl(0);
      sizePos = clsW.pos;
      clsW.rl(0);
      strW = new BitWriter();
      strW.utf16 = true;
      clsW.utf16 = true;
      clsW.strTarget = strW;
    }
    if (V >= 2004) {
      /* highest class number in use (the stub below counts as 500) */
      clsW.bs(noClasses ? 500 : clsNext - 1);
      clsW.rc(0); clsW.rc(0); clsW.b(1);
    }
    const cls = (
      num: number, dxf: string, cpp: string, entity: boolean, app = 'ISM'
    ): void => {
      clsW.bs(num); clsW.bs(127);
      clsW.t(app); clsW.t(cpp); clsW.t(dxf);
      clsW.b(0); clsW.bs(entity ? 0x1f2 : 0x1f3);
      if (V >= 2004) {
        clsW.bl(1);                       /* instance count */
        clsW.bs(0x19); clsW.bs(0);        /* dwg/maint version */
        clsW.bl(0); clsW.bl(0);
      }
    };
    if (usesImages) {
      cls(CLS_IMAGE, 'IMAGE', 'AcDbRasterImage', true);
      cls(CLS_IMAGEDEF, 'IMAGEDEF', 'AcDbRasterImageDef', false);
      cls(CLS_WIPEOUT, 'WIPEOUT', 'AcDbWipeout', true);
    }
    if (usesLights) cls(CLS_LIGHT, 'LIGHT', 'AcDbLight', true);
    if (usesTables) cls(CLS_TABLE, 'ACAD_TABLE', 'AcDbTable', true);
    if (usesMLeaders) {
      cls(CLS_MLEADER, 'MULTILEADER', 'AcDbMLeader', true);
      cls(CLS_MLEADERSTYLE, 'MLEADERSTYLE', 'AcDbMLeaderStyle', false,
        'ACDB_MLEADERSTYLE_CLASS');
    }
    for (const [kind, nums] of underlayCls) {
      const cap = kind.charAt(0).toUpperCase() + kind.slice(1);
      cls(nums.ent, kind.toUpperCase() + 'UNDERLAY', `AcDb${cap}Reference`, true);
      cls(nums.def, kind.toUpperCase() + 'DEFINITION', `AcDb${cap}Definition`, false);
    }
    if (geoData) cls(CLS_GEODATA, 'GEODATA', 'AcDbGeoData', false);
    /* the application classes behind the proxies being passed through */
    for (const [dxfName, c] of proxyClsH) {
      cls(c.num, dxfName, c.cpp, c.ent, c.app);
    }
    if (usesDynBlocks) {
      cls(CLS_BLOCKVIS, 'BLOCKVISIBILITYPARAMETER',
        'AcDbBlockVisibilityParameter', false, 'ObjectDBX Classes');
    }
    if (noClasses) {
      /* the benign stub record that keeps the 2018 section non-empty */
      cls(500, 'VISUALSTYLE', 'AcDbVisualStyle', false, 'ObjectDBX Classes');
    }
    if (strW) {
      clsW.strTarget = undefined;
      const strSize = strW.pos;
      clsW.appendBits(strW);
      clsW.rs(strSize & 0x7fff);
      clsW.b(1);                          /* strings-present flag */
      clsW.patchRl(sizePos, clsW.pos - sizePos);
    }
    clsW.align();
    return clsW.bytes();
  }

  /* ---------------- assemble the file ---------------- */
  if (V >= 2004) {
    return {
      data: assemble2004(hvBytes(), clsBytes(), objects, handseed,
        V === 2018 ? 2018 : V === 2007 ? 2007 : 2004, undefined,
        acdsSection),
      downgraded,
      skipped
    };
  }
  const out: number[] = [];
  const push = (bytes: Uint8Array | readonly number[]): void => {
    for (let i = 0; i < bytes.length; i++) out.push((bytes as Uint8Array)[i] as number);
  };
  const pushRS = (v: number): void => { out.push(v & 0xff, (v >> 8) & 0xff); };
  const pushRL = (v: number): void => { pushRS(v & 0xffff); pushRS(Math.floor(v / 0x10000)); };

  /** Sentinel-wrapped section; returns [address, sizeInLocator]. */
  const emitSection = (
    begin: readonly number[], end: readonly number[], data: Uint8Array
  ): [number, number] => {
    const addr = out.length;
    push(begin);
    const sizeStart = out.length;
    pushRL(data.length);
    push(data);
    const arr = Uint8Array.from(out.slice(sizeStart));
    pushRS(crc16(0xC0C1, arr));
    push(end);
    return [addr, out.length - addr];
  };

  /* file header: 6 sections */
  /* AC1012 R13, AC1014 R14, AC1015 R2000 — one flat container, three
     signatures. The acad version byte at 0x11 tracks it. */
  const SIG = V === 13 ? 'AC1012' : V === 14 ? 'AC1014' : 'AC1015';
  push([...SIG].map((c) => c.charCodeAt(0)));
  push([0, 0, 0, 0, 0]);                        /* 0x06..0x0A */
  out.push(0x0f);                               /* 0x0B maint */
  out.push(0x01);                               /* 0x0C */
  const previewAddrPos = out.length;
  pushRL(0);                                    /* 0x0D thumbnail address */
  out.push(V === 13 ? 0x0e : V === 14 ? 0x11 : 0x17);   /* 0x11 acad version */
  out.push(0x0f);                               /* 0x12 maint */
  pushRS(30);                                   /* 0x13 codepage ANSI_1252 */
  /* R13/R14 native files carry FIVE locator entries (ObjFreeSpace id 3
     zeroed, no AuxHeader id 5) — verified against AutoCAD-2027-minted
     R14 output. R2000 keeps the six-section layout. */
  const NLOC = V <= 14 ? 5 : 6;
  pushRL(NLOC);                                 /* 0x15 section count */
  const locatorPos = out.length;
  for (let i = 0; i < NLOC; i++) { out.push(0); pushRL(0); pushRL(0); }
  const crcPos = out.length;
  pushRS(0);                                    /* CRC patched later */
  push(SN_HEADER_END);

  /* preview (empty) */
  const previewAddr = out.length;
  push(SN_PREVIEW_BEGIN);
  pushRL(5);
  out.push(0);                                  /* zero images */
  push(SN_PREVIEW_END);

  /* header vars section (0) */
  const [hdrAddr, hdrSize] = emitSection(SN_VARS_BEGIN, SN_VARS_END, hvBytes());

  /* classes section (1): class records for the class entities in use */
  const [clsAddr, clsSize] = emitSection(SN_CLASS_BEGIN, SN_CLASS_END, clsBytes());

  /* objects data area */
  const objStart = out.length;
  const mapEntries: { handle: number; offset: number }[] = [];
  for (const obj of objects.sort((a, b) => a.handle - b.handle)) {
    const offset = out.length;
    mapEntries.push({ handle: obj.handle, offset });
    /* MS size prefix */
    const size = obj.bytes.length;
    const msParts: number[] = [];
    let v = size;
    for (;;) {
      const lo = v % 0x8000;
      v = Math.floor(v / 0x8000);
      if (v === 0) { msParts.push(lo); break; }
      msParts.push(lo | 0x8000);
    }
    for (const p of msParts) pushRS(p);
    push(obj.bytes);
    const whole = Uint8Array.from(out.slice(offset));
    pushRS(crc16(0xC0C1, whole));
  }

  /* object map section (2) */
  const mapAddr = out.length;
  {
    let idx = 0;
    while (idx < mapEntries.length) {
      const pageStart = out.length;
      pushRS(0);                                /* BE size patched below */
      let lastH = 0, lastOff = 0;
      const startIdx = idx;
      while (idx < mapEntries.length && out.length - pageStart < 2000) {
        const en = mapEntries[idx++];
        /* handle delta as byte-aligned UMC */
        let dh = en.handle - lastH;
        for (;;) {
          const lo = dh % 128;
          dh = Math.floor(dh / 128);
          if (dh === 0) { out.push(lo); break; }
          out.push(lo | 0x80);
        }
        /* offset delta as byte-aligned MC (sign bit 0x40 in final byte) */
        const neg = en.offset < lastOff;
        let m = Math.abs(en.offset - lastOff);
        const parts: number[] = [];
        for (;;) {
          const lo = m & 0x7f;
          m = Math.floor(m / 128);
          parts.push(lo);
          if (m === 0) break;
        }
        if (parts[parts.length - 1] & 0x40) parts.push(0);
        if (neg) parts[parts.length - 1] |= 0x40;
        for (let i = 0; i < parts.length; i++) {
          out.push(parts[i] | (i < parts.length - 1 ? 0x80 : 0));
        }
        lastH = en.handle;
        lastOff = en.offset;
      }
      void startIdx;
      const pageSize = out.length - pageStart;
      out[pageStart] = (pageSize >> 8) & 0xff;    /* big-endian size */
      out[pageStart + 1] = pageSize & 0xff;
      const pageArr = Uint8Array.from(out.slice(pageStart));
      const crc = crc16(0xC0C1, pageArr);
      out.push((crc >> 8) & 0xff, crc & 0xff);    /* big-endian CRC */
    }
    /* terminator page */
    const tStart = out.length;
    out.push(0, 2);
    const tcrc = crc16(0xC0C1, Uint8Array.from(out.slice(tStart)));
    out.push((tcrc >> 8) & 0xff, tcrc & 0xff);
  }
  const mapSize = out.length - mapAddr;

  /* ObjFreeSpace section (3). R14 native files zero the locator entry and
     carry no body — but R13 files do NOT: every AC1012 file carries the
     53-byte record right behind the object map, registered in the locator
     table AND in the second header. AutoCAD 2027's R13 loader refuses a
     file without it (ErrorStatus 53) while accepting the byte-identical
     R14 twin, which is what makes this the R13-only difference. */
  let ofsAddr = 0, ofsSize = 0;
  if (V !== 14) {
    ofsAddr = out.length;
    pushRL(0);                                  /* zero */
    pushRL(objects.length);                     /* numhandles */
    pushRL(2451545); pushRL(0);                 /* TDUPDATE */
    pushRL(objStart);                           /* objects_address */
    out.push(4);                                /* numnums */
    pushRL(0x32); pushRL(0);
    pushRL(0x64); pushRL(0);
    pushRL(0x200); pushRL(0);
    pushRL(0xffffffff); pushRL(0);
    ofsSize = out.length - ofsAddr;
  }

  /* Template section (4): T16 description + RS measurement */
  const tplAddr = out.length;
  pushRS(0);                                    /* empty description */
  pushRS(1);                                    /* MEASUREMENT: metric */
  const tplSize = out.length - tplAddr;

  /* AuxHeader section (5) — R2000 only; absent from native R13/R14. */
  let auxAddr = 0, auxSize = 0;
  if (V > 14) {
    auxAddr = out.length;
    push([0xff, 0x77, 0x01]);
    pushRS(0x17); pushRS(0x0f);                 /* dwg/maint version */
    pushRL(1);                                  /* numsaves */
    pushRL(0xffffffff);                         /* -1 */
    pushRS(1); pushRS(0);                       /* numsaves 1/2 */
    pushRL(0);
    pushRS(0x17); pushRS(0x0f);
    pushRS(0x17); pushRS(0x0f);
    for (const v of [5, 0x893, 5, 0x893, 0, 1]) pushRS(v);
    for (let i = 0; i < 5; i++) pushRL(0);
    pushRL(2451545); pushRL(0);                 /* TDCREATE */
    pushRL(2451545); pushRL(0);                 /* TDUPDATE */
    pushRL(handseed); pushRL(0);                /* HANDSEED RLL */
    pushRS(0); pushRS(1);
    pushRL(0); pushRL(0); pushRL(0);
    pushRL(1); pushRL(0); pushRL(0);
    auxSize = out.length - auxAddr;
  }

  /* second header */
  {
    push(SN_2ND_BEGIN);
    const w = new BitWriter();
    const secondAddr = out.length - 16;
    w.rl(0);                                    /* size placeholder */
    const sizePos = 0;
    w.bl(secondAddr);
    /* version TFF 11 bytes + terminator convention */
    const ver = SIG;
    for (let i = 0; i < 11; i++) w.rc(i < ver.length ? ver.charCodeAt(i) : 0);
    w.rc(0x0f);                                 /* maint release */
    w.rc(V <= 14 ? 1 : 3);                      /* zero-one-or-three */
    /* dwg+maint version word: must AGREE with header bytes 0x11/0x12 —
       a second header claiming R2000 (0x17) inside an AC1012/AC1014
       file is a lie the R13/R14 loader can trip over. */
    w.bs(0x0f00 | (V === 13 ? 0x0e : V === 14 ? 0x11 : 0x17));
    w.rs(30);                                   /* codepage */
    /* native R14: five section records with ObjFreeSpace (3) AND the
       template (4) zeroed — verified against AutoCAD-2027 R14 output.
       R13 fills all five, R2000 all six. */
    const secs: [number, number, number][] = V === 14
      ? [[0, hdrAddr, hdrSize], [1, clsAddr, clsSize], [2, mapAddr, mapSize],
        [3, 0, 0], [4, 0, 0]]
      : V === 13
        ? [[0, hdrAddr, hdrSize], [1, clsAddr, clsSize], [2, mapAddr, mapSize],
          [3, ofsAddr, ofsSize], [4, tplAddr, tplSize]]
        : [[0, hdrAddr, hdrSize], [1, clsAddr, clsSize], [2, mapAddr, mapSize],
          [3, ofsAddr, ofsSize], [4, tplAddr, tplSize], [5, auxAddr, auxSize]];
    w.bs(secs.length);                          /* num sections */
    for (const [nr, addr, size] of secs) {
      w.rc(nr); w.bl(addr); w.bl(size);
    }
    w.bs(14);                                   /* num handles */
    const handleRecs: [number, number][] = [
      [0, handseed], [1, blockControl], [2, layerControl], [3, styleControl],
      [4, ltypeControl], [5, viewControl], [6, ucsControl], [7, vportControl],
      [8, appidControl], [9, dimstyleControl], [10, vxControl],
      [11, nod], [12, mlineDict], [13, groupDict]
    ];
    for (const [nr, h] of handleRecs) {
      const bytesOut: number[] = [];
      let v = h;
      while (v > 0) { bytesOut.unshift(v % 256); v = Math.floor(v / 256); }
      if (!bytesOut.length) bytesOut.push(0);
      w.rc(bytesOut.length);
      w.rc(nr);
      for (const bv of bytesOut) w.rc(bv);
    }
    if (V === 14) {
      /* native R14 second headers carry ~68 bits of (uninitialized) tail
         before the closing CRC; no CRC convention verifies over it, so
         zeros are safe — the shape is what is being mirrored */
      for (let i = 0; i < 8; i++) w.rc(0);
    }
    w.align();
    const body = w.bytes();
    /* size = body + CRC */
    const total = body.length + 2;
    body[sizePos] = total & 0xff;
    body[sizePos + 1] = (total >> 8) & 0xff;
    body[sizePos + 2] = (total >> 16) & 0xff;
    body[sizePos + 3] = (total >> 24) & 0xff;
    push(body);
    pushRS(crc16(0xC0C1, body));
    push(SN_2ND_END);
  }

  /* patch locators + thumbnail address + file header CRC */
  const data = Uint8Array.from(out);
  const dv = new DataView(data.buffer);
  dv.setUint32(previewAddrPos, previewAddr, true);
  const locs: [number, number, number][] = V === 14
    ? [[0, hdrAddr, hdrSize], [1, clsAddr, clsSize], [2, mapAddr, mapSize],
      [3, 0, 0], [4, tplAddr, tplSize]]
    : V === 13
      ? [[0, hdrAddr, hdrSize], [1, clsAddr, clsSize], [2, mapAddr, mapSize],
        [3, ofsAddr, ofsSize], [4, tplAddr, tplSize]]
      : [[0, hdrAddr, hdrSize], [1, clsAddr, clsSize], [2, mapAddr, mapSize],
        [3, ofsAddr, ofsSize], [4, tplAddr, tplSize], [5, auxAddr, auxSize]];
  locs.forEach(([id, addr, size], i) => {
    const p = locatorPos + i * 9;
    data[p] = id;
    dv.setUint32(p + 1, addr, true);
    dv.setUint32(p + 5, size, true);
  });
  const crc = crc16(0xC0C1, data, 0, crcPos);
  dv.setUint16(crcPos, crc, true);

  return { data, skipped, downgraded };
};
