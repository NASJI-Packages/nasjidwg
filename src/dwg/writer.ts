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

import { BitWriter, ByteSink, crc16 } from './bitwriter.js';
import { BitReader } from './bitstream.js';
import { compressR2004 } from './compress.js';
import { SEAL_MAGIC, encodingGroup, resbufKind } from './objects.js';
import { assemble2007 } from './container2007.js';
import { buildAcDs } from './meta.js';
import { sabToSat } from '../acis/sab.js';
import { nearestAci } from '../core/color.js';
import type {
  Color, DimStyle, Drawing, DrawingVariable, Entity, Group, Layer, Linetype, MLeaderStyle,
  MLineStyle, Point2, Point3,
  PolylineVertex, TableCell, TableStyle, TableStyleCell, TextEntity, TextStyle,
  Ucs, View, XdataGroup, XdataValue
} from '../core/model.js';
import { shapeArabic, mirrorBrackets, hasComplexScript } from '../text/arabic.js';
import { flattenMtextParagraphs } from '../text/mtext.js';
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
  acds?: Uint8Array,
  /** The preview image: PNG for R2013+ (2018 here), DIB for R2004. */
  preview?: { png?: Uint8Array; bmp?: Uint8Array }
): Uint8Array {
  const out = new ByteSink();
  const push = (b: Uint8Array | readonly number[]): void => { out.append(b); };
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
  const objBytes = new ByteSink();
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
    objBytes.append(obj.bytes);
    const crc = crc16(0xC0C1, objBytes.view(offset));
    objBytes.push(crc & 0xff, (crc >> 8) & 0xff);
  }
  const objectsSec = objBytes.bytes();

  const mapBytes = new ByteSink();
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
      mapBytes.set(pageStart, (pageSize >> 8) & 0xff);
      mapBytes.set(pageStart + 1, pageSize & 0xff);
      const crc = crc16(0xC0C1, mapBytes.view(pageStart));
      mapBytes.push((crc >> 8) & 0xff, crc & 0xff);
    }
    const tStart = mapBytes.length;
    mapBytes.push(0, 2);
    const tcrc = crc16(0xC0C1, mapBytes.view(tStart));
    mapBytes.push((tcrc >> 8) & 0xff, tcrc & 0xff);
  }
  const handlesSec = mapBytes.bytes();

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

  /* The preview: a stored (never compressed) page, first in the file —
   * the reference puts it at 0x1A0 behind SummaryInfo, this writer at
   * 0x100 — so the seeker at 0x0D, an absolute offset, can point at raw
   * sentinel bytes. PNG is R2013+ only; 2004 takes the DIB. */
  const previewImage: { type: 2 | 6; data: Uint8Array } | null =
    preview?.png && version === 2018 ? { type: 6, data: preview.png }
      : preview?.bmp ? { type: 2, data: asDib(preview.bmp) } : null;
  const PREVIEW_DATA_AT = 0x100 + 32;
  if (previewImage) sections.push({ name: 'AcDb:Preview', data: previewBlock(PREVIEW_DATA_AT, [previewImage]) });

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
    'AcDb:AcDsPrototype_1b': 9, 'AcDb:Preview': 10
  };
  /* The preview is the one section stored rather than compressed, on a
   * page whose window is its own length rounded up to 1 KiB — what the
   * reference declares for it — so the seeker finds raw bytes. */
  const STORED: Record<string, true> = { 'AcDb:Preview': true };
  const capOf = (sec: { name: string; data: Uint8Array }): number =>
    STORED[sec.name] ? Math.max(0x400, (sec.data.length + 0x3ff) & ~0x3ff) : PAGE_CAP;

  /* Data sections are cut into pages holding this many decompressed
   * bytes each. Every page inflates to the full page size: the last
   * slice is zero-padded before compression, because AutoCAD's reader
   * decompresses whole pages and treats a short stream as corruption. */
  const PAGE_CAP = 0x7400;

  /* Stream order (what sits where in the file) mirrors real files:
   * objects first, header last, then the two system pages. The section
   * map lists them in the same order, ids descending to 1. */
  const streamOrder = ['AcDb:Preview', 'AcDb:AcDsPrototype_1b', 'AcDb:RevHistory',
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
    payload: Uint8Array;                        /* compressed slice, or the raw window */
    secIdx: number; chunk: number;              /* which slice of which section */
    cap: number;                                /* the window this section's pages hold */
  }
  const dataPages: PagePlan[] = [];
  let cursor = 0x100;
  let nextPage = 1;
  ordered.forEach((sec, secIdx) => {
    const cap = capOf(sec);
    const pageCount = Math.max(1, Math.ceil(sec.data.length / cap));
    for (let k = 0; k < pageCount; k++) {
      /* the whole window, zero-padded: AutoCAD inflates full pages */
      const window = new Uint8Array(cap);
      window.set(sec.data.subarray(k * cap,
        Math.min((k + 1) * cap, sec.data.length)));
      const payload = STORED[sec.name] ? window : compressR2004(window);
      const diskSize = align32(32 + payload.length);
      dataPages.push({
        number: nextPage++, address: cursor, diskSize, payload, secIdx, chunk: k, cap
      });
      cursor += diskSize;
    }
  });
  /* the preview, when there is one, is the first page: its bytes begin
   * right after that page's 32-byte header */
  const previewSeeker = ordered[0]?.name === 'AcDb:Preview' ? PREVIEW_DATA_AT : 0;
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
  u32(previewSeeker);                           /* 0x0D preview address (0 = none) */
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
    hv.setUint32(16, p.chunk * p.cap, true);    /* start offset (64-bit) */
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
    pages: { number: number; size: number; offset: number }[],
    cap = PAGE_CAP, stored = false
  ): void => {
    smU64(size);                                /* logical section size */
    smU32(pages.length);                        /* page count */
    smU32(cap);                                 /* max decompressed page size */
    smU32(1);                                   /* unknown, always 1 */
    smU32(stored ? 1 : 2);                      /* compression: 1 = stored, 2 = LZ77 */
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
        number: p.number, size: p.payload.length, offset: p.chunk * p.cap
      })), capOf(sec), !!STORED[sec.name]);
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
      out.set(encHeaderAt + i, dec[i] ^ ((x >>> 16) & 0xff));
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
    for (let i = 0; i < 0x6c; i++) out.push(out.at(encHeaderAt + i));
  }
  void handseed;
  return out.bytes();
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

/** Inverse of parseEed: typed XDATA values as a raw EED payload. */
const encodeEedValues = (values: XdataValue[], v: number): Uint8Array => {
  const w = new BitWriter();
  for (const val of values) {
    if ('point' in val && val.point) {
      const code = val.code >= 1000 ? val.code - 1000 : val.code;
      w.rc(code);
      w.rd(val.point.x); w.rd(val.point.y); w.rd(val.point.z ?? 0);
      continue;
    }
    const raw = val.code >= 1000 ? val.code - 1000 : val.code;
    const value = 'value' in val ? val.value : '';
    if (raw === 0) {
      const s = String(value);
      w.rc(0);
      if (v >= 2007) {
        w.rs(s.length);
        for (let i = 0; i < s.length; i++) w.rs(s.charCodeAt(i));
      } else {
        const bytes: number[] = [];
        for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
        w.rc(bytes.length);
        /* ANSI_1252, matching the file — stored high byte first: the
           reference writes 00 1E, and audits a string group inside 1002
           braces whose word is the other way round ("XData format
           Problem", 612 attributes of a campaign round) */
        w.rc(0); w.rc(30);
        w.raw(bytes);
      }
    } else if (raw === 2) {
      w.rc(2);
      w.rc(value === '}' ? 1 : 0);
    } else if (raw === 3 || raw === 5) {
      w.rc(raw);
      let n = typeof value === 'number' ? value : parseInt(String(value), 16);
      if (!Number.isFinite(n) || n < 0) n = 0;
      const bytes = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 7; i >= 0; i--) {
        bytes[i] = n % 256;
        n = Math.floor(n / 256);
      }
      w.raw(bytes);
    } else if (raw === 4) {
      const hex = String(value).replace(/[^0-9a-fA-F]/g, '');
      const n = Math.min(255, hex.length >> 1);
      w.rc(4);
      w.rc(n);
      for (let i = 0; i < n; i++) {
        w.rc(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
      }
    } else if (raw >= 40 && raw <= 42) {
      w.rc(raw);
      w.rd(typeof value === 'number' ? value : 0);
    } else if (raw === 70) {
      w.rc(70);
      w.rs(typeof value === 'number' ? value : 0);
    } else if (raw === 71) {
      w.rc(71);
      w.rl(typeof value === 'number' ? value : 0);
    }
  }
  return w.bytes();
};

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

  /** The preview image the file carries for file managers and open
   *  dialogs — the picture a thumbnail handler or a CAD's Open dialog
   *  shows before the drawing is read. Two encodings, because releases
   *  differ in what they accept: `png` is written into R2013+ files
   *  (AC1032 here), `bmp` — a Windows DIB, with or without its 14-byte
   *  file header — into every earlier release. A file gets whichever of
   *  the two its version can hold; supply both to cover any target. The
   *  R2007 container carries no preview from this writer yet. */
  preview?: { png?: Uint8Array; bmp?: Uint8Array };
}

/** The preview block as every release lays it out: the sentinel, the
 *  overall size, the image count, one (type, address, size) row per
 *  image and then the images. Type 1 is an 80-byte header block the
 *  reference writes as zeros, type 2 a DIB, type 6 a PNG. Addresses are
 *  absolute file offsets, so the block needs to know where it will sit. */
const previewBlock = (
  base: number, images: { type: 2 | 6; data: Uint8Array }[]
): Uint8Array => {
  const HEADER = 80;
  const rows = 1 + images.length;
  const dataStart = base + 16 + 4 + 1 + rows * 9;
  const overall = 1 + rows * 9 + HEADER + images.reduce((n, i) => n + i.data.length, 0);
  const out: number[] = [];
  const u32 = (v: number): void => { out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
  out.push(...SN_PREVIEW_BEGIN);
  u32(overall);
  out.push(rows);
  out.push(1); u32(dataStart); u32(HEADER);
  let at = dataStart + HEADER;
  for (const img of images) { out.push(img.type); u32(at); u32(img.data.length); at += img.data.length; }
  for (let i = 0; i < HEADER; i++) out.push(0);
  const bytes = new Uint8Array(out.length + images.reduce((n, i) => n + i.data.length, 0));
  bytes.set(out);
  let p = out.length;
  for (const img of images) { bytes.set(img.data, p); p += img.data.length; }
  return bytes;
};

/** A DIB from what the caller gave: a whole .bmp file loses its 14-byte
 *  file header, a bare DIB passes through. */
const asDib = (bmp: Uint8Array): Uint8Array =>
  bmp.length > 14 && bmp[0] === 0x42 && bmp[1] === 0x4D ? bmp.subarray(14) : bmp;

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

/** The drawing with an anonymous `*T<n>` block behind every ACAD_TABLE
 *  that does not already name one. A table's block record holds its
 *  drawn geometry; the reference regenerates that geometry on open, so
 *  an empty block serves, but the record itself must exist once the
 *  table points at a real TABLESTYLE — with a NULL block header beside
 *  a non-NULL style the reference audits "BTR Id invalid" and erases the
 *  table (externally proven on the corpus and the reference's own
 *  samples; the same table with a NULL style audited clean). A table
 *  read from a file keeps the `*T` block it came with. The caller's
 *  model is left untouched: only the containers a table sits in are
 *  copied. */
const withTableBlocks = (drawing: Drawing): Drawing => {
  const blocks = { ...drawing.blocks };
  let n = 0;
  const nextName = (): string => {
    for (;;) {
      const nm = `*T${++n}`;
      if (!Object.keys(blocks).some((k) => k.toLowerCase() === nm.toLowerCase())) return nm;
    }
  };
  let changed = false;
  const mapList = (list: Entity[]): Entity[] => list.map((e) => {
    if (e.type !== 'table') return e;
    if (e.blockName && /^\*T/i.test(e.blockName) && blocks[e.blockName]) return e;
    const name = nextName();
    blocks[name] = { name, basePoint: { x: 0, y: 0, z: 0 }, entities: [] };
    changed = true;
    return { ...e, blockName: name };
  });
  const entities = mapList(drawing.entities);
  const paperSpace = drawing.paperSpace ? mapList(drawing.paperSpace) : undefined;
  for (const [nm, b] of Object.entries(drawing.blocks)) {
    if (!b.entities.some((e) => e.type === 'table')) continue;
    blocks[nm] = { ...b, entities: mapList(b.entities) };
  }
  if (!changed) return drawing;
  return { ...drawing, blocks, entities, ...(paperSpace ? { paperSpace } : {}) };
};

const writeDwgImpl = (
  source: Drawing, V: 13 | 14 | 2000 | 2004 | 2007 | 2018,
  opts: DwgWriteOptions = {}
): DwgWriteResult => {
  const skipped: string[] = [];
  const drawing = withTableBlocks(source);

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
    const scanEnt = (e: Entity): void => {
      scanH(e.handle);
      if (e.type === 'insert') {
        for (const a of e.attributes ?? []) scanH(a.handle);
      }
    };
    for (const e of drawing.entities) scanEnt(e);
    for (const e of drawing.paperSpace ?? []) scanEnt(e);
    for (const b of Object.values(drawing.blocks)) {
      for (const e of b.entities) scanEnt(e);
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
    /* and the rest of what keeps its number: layouts, views, viewports,
       dimension styles, groups, the table and multileader styles, the
       structural objects (controls, the root and its sub-dictionaries) */
    for (const l of drawing.layouts ?? []) scanH(l.handle);
    for (const vw of drawing.views ?? []) scanH(vw.handle);
    for (const vp of drawing.vports ?? []) scanH(vp.handle);
    for (const ds of drawing.dimStyles ?? []) scanH(ds.handle);
    for (const g of drawing.groups ?? []) scanH(g.handle);
    for (const s of drawing.tableStyles ?? []) scanH(s.handle);
    for (const s of drawing.mleaderStyles ?? []) scanH(s.handle);
    /* the multiline styles, the named coordinate systems and the
       variable dictionary's records keep their numbers too — A-01's
       highest handles are its DICTIONARYVARs, and a watermark below
       them minted fresh numbers over the kept ones (two objects under
       one handle: the reference read LIGHTINGUNITS 2 for a record that
       said 0, and refused the file once nothing else sat above) */
    for (const s of drawing.mlineStyles ?? []) scanH(s.handle);
    for (const u of drawing.ucs ?? []) scanH(u.handle);
    for (const v of drawing.variables ?? []) scanH(v.handle);
    for (const h of Object.values(drawing.structureHandles ?? {})) scanH(h);
  }
  let nextHandle = maxSrc;
  const H = (): number => ++nextHandle;
  const usedH = new Set<number>();
  /** The entity's own handle when preserving and it is free, else fresh. */
  /** Every source handle that got a number in this file, and which one:
   *  what a retained reference is rewritten through, so a sealed record
   *  points at the object it pointed at whether the numbering stayed or
   *  moved, and at nothing (0) when its target stayed home. */
  const oldToNew = new Map<number, number>();
  const keepH = (h?: string): number => {
    const old = h ? parseInt(h, 16) : NaN;
    if (preserve && h) {
      if (Number.isFinite(old) && old > 0 && !usedH.has(old)) {
        usedH.add(old);
        oldToNew.set(old, old);
        return old;
      }
    }
    const n = H();
    if (Number.isFinite(old) && old > 0 && !oldToNew.has(old)) oldToNew.set(old, n);
    return n;
  };
  /** The handle a leader's annotation got in this file, or 0 when the
   *  entity it annotates is not being written. */
  const leaderAnnotationH = (e: { annotation?: string }): number => {
    if (!e.annotation) return 0;
    const old = parseInt(e.annotation, 16);
    return Number.isFinite(old) && old > 0 ? (oldToNew.get(old) ?? 0) : 0;
  };
  const mapRef = (value: string): number => {
    const old = parseInt(value, 16);
    if (!Number.isFinite(old) || old <= 0) return 0;
    /* a target this file numbered is followed to its new number; any
       other reference keeps the number it was, code-for-code, the way the
       proxy contract always promised (a hard reference to an object that
       stayed home never gets this far: its record was skipped above) */
    return oldToNew.get(old) ?? old;
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
  /* The structural objects — the symbol-table controls, the root
     dictionary and the sub-dictionaries this writer rebuilds — keep the
     source's numbers under preserveHandles like everything else (the
     reader lists them in `structureHandles`): a sealed extension
     dictionary owned by one of them (the layer table's ACAD_LAYERSTATES,
     ACAD_LAYERFILTERS) follows the number to the object built here. */
  const sh = (key: string): string | undefined => drawing.structureHandles?.[key];
  const blockControl = keepH(sh('BLOCK_CONTROL')), layerControl = keepH(sh('LAYER_CONTROL')),
    styleControl = keepH(sh('STYLE_CONTROL')), ltypeControl = keepH(sh('LTYPE_CONTROL')),
    viewControl = keepH(sh('VIEW_CONTROL')), ucsControl = keepH(sh('UCS_CONTROL')),
    vportControl = keepH(sh('VPORT_CONTROL')), appidControl = keepH(sh('APPID_CONTROL')),
    dimstyleControl = keepH(sh('DIMSTYLE_CONTROL')), vxControl = keepH(sh('VX_CONTROL'));
  const nod = keepH(sh('NOD')), groupDict = keepH(sh('ACAD_GROUP')),
    mlineDict = keepH(sh('ACAD_MLINESTYLE'));
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
  const layoutDict = keepH(sh('ACAD_LAYOUT'));
  /* the active model viewport: the drawing's own record when it has one
     (its number and extension dictionary kept), defaults otherwise */
  const activeVport = (drawing.vports ?? []).find((p) => /^\*active$/i.test(p.name));
  const vportActive = keepH(activeVport?.handle);

  /* An external reference's own layers, linetypes and text styles
     (`xref|name`) exist only while that file is attached. They travel
     only beside a block record written as that attachment — flagged
     xref-dependent, the block's handle in their head, the form the
     reference's own saves take. Written as ordinary records they are
     audited one by one ("Non XREF-dependent record contains vertical
     bar" — 8206 of a campaign round's 9000 findings), so the rest stay
     home, counted once. R13/R14 spell the attachment the same way (the
     reference's own R14 save of A-01, bit-walked: flags, path, no
     entity chain), so every release writes it. */
  const xrefBlockNames = new Set<string>(Object.keys(drawing.blocks)
    .filter((nm) => drawing.blocks[nm].xref && !drawing.blocks[nm].isLayout
      && !/^\*(model_space|paper_space)/i.test(nm))
    .map((nm) => nm.toLowerCase()));
  /** The attachment an `xref|name` record belongs to, when that block is
   *  written as one: its lower-cased name; else undefined. */
  const xrefOf = (name: string): string | undefined => {
    const bar = name.indexOf('|');
    if (bar <= 0) return undefined;
    const owner = name.slice(0, bar).toLowerCase();
    return xrefBlockNames.has(owner) ? owner : undefined;
  };
  const travels = (r: { name: string; xrefDependent?: boolean }): boolean =>
    !r.xrefDependent || xrefOf(r.name) !== undefined;
  const xrefRecords = drawing.layers.filter((l) => !travels(l)).length
    + drawing.linetypes.filter((l) => !travels(l)).length
    + drawing.textStyles.filter((s) => !travels(s)).length;
  if (xrefRecords) skipped.push(`${xrefRecords} xref-dependent table records`);
  const ownLayers = drawing.layers.filter(travels);
  const layers: Layer[] = ownLayers.length ? ownLayers : [{
    name: '0', color: { kind: 'aci', index: 7 } as const,
    on: true, frozen: false, locked: false
  }];
  const layerH = new Map<string, number>();
  for (const ly of layers) layerH.set(ly.name, tableH(ly.handle));

  /* A shape-file record that shares its name with a text style (the
     reference's own "Standard" beside the shape "Standard") cannot be
     told apart by name here — the tables are keyed by name — and two
     records under one name are audited ("Id Repeated in table"). The
     shape record goes; a shape file of its own name stays, flag and all. */
  const ownStyles = drawing.textStyles.filter(travels)
    .filter((s, i, all) => !(s.shapeFile
      && all.some((o) => o !== s && !o.shapeFile && o.name.toLowerCase() === s.name.toLowerCase())));
  /* a shape-file record spelled `xref|name` that is not an external
     reference's is what a detached reference leaves behind; the reference
     audits it by name ("Non XREF-dependent record contains vertical bar"),
     and nothing in the drawing can name a shape record, so it stays home */
  const orphanShapes = ownStyles.filter((s) => s.shapeFile && s.name.includes('|') && !s.xrefDependent);
  if (orphanShapes.length) skipped.push(`${orphanShapes.length} orphan shape-file style records`);
  const keptStyles = ownStyles.filter((s) => !orphanShapes.includes(s));
  const styles: TextStyle[] = keptStyles.length ? keptStyles : [{ name: 'Standard' }];
  const styleH = new Map<string, number>();
  for (const st of styles) styleH.set(st.name, tableH(st.handle));

  const userLtypes: Linetype[] = drawing.linetypes
    .filter((lt) => !/^(bylayer|byblock)$/i.test(lt.name) && travels(lt));
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
  for (const ds of dimStyles) dimStyleH.set(ds.name.toLowerCase(), keepH(ds.handle));
  const dimStandardH = dimStyleH.get('standard')!;
  /* the named views, every one of them a record of its own (the
     reference keeps a view's thumbnail in its extension dictionary) */
  const views: View[] = drawing.views ?? [];
  const viewH = views.map((vw) => keepH(vw.handle));
  /* the entity groups, listed by name under ACAD_GROUP */
  const groupsOut: Group[] = drawing.groups ?? [];
  const groupH = groupsOut.map((g) => keepH(g.handle));
  /* the named coordinate systems: one UCS table record each (one per
     name), what the header's UCSNAME / PUCSNAME and an orthographic
     UCS's base point at */
  const ucsOut: Ucs[] = [];
  for (const u of drawing.ucs ?? []) {
    if (!u.name || ucsOut.some((o) => o.name.toLowerCase() === u.name.toLowerCase())) continue;
    ucsOut.push(u);
  }
  const ucsH = ucsOut.map((u) => keepH(u.handle));
  const ucsRef = (name?: unknown): number => {
    if (typeof name !== 'string' || !name) return 0;
    const i = ucsOut.findIndex((u) => u.name.toLowerCase() === name.toLowerCase());
    return i >= 0 ? ucsH[i] : 0;
  };
  const dimStyleRef = (name?: string): number =>
    (name && dimStyleH.get(name.toLowerCase())) || dimStandardH;
  /* Every release gets the MLINESTYLE "STANDARD" object under an
     ACAD_MLINESTYLE dictionary entry: R13/R14 refuse to open without it,
     and R2000+ audits flag any MLINE whose style handle is NULL, so the
     record exists everywhere and MLINE + header CMLSTYLE point at it.
     The drawing's own styles go out beside it — one record per name,
     the source's "Standard" in place of the synthesized one — and every
     MLINE points at the record its styleName names, else at STANDARD. */
  const mlineStandard: MLineStyle = {
    name: 'STANDARD', startAngle: Math.PI / 2, endAngle: Math.PI / 2,
    elements: [
      { offset: 0.5, color: { kind: 'byLayer' } },
      { offset: -0.5, color: { kind: 'byLayer' } }
    ]
  };
  const mlineStylesOut: MLineStyle[] = [];
  for (const s of [...(drawing.mlineStyles ?? []), mlineStandard]) {
    if (!s.name) continue;
    if (mlineStylesOut.some((o) => o.name.toLowerCase() === s.name.toLowerCase())) continue;
    mlineStylesOut.push(s);
  }
  const mlineStyleH = new Map<string, number>();     /* lower-cased name */
  for (const s of mlineStylesOut) mlineStyleH.set(s.name.toLowerCase(), keepH(s.handle));
  const mlineStandardH = mlineStyleH.get('standard')!;
  const mlineStyleFor = (name?: unknown): number =>
    (typeof name === 'string' && mlineStyleH.get(name.toLowerCase())) || mlineStandardH;

  /* block headers: model, paper, then user blocks */
  const msBH = H(), psBH = H();
  /* Every layout beyond the current paper space arrives as a block named
     *Paper_Space<n> (both readers keep them that way, linked from
     drawing.layouts by blockName). From R2000 on they go out as what
     they are — a block header of their own, its entities owned by it,
     and a LAYOUT object behind a tab — riding the user-block plumbing
     below; R13/R14 know a single paper space, so there they are
     reported. */
  const isExtraPaper = (nm: string): boolean => /^\*paper_space.+$/i.test(nm);
  const extraPaperBlocks = V >= 2000
    ? Object.keys(drawing.blocks).filter(isExtraPaper) : [];
  if (V < 2000) {
    for (const nm of Object.keys(drawing.blocks).filter(isExtraPaper)) {
      skipped.push(`layout ${nm} (needs R2000 or later)`);
    }
  }
  /* The layouts behind the two space blocks. The blocks themselves are
     not in drawing.blocks, so the layout record is what remembers their
     source numbers: a sealed record owned by *Model_Space or the current
     paper space (a draw-order dictionary, a round-trip record) follows
     that number to the block header written here. */
  const layoutMetas = drawing.layouts ?? [];
  const modelMeta = layoutMetas.find((l) => /^model$/i.test(l.name));
  /* the current paper space's layout: the one naming no extra block
     (drawing.paperSpace is its content) */
  const paperMeta = layoutMetas.find((l) => !/^model$/i.test(l.name)
      && !(l.blockName && isExtraPaper(l.blockName)))
    ?? layoutMetas.find((l) => !/^model$/i.test(l.name));
  /* the LAYOUT objects behind the tabs keep their numbers as well (their
     extension dictionaries hang off them): the two space layouts, then
     one per further paper-space block */
  const layoutModelH = keepH(modelMeta?.handle);
  const layoutPaperH = keepH(paperMeta?.handle);
  const extraLayouts = extraPaperBlocks.map((nm) => {
    const meta = layoutMetas.find((l) => l !== paperMeta
      && l.blockName?.toLowerCase() === nm.toLowerCase());
    return { nm, meta, h: keepH(meta?.handle) };
  });
  const mapSpace = (meta: { blockHandle?: string } | undefined, h: number): void => {
    const old = meta?.blockHandle ? parseInt(meta.blockHandle, 16) : NaN;
    if (Number.isFinite(old) && old > 0 && !oldToNew.has(old)) oldToNew.set(old, h);
  };
  mapSpace(modelMeta, msBH);
  mapSpace(paperMeta, psBH);
  const userBlocks = Object.keys(drawing.blocks)
    .filter((nm) => (V >= 2000 && isExtraPaper(nm))
      || (!/^\*(model_space|paper_space)/i.test(nm) && !drawing.blocks[nm].isLayout));
  const blockH = new Map<string, number>();
  for (const nm of userBlocks) blockH.set(nm, tableH(drawing.blocks[nm].handle));
  /** Block record handle of each attachment written as one, by its
   *  lower-cased name — what an xref-dependent record's head points at. */
  const xrefBlockH = new Map<string, number>();
  for (const nm of userBlocks) {
    if (xrefBlockNames.has(nm.toLowerCase())) xrefBlockH.set(nm.toLowerCase(), blockH.get(nm)!);
  }
  const xrefH = (name: string): number => {
    const owner = xrefOf(name);
    return owner === undefined ? 0 : (xrefBlockH.get(owner) ?? 0);
  };
  const isXrefBlock = (nm: string): boolean => xrefBlockH.has(nm.toLowerCase());

  /* entity lists per owner space */
  const SUPPORTED = new Set([
    'line', 'point', 'circle', 'arc', 'ellipse', 'polyline', 'text', 'mtext',
    'insert', 'spline', 'solid', 'ray', 'xline', 'face3d',
    'dimension', 'hatch', 'mline', 'tolerance', 'shape', 'leader',
    'viewport', 'mesh', 'image', 'acis', 'light', 'table', 'mleader',
    'underlay', 'proxy', 'ole'
  ]);
  /** Entities that exist only as application classes. */
  /* LIGHT and the underlays are application classes younger than R14's
     kernel; ACAD_TABLE and MULTILEADER are classes too, but the reference
     itself writes them into an R14 save (CLASSES 508/520 in its own
     re-saves), and ours reopen there at AUDIT 0 with the census intact —
     so those two travel. */
  const CLASS_ONLY = new Set(['light', 'underlay']);

  const downgraded: string[] = [];
  /** R2018: the solids whose SAB payloads ride the AcDs data section,
   *  collected during entity emission and built into the section once
   *  every record is out (one section carries any number of them). */
  const acdsSolids: { handle: number; sab: Uint8Array }[] = [];
  const filterEnts = (list: Entity[]): Entity[] =>
    list.filter((e) => {
      /* the mirror of staysHome for sealed entities: bits of another
         generation cannot be re-encoded, and an R13/R14 file has no
         envelope the reference accepts them in (A-03's sealed table,
         the one R14 refusal left after the viewport fix) */
      if (e.type === 'unknown' && V < 2000
        && e.data !== undefined && e.encoding !== encodingGroup(V)) {
        skipped.push(e.sourceType ?? 'sealed entity');
        return false;
      }
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

      /* a class younger than the R13/R14 kernel cannot be named there */
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
      /* An INSERT of a block this drawing does not define has no record
         to write. It has to leave the list HERE, before the handles are
         handed out: dropped later, at encoding time, its handle stayed in
         the space's sibling chain (R13-R2000 prev/next, the block
         header's first/last entity) and in the R2004+ owned-entity list,
         and the reference refuses a chain that names a missing object
         (ErrorStatus 53, proven on a block reduced to one line and one
         such insert). */
      if (e.type === 'insert' && !blockH.has(e.blockName)) {
        skipped.push('insert:' + e.blockName);
        return false;
      }
      if (SUPPORTED.has(e.type)) return true;
      skipped.push(e.type);
      return false;
    });
  const modelEnts = filterEnts(drawing.entities);
  /* a layout's first viewport in the file is its paper (number 1, on
     layer 0): the draw order may have moved it in the array, so it goes
     back before the first viewport in the chain — the draw order itself
     still comes from the array through SORTENTSTABLE */
  const paperFirst = (list: Entity[]): Entity[] => {
    const first = list.findIndex((e) => e.type === 'viewport');
    const one = list.findIndex((e) => e.type === 'viewport' && e.id === 1);
    if (first < 0 || one <= first) return list;
    const out = [...list];
    const [vp] = out.splice(one, 1);
    out.splice(first, 0, vp);
    return out;
  };
  const paperEnts = paperFirst(filterEnts(drawing.paperSpace ?? []));
  const blockEnts = new Map<string, Entity[]>();
  for (const nm of userBlocks) {
    /* an attachment's geometry lives in the referenced file: its record
       owns nothing, whatever a consumer left in `entities` */
    if (isXrefBlock(nm)) {
      const n = drawing.blocks[nm].entities.length;
      if (n) skipped.push(`${n} entities inside xref block ${nm}`);
      blockEnts.set(nm, []);
      continue;
    }
    blockEnts.set(nm, isExtraPaper(nm) ? paperFirst(filterEnts(drawing.blocks[nm].entities)) : filterEnts(drawing.blocks[nm].entities));
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
  /** The INSERTs of a block, by output handle, ascending: an attachment's
   *  record lists them (one 0x01 in its count run and one soft pointer
   *  each, as the reference's own saves spell it). */
  const insertsOf = (nm: string): number[] => {
    const out: number[] = [];
    const scan = (list: Entity[]): void => {
      for (const e of list) {
        if (e.type === 'insert' && e.blockName === nm) out.push(entH.get(e)!);
      }
    };
    scan(modelEnts); scan(paperEnts);
    for (const list of blockEnts.values()) scan(list);
    return out.sort((a, b) => a - b);
  };
  /* INSERT attributes are owned sub-entities: preserveHandles has to
     reach them the same way it reaches the insert, or every rewrite
     mints a fresh number (issue #2). */
  const attribH = new Map<TextEntity, number>();
  const allocAttribs = (list: Entity[]): void => {
    for (const e of list) {
      if (e.type !== 'insert') continue;
      for (const a of (e.attributes ?? []).filter((x) => x.type === 'text')) {
        attribH.set(a, keepH(a.handle));
      }
    }
  };
  allocAttribs(modelEnts);
  allocAttribs(paperEnts);
  for (const nm of userBlocks) allocAttribs(blockEnts.get(nm)!);
  const srcToOut = new Map<string, number>();
  const remember = (src: string | undefined, h: number): void => {
    if (src) srcToOut.set(src.toUpperCase(), h);
  };
  for (const [e, h] of entH) remember(e.handle, h);
  for (const [a, h] of attribH) remember(a.handle, h);

  /* Associative HATCH → boundary is a pair of links: soft pointers on
     the hatch, and a reactor on each boundary entity pointing back.
     AutoCAD 2027 AUDIT ("Boundary Missing a Reactor — Remove
     Associativity") strips the flag when the back-link is absent. The
     reader does not model reactors, so they are rebuilt from the hatch. */
  const hatchLink = new Map<Entity, { associative: boolean; loopBounds: number[][] }>();
  const reactorsFor = new Map<number, number[]>();
  for (const [e, hatchH] of entH) {
    if (e.type !== 'hatch') continue;
    const loopBounds = e.loops.map((lp) =>
      (lp.boundaryHandles ?? [])
        .map((src) => srcToOut.get(src.toUpperCase()) ?? 0)
        .filter((h) => h > 0)
    );
    const associative = !!(e.associative && loopBounds.some((hs) => hs.length));
    hatchLink.set(e, { associative, loopBounds });
    if (!associative) continue;
    for (const hs of loopBounds) {
      for (const tgt of hs) {
        const list = reactorsFor.get(tgt) ?? [];
        list.push(hatchH);
        reactorsFor.set(tgt, list);
      }
    }
  }

  /* Every APPID an entity's XDATA names has to exist in the table —
     EED points at it by handle, and a missing one is silent data loss. */
  const appidH = new Map<string, number>();
  appidH.set('ACAD', appidAcad);
  const extraAppids: { name: string; handle: number }[] = [];
  {
    const seen = new Set<string>(['ACAD']);
    const addApp = (name?: string): void => {
      if (!name) return;
      const key = name.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      const h = H();
      appidH.set(key, h);
      extraAppids.push({ name, handle: h });
    };
    for (const n of drawing.appIds ?? []) addApp(n);
    const anyMLeader = [drawing.entities, drawing.paperSpace ?? [],
      ...Object.values(drawing.blocks).map((b) => b.entities)]
      .some((list) => list.some((e) => e.type === 'mleader'));
    /* the multileader styles carry the same stamp as the entities */
    if (anyMLeader || (V >= 2000 && drawing.mleaderStyles?.length)) addApp('ACAD_MLEADERVER');
    const walkXd = (list: Entity[]): void => {
      for (const e of list) {
        for (const g of e.xdata ?? []) {
          addApp(g.appName || (g.appHandle ? 'APP_' + g.appHandle.toUpperCase() : undefined));
        }
        if (e.type === 'insert') {
          for (const a of e.attributes ?? []) {
            for (const g of a.xdata ?? []) {
              addApp(g.appName || (g.appHandle ? 'APP_' + g.appHandle.toUpperCase() : undefined));
            }
          }
        }
      }
    };
    walkXd(modelEnts);
    walkXd(paperEnts);
    for (const nm of userBlocks) walkXd(blockEnts.get(nm)!);
    /* dictionary-owned records carry EED too — a proxy object's whole
       content may be nothing else (the reference's dbConnect links) */
    for (const p of [...(drawing.proxyObjects ?? []), ...(drawing.unknownObjects ?? []),
      ...(drawing.tableStyles ?? []), ...(drawing.mleaderStyles ?? [])]) {
      for (const g of p.xdata ?? []) {
        addApp(g.appName || (g.appHandle ? 'APP_' + g.appHandle.toUpperCase() : undefined));
      }
    }
  }
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
  /** The CLASSES registry: one record per class NAME, numbered in the
   *  order the classes are registered. A class this writer builds
   *  records of its own for (a rebuilt visibility graph's nodes, the
   *  draw-order table) and a sealed object of the same class travelling
   *  from the source share one number — two records of one name would
   *  register the class twice, and the reference binds a record to the
   *  first number it sees. */
  const proxyClsH = new Map<string, {
    num: number; cpp: string; app: string; ent: boolean;
  }>();
  const clsFor = (dxf: string, cpp: string, app: string, ent: boolean): number => {
    const have = proxyClsH.get(dxf);
    if (have) return have.num;
    const num = clsNext++;
    proxyClsH.set(dxf, { num, cpp, app, ent });
    return num;
  };
  /* proxy passthrough: each distinct application class behind a proxy gets
     its own CLASSES record, and the proxy record's class id points at it —
     that is how a reader learns what the opaque object was. R13/R14 have
     no CLASSES section but predate the class-id indirection too: their
     zombie records carry the id verbatim, so passthrough still works. */
  const addProxyCls = (
    appClass: { dxfName: string; cppName: string; appName: string } | undefined,
    sourceType: string | undefined, fallback: string, ent: boolean
  ): void => {
    const key = appClass?.dxfName ?? sourceType ?? fallback;
    clsFor(key, appClass?.cppName ?? key, appClass?.appName ?? 'ObjectDBX Classes', ent);
  };
  const CLS_IMAGE = usesImages ? clsFor('IMAGE', 'AcDbRasterImage', 'ISM', true) : 0;
  const CLS_IMAGEDEF = usesImages ? clsFor('IMAGEDEF', 'AcDbRasterImageDef', 'ISM', false) : 0;
  const CLS_WIPEOUT = usesImages ? clsFor('WIPEOUT', 'AcDbWipeout', 'ISM', true) : 0;
  const CLS_LIGHT = usesLights ? clsFor('LIGHT', 'AcDbLight', 'ISM', true) : 0;
  /* Every ACAD_TABLE and MULTILEADER needs a style to resolve (the
     reference audits a null one), so each class travels with its style
     class. The styles written are the drawing's own — a "Standard"
     synthesized beside them when the drawing names none — and every
     entity points at the one its styleName names, else at Standard. A
     drawing that carries styles but no entity of the kind keeps its
     styles too (R2000+, where a class can be declared). */
  const usesTableStyles = usesTables || (V >= 2000 && !!drawing.tableStyles?.length);
  const usesMLeaderStyles = usesMLeaders || (V >= 2000 && !!drawing.mleaderStyles?.length);
  const CLS_TABLE = usesTables ? clsFor('ACAD_TABLE', 'AcDbTable', 'ISM', true) : 0;
  const CLS_TABLESTYLE = usesTableStyles
    ? clsFor('TABLESTYLE', 'AcDbTableStyle', 'ObjectDBX Classes', false) : 0;
  const CLS_MLEADER = usesMLeaders ? clsFor('MULTILEADER', 'AcDbMLeader', 'ISM', true) : 0;
  const CLS_MLEADERSTYLE = usesMLeaderStyles
    ? clsFor('MLEADERSTYLE', 'AcDbMLeaderStyle', 'ACDB_MLEADERSTYLE_CLASS', false) : 0;
  const withStandard = <T extends { name: string }>(list: T[] | undefined, standard: T): T[] => {
    const seen = new Set<string>();
    /* one record per name: a second style of the same name would share
       the first one's handle */
    return (list?.some((s) => /^standard$/i.test(s.name)) ? [...list] : [standard, ...(list ?? [])])
      .filter((s) => !seen.has(s.name.toLowerCase()) && !!seen.add(s.name.toLowerCase()));
  };
  const tableStylesOut = usesTableStyles
    ? withStandard(drawing.tableStyles, { name: 'Standard' }) : [];
  const mleaderStylesOut = usesMLeaderStyles
    ? withStandard(drawing.mleaderStyles, { name: 'Standard' }) : [];
  const tableDictH = usesTableStyles ? keepH(sh('ACAD_TABLESTYLE')) : 0;
  const mleaderDictH = usesMLeaderStyles ? keepH(sh('ACAD_MLEADERSTYLE')) : 0;
  const tableStyleHByName = new Map<string, number>();
  for (const s of tableStylesOut) tableStyleHByName.set(s.name.toLowerCase(), keepH(s.handle));
  const mleaderStyleHByName = new Map<string, number>();
  for (const s of mleaderStylesOut) mleaderStyleHByName.set(s.name.toLowerCase(), keepH(s.handle));
  const tableStyleFor = (name?: string): number =>
    tableStyleHByName.get((name ?? '').toLowerCase()) ?? tableStyleHByName.get('standard') ?? 0;
  const mleaderStyleFor = (name?: string): number =>
    mleaderStyleHByName.get((name ?? '').toLowerCase()) ?? mleaderStyleHByName.get('standard') ?? 0;
  /* Column MTEXT before R2007: the further columns are MTEXT entities of
     their own, named by handle in the first column's ACAD_MTEXT_COLUMNS
     xdata. The reference re-attaches them on load only for the parents
     an ACDB_RECOMPOSE_DATA record under the named objects dictionary
     lists (90 = 1, then one 330 per parent) — with the record the columns
     load as one MTEXT, without it as two, xdata identical (externally
     proven on the reference's own R2000 DXF of its Text-and-Tables
     sample: removing that one record alone is what splits them). R14
     knows XRECORD as an application class; R2000 gave it fixed type 79.
     R2007+ carry the columns in the MTEXT record itself. */
  const isColumnParent = (e: Entity): boolean => e.type === 'mtext'
    && !!e.xdata?.some((g) => g.values.some((v) => 'value' in v
      && v.code === 1000 && v.value === 'ACAD_MTEXT_COLUMNS_BEGIN'));
  /* The reference's own pre-2007 saves list every ACAD_TABLE there as
     well (its 2004 and R14 saves of the Text-and-Tables sample name the
     two tables beside the column MTEXT, one 330 each, ascending by
     handle) — and its table styles, which this writer has no record of
     its own for yet. */
  const columnParents = V >= 14 && V < 2007
    ? [modelEnts, paperEnts, ...userBlocks.map((nm) => blockEnts.get(nm)!)]
      .flat().filter((e) => isColumnParent(e) || e.type === 'table')
    : [];
  /** The type an XRECORD is written under: fixed type 79 from R2000 on,
   *  the application class R14 knew it as before. */
  const xrecordType = (): number =>
    V <= 14 ? clsFor('XRECORD', 'AcDbXrecord', 'ObjectDBX Classes', false) : 79;
  /* (an MTEXT that leaves with round-trip records is listed there too —
     allocated below, once those are known) */
  let recomposeH = columnParents.length ? H() : 0;
  /* PDF/DGN/DWF underlays: a class pair and a shared definition per kind */
  const underlayKinds = [...new Set(allEnts
    .filter((e): e is Entity & { type: 'underlay' } => e.type === 'underlay')
    .map((e) => e.underlayKind))].sort();
  const underlayCls = new Map<string, { ent: number; def: number }>();
  underlayKinds.forEach((kind) => {
    const cap = kind.charAt(0).toUpperCase() + kind.slice(1);
    underlayCls.set(kind, {
      ent: clsFor(kind.toUpperCase() + 'UNDERLAY', `AcDb${cap}Reference`, 'ISM', true),
      def: clsFor(kind.toUpperCase() + 'DEFINITION', `AcDb${cap}Definition`, 'ISM', false)
    });
  });
  /* geographic placement: one object, listed in the root dictionary */
  const geoData = drawing.geoData;
  const CLS_GEODATA = geoData ? clsFor('GEODATA', 'AcDbGeoData', 'ISM', false) : 0;
  const geoDataH = geoData ? H() : 0;
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
  /* ---- sealed unknown objects: same discipline, and the owner chain
     kept wherever the owner is in the file.
     A sealed object goes out under its ORIGINAL owner when that owner
     is written — an entity, a block header (the two space blocks
     through their layouts), a layer/linetype/style record, a proxy
     object, another sealed object, or a sealed extension dictionary —
     and only a record whose owner is not in the file is re-homed under
     the named objects dictionary as before. Under preserveHandles every
     one of those keeps its source number, so the chains the reference
     checks (an entity's ACAD_FIELD → FIELD, an INSERT's ACAD_FILTER →
     SPATIAL_FILTER, a block record's ACAD_ENHANCEDBLOCK → evaluation
     graph → nodes, ACAD_ASSOCNETWORK → network → actions) survive a
     rewrite exactly as the source spelled them. ---- */
  /** Kinds the reference refuses when they turn up ownerless: re-homed
   *  under the named objects dictionary they name a parent (a style
   *  table, a block's evaluation graph, a table's caches, the drawing's
   *  field list) that is not there — refused outright or audited per
   *  object, measured on the reference's own samples. They go out only
   *  under their original owner (`chained`), and stay home, reported by
   *  kind, when that owner is not written. */
  const ORPHAN_FATAL = new Set(['VISUALSTYLE', 'MLEADERSTYLE',
    'ACDB_BLOCKREPRESENTATION_DATA', 'ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION',
    'ACAD_EVALUATION_GRAPH', 'BLOCKVISIBILITYPARAMETER', 'BLOCKGRIPLOCATIONCOMPONENT',
    'TABLEGEOMETRY', 'TABLECONTENT', 'LINKEDTABLEDATA', 'FORMATTEDTABLEDATA',
    'FIELDLIST']);
  type Sealed = NonNullable<Drawing['unknownObjects']>[number];
  const kindOf = (p: Sealed): string =>
    (p.appClass?.dxfName ?? p.sourceType ?? '').toUpperCase();
  /** A sealed extension dictionary with its entries decoded: re-encoded
   *  from them rather than from its bits, so an entry whose target is
   *  not in the file is left out instead of dangling, and this writer's
   *  own records (a draw-order table, a rebuilt visibility graph) can be
   *  listed beside the ones that came with it. */
  const isDict = (p: Sealed): boolean =>
    (kindOf(p) === 'DICTIONARY' || kindOf(p) === 'ACDBDICTIONARYWDFLT')
    && p.entries !== undefined;
  /** The dictionary with a default (the plot style name dictionary): a
   *  DICTIONARY body under its own class, its default record's handle
   *  closing the handle stream. */
  const isWdflt = (p: Sealed): boolean =>
    kindOf(p) === 'ACDBDICTIONARYWDFLT' && p.entries !== undefined;
  const isXrecord = (p: Sealed): boolean => kindOf(p) === 'XRECORD';
  /** The typed values of a sealed XRECORD, when the reader decoded the
   *  whole record: what an XRECORD of another generation is re-encoded
   *  from. Its grammar is fixed in every release — a byte-counted run of
   *  (group, value) — and only the string spelling moves (codepage
   *  bytes through R2004, UTF-16 from R2007). The decoded run is trusted
   *  only when it accounts for every byte the record declared: a decode
   *  that stopped short (an unknown group) keeps its bits. */
  const xrecordValues = new Map<string, XdataValue[]>();
  for (const x of drawing.xrecords ?? []) {
    if (x.handle) xrecordValues.set(x.handle.toUpperCase(), x.values);
  }
  const xrecordRunSize = (values: XdataValue[], gen: number): number => {
    let n = 0;
    for (const val of values) {
      n += 2;
      if ('point' in val) { n += 24; continue; }
      const s = String(val.value);
      switch (resbufKind(val.code)) {
        case 'string': n += gen >= 2007 ? 2 + 2 * s.length : 3 + s.length; break;
        case 'real': n += 8; break;
        case 'point': n += 24; break;
        case 'int8': case 'bool': n += 1; break;
        case 'int16': n += 2; break;
        case 'int32': n += 4; break;
        case 'int64': n += 8; break;
        case 'binary': n += 1 + (s.replace(/[^0-9a-fA-F]/g, '').length >> 1); break;
        case 'handle': n += 8; break;
        default: return -1;
      }
    }
    return n;
  };
  const typedCache = new Map<Sealed, XdataValue[] | null>();
  const typedXrecord = (p: Sealed): XdataValue[] | undefined => {
    if (!isXrecord(p) || !p.handle || !p.data || p.encoding === undefined) return undefined;
    let hit = typedCache.get(p);
    if (hit === undefined) {
      const values = xrecordValues.get(p.handle.toUpperCase());
      let declared = -1;
      try { declared = new BitReader(fromBase64(p.data)).bl(); } catch { /* not a run */ }
      hit = values && declared >= 0 && xrecordRunSize(values, p.encoding) === declared
        ? values : null;
      typedCache.set(p, hit);
    }
    return hit ?? undefined;
  };
  /** Whether a sealed object's bits belong to another encoding generation
   *  than this file's — then it goes out wrapped in a proxy record (the
   *  format's own idiom for foreign data), or not at all where no envelope
   *  is accepted. Not what is re-encoded from its decoded form instead:
   *  a dictionary (from its entries), an XRECORD (from its typed values),
   *  the empty-bodied placeholder. */
  const wrapped = (p: Sealed): boolean =>
    p.data !== undefined && p.encoding !== encodingGroup(V)
    && !isDict(p) && kindOf(p) !== 'ACDBPLACEHOLDER' && typedXrecord(p) === undefined;
  /** The reference's own visual styles, by name: the set it creates in
   *  every drawing (the 16 of 2007, the 19 of 2010). A drawing of another
   *  generation cannot carry them across — the family changed spelling
   *  at R2013 — and does not need to: the reference recreates the set
   *  when it opens a drawing without one. */
  const STANDARD_VISUAL_STYLES = new Set(['2dwireframe', '3dwireframe',
    '3d hidden', 'basic', 'realistic', 'conceptual', 'dim', 'brighten',
    'thicken', 'linepattern', 'facepattern', 'colorchange', 'flat',
    'flatwithedges', 'gouraud', 'gouraudwithedges', 'jitteroff', 'overhangoff',
    'edgecoloroff', 'shaded', 'shaded with edges', 'shades of gray', 'sketchy',
    'x-ray', 'hidden', 'wireframe']);
  let standardVisualStyles = 0;
  /** Kinds that only make sense under their own owner: the ones above,
   *  the AcDbAssoc* framework (a network the reference resolves from
   *  its block's extension dictionary), an extension dictionary and
   *  the XRECORDs it lists. */
  const chained = (p: Sealed): boolean => {
    const kind = kindOf(p);
    return ORPHAN_FATAL.has(kind)
      /* the dynamic-block family: every node of an evaluation graph
         (parameters, actions, grips, grip components, property tables,
         proxy nodes) — re-homed under the NOD without its graph the
         reference refuses the drawing (Mechanical - Metric, 2018) */
      || kind.startsWith('BLOCK') || kind.startsWith('ACDB_DYNAMICBLOCK')
      || kind.startsWith('ACDBASSOC') || kind.startsWith('ASSOC')
      || /DEPENDENCYBODY$/.test(kind)
      || isDict(p) || isXrecord(p);
  };
  /** Why a sealed object stays out of this file whatever its owner
   *  does, or null when it may go. */
  const staysHome = (p: Sealed): string | null => {
    const kind = kindOf(p);
    const foreign = wrapped(p);
    /* A foreign-generation seal rides inside a proxy object. The envelope
       the reference accepts is measured for R2000 and R2007+ (see
       sealBody); in R2004 and R13/R14 files every spelling tried so far
       is refused outright (ErrorStatus 53), and a drawing that opens
       without its sealed objects beats one that does not open at all.
       A dictionary is re-encoded from its entries and an XRECORD from its
       typed values, so their bits' generation does not matter. */
    if (foreign && (V === 2004 || V < 2000)) return p.sourceType ?? p.name ?? 'sealed object';
    /* the annotative context records of a later generation, wrapped for
       R2007: refused as a group by the reference (an AC1024 sample's 27 of
       them, each alone accepted at R2018) */
    if (V === 2007 && foreign && /OBJECTCONTEXTDATA/.test(kind)) return p.sourceType ?? kind;
    /* R2010 and R2013+ share one encoding group here (there is no R2010
       writer), but two families changed their spelling at R2013: the
       visual styles and the AcDbAssoc* framework. Their R2010 bits
       written natively into an AC1032 file are refused (every R2010
       sample of the reference's Dynamic Blocks folder, measured; the
       R2018 ones open with both families intact). */
    if (V >= 2018 && drawing.header.version === 'R2010'
      && (kind === 'VISUALSTYLE' || kind.startsWith('ACDBASSOC')
        || kind.startsWith('ASSOC') || /DEPENDENCYBODY$/.test(kind))) {
      return `${p.sourceType ?? kind} (R2010 record; its R2013 spelling differs)`;
    }
    if (!preserve) {
      /* Without preserveHandles every number moves. A record's handle
         stream is remapped (mapRef); its data bits are not — and these
         are the families whose data names other objects (an XRECORD's
         330 groups, a constraint network's dependency bodies) or whose
         owner the reference rebuilds and matches against the record:
         renumbered they were refused or audited one by one on the
         reference's own samples. They stay home as they always did
         without the numbering, reported by kind; under preserveHandles
         the chain carries them. */
      if (ORPHAN_FATAL.has(kind) || kind.startsWith('BLOCK')
        || kind.startsWith('ACDB_DYNAMICBLOCK')) return p.sourceType ?? kind;
      if (kind.startsWith('ACDBASSOC') || kind.startsWith('ASSOC')
        || /DEPENDENCYBODY$/.test(kind)) return p.sourceType ?? kind;
      if (isXrecord(p)) return `${p.sourceType ?? kind} (its data may name handles a renumbering cannot follow)`;
    }
    return null;
  };
  /** Whether a sealed object has a record to write: its payload bits, a
   *  fixed type number, or — a class object read from a DWG whose whole
   *  body was empty and whose content is its EED — a class to write
   *  that empty body under (the form the reference's own files give
   *  its dbConnect link records). A DXF-sealed record has none of
   *  these: its tags are not bits, and an empty body is not its own. */
  const hasRecord = (p: Sealed): boolean =>
    !!p.data || p.typeCode !== undefined || isDict(p)
    || (p.encoding !== undefined && !!p.xdata?.length
        && !!(p.appClass?.dxfName ?? p.sourceType));
  /** The named-object dictionaries this writer builds itself. A sealed
   *  dictionary of the tree that carries one of these keys (the source's
   *  own ACAD_LAYOUT, say, sealed on a previous read of a file of ours)
   *  is not a sealed object at all here — the writer's is the one that
   *  goes, and what the source's listed is modeled (layouts, groups,
   *  line styles) or re-homed as before. */
  const BUILT_NOD = new Set(['ACAD_LAYOUT', 'ACAD_GROUP', 'ACAD_MLINESTYLE',
    'ACAD_TABLESTYLE', 'ACAD_MLEADERSTYLE', 'ACDB_RECOMPOSE_DATA',
    'ACAD_GEOGRAPHICDATA', 'ACDBVARIABLEDICTIONARY']);
  /* The drawing's variable dictionary (R2000+): the system variables the
     reference keeps as DICTIONARYVAR records under the root's
     AcDbVariableDictionary — DIMASSOC of 2002, CTABLESTYLE, CMLEADERSTYLE,
     CANNOSCALE, LIGHTINGUNITS, CVIEWDETAILSTYLE… — rebuilt natively in
     every release from `drawing.variables` (the DWG reader's) and from a
     DICTIONARYVAR that arrived through DXF as tags. A source header slot
     the target release lacks joins the list the way the reference's own
     saves spell it (its 2000 save of A-01 lists DIMASSOC, INDEXCTL and
     XCLIPFRAME beside the rest, its 2004 save SOLIDHIST; both header
     slots elsewhere), and a slot this release has takes the dictionary's
     value when the source header carried none (see hdrNum). */
  const variablesOut: DrawingVariable[] = [];
  const hasVar = (name: string): boolean =>
    variablesOut.some((v) => v.name.toLowerCase() === name.toLowerCase());
  for (const v of drawing.variables ?? []) {
    if (v.name && !hasVar(v.name)) variablesOut.push(v);
  }
  const consumedVars = new Set<Sealed>();
  for (const p of drawing.unknownObjects ?? []) {
    if (kindOf(p) !== 'DICTIONARYVAR' || !p.name || !p.tags?.length) continue;
    if (p.dictPath?.length !== 1 || !/^acdbvariabledictionary$/i.test(p.dictPath[0])) continue;
    const tag = (code: number): string | undefined => p.tags!.find((t) => t[0] === code)?.[1];
    const value = tag(1);
    if (value === undefined) continue;
    consumedVars.add(p);
    if (hasVar(p.name)) continue;
    const schema = Number(tag(280) ?? 0);
    variablesOut.push({
      name: p.name, value, ...(schema ? { schema } : {}),
      ...(p.handle ? { handle: p.handle } : {}), ...(p.xdict ? { xdict: p.xdict } : {})
    });
  }
  const headerSlotVar = (name: string): void => {
    const x = drawing.header.vars?.[name];
    if (typeof x !== 'number' || !Number.isFinite(x) || hasVar(name)) return;
    variablesOut.push({ name, value: String(x) });
  };
  if (V < 2004) for (const k of ['DIMASSOC', 'INDEXCTL', 'XCLIPFRAME']) headerSlotVar(k);
  if (V < 2007) headerSlotVar('SOLIDHIST');
  const usesVariables = V >= 2000 && variablesOut.length > 0;
  if (V < 2000 && variablesOut.length) {
    skipped.push(`${variablesOut.length} drawing variables (AcDbVariableDictionary needs R2000 or later)`);
  }
  const varDictH = usesVariables ? keepH(sh('ACDBVARIABLEDICTIONARY')) : 0;
  const varH = variablesOut.map((v) => (usesVariables ? keepH(v.handle) : 0));
  const CLS_DICTVAR = usesVariables
    ? clsFor('DICTIONARYVAR', 'AcDbDictionaryVar', 'ObjectDBX Classes', false) : 0;
  const sealedAll = (drawing.unknownObjects ?? []).filter((p) => {
    if (kindOf(p) === 'DICTIONARY' && p.dictPath?.length === 0 && p.name
      && BUILT_NOD.has(p.name.toUpperCase())) return false;
    /* a DICTIONARYVAR rebuilt natively from its tags (above) */
    if (consumedVars.has(p)) return false;
    /* the plot style name dictionary (with its default, the placeholder)
       is R2000's: R13/R14 have no plot styles to name */
    if (V < 2000 && isWdflt(p)) {
      skipped.push('ACDBDICTIONARYWDFLT (needs R2000 or later)');
      return false;
    }
    if (V < 2000 && kindOf(p) === 'ACDBPLACEHOLDER') return false;
    /* nothing retained to write — a record that arrived through DXF
       as tags alone, or an empty one with no class to write it under.
       Out of the file, and said so. */
    if (hasRecord(p)) return true;
    skipped.push(`${p.sourceType ?? 'sealed object'} (no retained record bits)`);
    return false;
  });
  const sealedByH = new Map<string, Sealed>();
  for (const p of sealedAll) {
    if (p.handle) sealedByH.set(p.handle.toUpperCase(), p);
  }
  /** Source handles this file writes something under, the sealed
   *  objects aside: entities and their attributes, block headers (the
   *  two space blocks through their layouts), proxy objects, the symbol
   *  tables. A sealed record's HARD references (owner/pointer codes 3
   *  and 5) must land on one of these or on a sealed object that
   *  travels: the reference resolves them while opening and refuses
   *  the whole drawing over one dangler (ErrorStatus 53, externally
   *  proven — the field corpus was refused for its plot-style
   *  dictionary, whose default names an ACDBPLACEHOLDER this library
   *  does not retain). */
  const baseKept = new Set<string>(['0']);
  {
    const addRef = (h?: string): void => { if (h) baseKept.add(h.toUpperCase()); };
    const scanRefs = (list?: Entity[]): void => {
      for (const e of list ?? []) {
        addRef(e.handle);
        if (e.type === 'insert') {
          for (const a of e.attributes ?? []) addRef(a.handle);
        }
      }
    };
    scanRefs(drawing.entities); scanRefs(drawing.paperSpace);
    for (const b of Object.values(drawing.blocks)) {
      addRef(b.handle); scanRefs(b.entities);
    }
    addRef(modelMeta?.blockHandle); addRef(paperMeta?.blockHandle);
    for (const p of drawing.proxyObjects ?? []) addRef(p.handle);
    for (const ly of drawing.layers) addRef(ly.handle);
    for (const lt of drawing.linetypes) addRef(lt.handle);
    for (const st of drawing.textStyles) addRef(st.handle);
    for (const s of tableStylesOut) addRef(s.handle);
    for (const s of mleaderStylesOut) addRef(s.handle);
    /* the layouts, views, the active viewport, the dimension styles and
       the groups are records of this file too */
    if (V >= 2000) {
      for (const l of [modelMeta, paperMeta, ...extraLayouts.map((x) => x.meta)]) addRef(l?.handle);
    }
    for (const vw of views) addRef(vw.handle);
    addRef(activeVport?.handle);
    for (const ds of dimStyles) addRef(ds.handle);
    for (const g of groupsOut) addRef(g.handle);
    for (const s of mlineStylesOut) addRef(s.handle);
    for (const u of ucsOut) addRef(u.handle);
    if (usesVariables) for (const v of variablesOut) addRef(v.handle);
  }
  /* The source's structural objects: the named objects dictionary, its
     sub-dictionaries this writer rebuilds, the symbol-table controls. A
     sealed object owned by one of them — a record listed straight under
     the root (dictPath []), the layer table's extension dictionary — is
     written under the object built here in its place, and a reference
     to it (a FIELDLIST's reactor) follows the same way. The root is
     inferred from what hangs under it when the model does not name it
     (a drawing that came through DXF). */
  {
    const map = (src: string | undefined, out: number): void => {
      const old = src ? parseInt(src, 16) : NaN;
      if (!src || !Number.isFinite(old) || old <= 0) return;
      if (!oldToNew.has(old)) oldToNew.set(old, out);
      baseKept.add(src.toUpperCase());
    };
    map(sh('NOD') ?? sealedAll.find((p) => p.dictPath?.length === 0 && p.ownerHandle)?.ownerHandle, nod);
    if (V >= 2000) map(sh('ACAD_LAYOUT'), layoutDict);
    map(sh('ACAD_GROUP'), groupDict);
    map(sh('ACAD_MLINESTYLE'), mlineDict);
    if (usesTableStyles) map(sh('ACAD_TABLESTYLE'), tableDictH);
    if (usesMLeaderStyles) map(sh('ACAD_MLEADERSTYLE'), mleaderDictH);
    if (usesVariables) map(sh('ACDBVARIABLEDICTIONARY'), varDictH);
    map(sh('BLOCK_CONTROL'), blockControl); map(sh('LAYER_CONTROL'), layerControl);
    map(sh('STYLE_CONTROL'), styleControl); map(sh('LTYPE_CONTROL'), ltypeControl);
    map(sh('VIEW_CONTROL'), viewControl); map(sh('UCS_CONTROL'), ucsControl);
    map(sh('VPORT_CONTROL'), vportControl); map(sh('APPID_CONTROL'), appidControl);
    map(sh('DIMSTYLE_CONTROL'), dimstyleControl);
    if (V <= 2000) map(sh('VX_CONTROL'), vxControl);
  }
  /** The sealed objects that go, settled to a fixed point: out by kind
   *  first (staysHome), then anything whose owner is a sealed object
   *  that stays — a node of a graph that does not travel would be
   *  re-parented under the NOD with a node id into nothing ("Incorrect
   *  object node id", 30 of a campaign round's AUDIT findings) — then
   *  the chained kinds whose owner is not written, an extension
   *  dictionary with nothing written left to list (quietly: whatever it
   *  lost reports itself), and any record with a hard reference into
   *  nothing; each removal can strand another, hence the loop. */
  const travel = new Set<Sealed>(sealedAll);
  const whyNot = new Map<Sealed, string>();
  const silent = new Set<Sealed>();
  const written = (h: string): boolean => {
    const u = h.toUpperCase();
    const s = sealedByH.get(u);
    return s ? travel.has(s) : baseKept.has(u);
  };
  const stay = (p: Sealed, why: string, quiet = false): void => {
    travel.delete(p);
    whyNot.set(p, why);
    if (quiet) silent.add(p);
  };
  /** Whether a sealed dictionary lists an entry in this file: its target
   *  is written and — in a dictionary of the named-objects tree — goes
   *  out native. A seal-wrap inside one of the reference's own
   *  dictionaries is audited (147 findings on A-01 into 2018, a proxy
   *  where a SCALE was expected); such a record is re-homed flat under
   *  the root instead, where a proxy is harmless, and the dictionary —
   *  its grammar the same in every release — is re-encoded from the
   *  entries that stay native: the XRECORDs of AcDbVariableDictionary,
   *  say, which travel into any generation from their typed values. */
  const listable = (d: Sealed, en: { handle: string }): boolean => {
    if (!written(en.handle)) return false;
    if (d.dictPath === undefined) return true;
    const t = sealedByH.get(en.handle.toUpperCase());
    return !t || !wrapped(t);
  };
  for (const p of sealedAll) {
    /* the reference's own visual styles of another spelling: dropped as
       a set, reported once — the reference recreates them on open */
    if (kindOf(p) === 'VISUALSTYLE'
      && (wrapped(p) || (V >= 2018 && drawing.header.version === 'R2010'))
      && STANDARD_VISUAL_STYLES.has((p.name ?? '').toLowerCase())) {
      standardVisualStyles++;
      stay(p, 'VISUALSTYLE (the reference\'s standard set)', true);
      continue;
    }
    const why = staysHome(p);
    if (why !== null) stay(p, why);
  }
  const settle = (): void => {
    for (let changed = true; changed;) {
      changed = false;
      for (const p of [...travel]) {
        const kind = kindOf(p);
        const o = p.ownerHandle?.toUpperCase();
        const ownerSealed = o ? sealedByH.get(o) : undefined;
        const ownerIn = !!o && written(o);
        /* (a record listed by a tree dictionary that stays home is
           re-homed flat under the root, as it always was) */
        const ownerTree = !!ownerSealed && isDict(ownerSealed) && ownerSealed.dictPath !== undefined;
        let why: string | null = null;
        let quiet = false;
        if (ownerSealed && !travel.has(ownerSealed) && !ownerTree) {
          /* the owner's own line in `skipped` covers everything hanging
             off it: one chain, one loss, reported once at its root */
          why = `${p.sourceType ?? 'sealed object'} (its owner stays home)`;
          quiet = true;
        } else if (isDict(p)) {
          /* A dictionary that came empty is a fact of the source, not a
             loss: the reference's own pre-2013 saves decompose the data
             store into `AcDsDecomposeData` = { AcDsRecords, AcDsSchemas }
             and refuse the file on open when the (empty) AcDsRecords is
             gone — measured on its 2000, 2004 and R14 saves of a
             three-MTEXT probe, refused at every target with the key
             dropped, AUDIT 0 with it. It travels with its owner like any
             other record; only a dictionary that LOST every entry here
             has nothing left to say. */
          const cameEmpty = !(p.entries ?? []).length;
          if (!cameEmpty && !(p.entries ?? []).some((en) => listable(p, en))) {
            why = `${p.sourceType ?? kind} (nothing it lists is written)`;
            quiet = true;
          } else if (!ownerIn) {
            why = `${p.sourceType ?? kind} (extension dictionary of an object not written)`;
          }
        } else if (wrapped(p) && ownerTree && chained(p)) {
          /* a seal-wrap inside the reference's own dictionary is audited,
             and this kind is refused re-homed anywhere else */
          why = `${p.sourceType ?? kind} (of another generation, listed by one of the reference's own dictionaries)`;
        } else if (!ownerIn && chained(p)) {
          why = isXrecord(p)
            ? `${p.sourceType ?? kind} (its owner is not written)`
            : p.sourceType ?? kind;
        } else if (!(p.refs ?? []).every((r) =>
          (r.code !== 3 && r.code !== 5) || r.value === '0' || written(r.value))) {
          why = p.sourceType ?? 'sealed object';
        }
        if (why !== null) {
          stay(p, why, quiet);
          changed = true;
        }
      }
    }
  };
  settle();
  /* Dynamic blocks (the emission is below). A block that defines
     visibility states leaves as a dynamic block. When the reference's
     own graph travels whole — the block's sealed extension dictionary
     lists it under ACAD_ENHANCEDBLOCK and the graph is in `travel`, so
     every node it hard-owns is too (preserveHandles) — the genuine
     chain is kept as it is, parameters, actions and all. Otherwise the
     graph is rebuilt from the decoded states (the visibility alone),
     and the sealed remnants of the old one — the graph, its nodes, the
     purge preventer — stay home unreported: their staying is not a
     loss, the rebuild supersedes them. */
  const xdictOfBlock = (nm: string): Sealed | undefined => {
    const bh = drawing.blocks[nm]?.handle?.toUpperCase();
    if (!bh) return undefined;
    return sealedAll.find((p) => isDict(p) && p.ownerHandle?.toUpperCase() === bh);
  };
  const entryOf = (d: Sealed | undefined, key: string): Sealed | undefined => {
    const en = d?.entries?.find((e) => e.name.toUpperCase() === key.toUpperCase());
    return en ? sealedByH.get(en.handle.toUpperCase()) : undefined;
  };
  const genuineGraphTravels = (nm: string): boolean => {
    const d = xdictOfBlock(nm);
    if (!d || !travel.has(d)) return false;
    const g = entryOf(d, 'ACAD_ENHANCEDBLOCK');
    return !!g && travel.has(g) && kindOf(g) === 'ACAD_EVALUATION_GRAPH';
  };
  const dynBlocks = userBlocks.filter((nm) =>
    !!drawing.blocks[nm]?.visibilityStates?.length && !genuineGraphTravels(nm));
  const supersededGraph = new Set<string>();
  if (V >= 2000) {
    /* the graph and everything it hard-owns, transitively */
    const closure = (start: Sealed | undefined): void => {
      const stack = start ? [start] : [];
      while (stack.length) {
        const p = stack.pop()!;
        const h = p.handle?.toUpperCase();
        if (!h || supersededGraph.has(h)) continue;
        supersededGraph.add(h);
        for (const r of p.refs ?? []) {
          const c = r.code === 3 ? sealedByH.get(r.value.toUpperCase()) : undefined;
          if (c) stack.push(c);
        }
      }
    };
    const dynHandles = new Set(dynBlocks
      .map((nm) => drawing.blocks[nm].handle?.toUpperCase())
      .filter((h): h is string => !!h));
    for (const nm of dynBlocks) {
      const d = xdictOfBlock(nm);
      closure(entryOf(d, 'ACAD_ENHANCEDBLOCK'));
      closure(entryOf(d, 'AcDbDynamicBlockRoundTripPurgePreventer'));
    }
    /* a model carrying the graph without its dictionary: the purge
       preventer names its block, the graph shares the preventer's owner */
    const xdicts = new Set<string>();
    for (const p of sealedAll) {
      if (kindOf(p) !== 'ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION') continue;
      if (!(p.refs ?? []).some((r) => r.code === 5
        && dynHandles.has(r.value.toUpperCase()))) continue;
      closure(p);
      if (p.ownerHandle) xdicts.add(p.ownerHandle.toUpperCase());
    }
    for (const p of sealedAll) {
      if (kindOf(p) !== 'ACAD_EVALUATION_GRAPH' || !p.ownerHandle
        || !xdicts.has(p.ownerHandle.toUpperCase())) continue;
      closure(p);
    }
    for (const p of [...travel]) {
      if (p.handle && supersededGraph.has(p.handle.toUpperCase())) {
        stay(p, `${p.sourceType ?? kindOf(p)} (superseded by the rebuilt graph)`, true);
      }
    }
    settle();
  }
  for (const p of sealedAll) {
    if (travel.has(p) || silent.has(p)) continue;
    if (p.handle && supersededGraph.has(p.handle.toUpperCase())) continue;
    skipped.push(whyNot.get(p)!);
  }
  if (standardVisualStyles) {
    skipped.push(`${standardVisualStyles} VISUALSTYLE records `
      + '(the reference\'s standard set, in another generation\'s spelling; recreated on open)');
  }
  const unknownObjs = sealedAll.filter((p) => travel.has(p));
  for (const p of unknownObjs) {
    if (p.typeCode === undefined) {
      addProxyCls(p.appClass, p.sourceType, 'ACAD_PROXY_OBJECT', false);
    }
    /* an XRECORD re-encoded into an R14 file is typed with its class */
    if (V <= 14 && isXrecord(p)) xrecordType();
  }
  const unknownObjH = unknownObjs.map((p) => keepH(p.handle));
  /** The plot style name dictionary of this file: the source's, carried
   *  with its default (the placeholder), when it travels — the header
   *  names it. */
  const plotStyleDictH = ((): number => {
    const i = unknownObjs.findIndex((p) => isWdflt(p) && p.dictPath?.length === 0
      && (p.name ?? '').toUpperCase() === 'ACAD_PLOTSTYLENAME');
    return i >= 0 ? unknownObjH[i] : 0;
  })();
  /* Every handle is allocated now: this is where a source handle maps
     to this file's number, and where the chains are wired. */
  const sealedOut = new Map<string, number>();
  unknownObjs.forEach((p, i) => {
    if (p.handle) sealedOut.set(p.handle.toUpperCase(), unknownObjH[i]);
  });
  /** This file's handle for a source handle, or undefined when what it
   *  named is not written: a sealed object only when it travels, anything
   *  else through the allocation map (the same number under
   *  preserveHandles, a fresh one otherwise). */
  const outOf = (src?: string): number | undefined => {
    if (!src) return undefined;
    const old = parseInt(src, 16);
    if (!Number.isFinite(old) || old <= 0) return undefined;
    const s = sealedByH.get(src.toUpperCase());
    if (s) return travel.has(s) ? sealedOut.get(src.toUpperCase()) : undefined;
    return oldToNew.get(old);
  };
  /** The owner a sealed or proxy object is written under, or undefined
   *  when its source owner is not in this file (then: the NOD). A
   *  seal-wrap is never listed by a dictionary of the reference's own
   *  tree (see `listable`): re-homed flat under the root. */
  const ownerOut = (p: { handle?: string; ownerHandle?: string }): number | undefined => {
    const o = outOf(p.ownerHandle);
    if (o === undefined || !p.ownerHandle) return undefined;
    const self = p.handle ? sealedByH.get(p.handle.toUpperCase()) : undefined;
    if (self && wrapped(self)) {
      const os = sealedByH.get(p.ownerHandle.toUpperCase());
      if (os && isDict(os) && os.dictPath !== undefined) return undefined;
    }
    return o;
  };
  /** Listed in this file's root dictionary: a record whose owner is not
   *  in the file (re-homed), or whose owner was the source's root
   *  dictionary (home). */
  const underNod = (p: { handle?: string; ownerHandle?: string }): boolean => {
    const o = ownerOut(p);
    /* the root's own extension dictionary hangs off the root's xdict
       pointer (xdictByOwner, below); it is not an entry of the root.
       Listed as well, its key pointed at an object the reference had
       consumed on open ("SEALED_OBJECT_138 eWasErased, Delete Entry" —
       its R14 save of a probe gives the root an ACAD_XREC_ROUNDTRIP
       dictionary) */
    if (o === nod && p.handle && xdictByOwner.get(nod)?.p.handle === p.handle) return false;
    return o === undefined || o === nod;
  };
  /** The sealed extension dictionaries that go out under their owner, by
   *  the owner's handle in this file. A dictionary another sealed
   *  dictionary LISTS is that one's entry, not an extension dictionary;
   *  one it owns without listing is its extension dictionary. */
  const xdictByOwner = new Map<number, { p: Sealed; h: number }>();
  unknownObjs.forEach((p, i) => {
    if (!isDict(p) || !p.ownerHandle) return;
    /* A dictionary the named-objects tree LISTS (`dictPath` set — the
       reader gives it only to a listed record) is an entry of the
       dictionary that lists it, never that owner's extension dictionary.
       The root is built here, not sealed, so the entries check below
       cannot see its listing: without this the last tree dictionary the
       root listed became the root's extension dictionary — harmless
       while its target lived, an AUDIT finding ("Extension dictionary
       19C Cannot access, Removed") once the reference consumed the
       target on open (its own AcDsDecomposeData). */
    if (p.dictPath !== undefined) return;
    const os = sealedByH.get(p.ownerHandle.toUpperCase());
    if (os && isDict(os)
      && (os.entries ?? []).some((en) => en.handle.toUpperCase() === p.handle?.toUpperCase())) return;
    const oh = ownerOut(p);
    if (oh !== undefined) xdictByOwner.set(oh, { p, h: unknownObjH[i] });
  });
  const sealedDictH = new Set<number>();
  unknownObjs.forEach((p, i) => { if (isDict(p)) sealedDictH.add(unknownObjH[i]); });
  /** Records of this writer's own listed in a sealed extension dictionary
   *  (a draw-order table, a rebuilt visibility graph), by the dictionary's
   *  handle: written into it beside the entries that came with it. */
  const extraDictEntries = new Map<number, [string, number][]>();
  const listIn = (dict: number, name: string, h: number): void => {
    const list = extraDictEntries.get(dict) ?? [];
    list.push([name, h]);
    extraDictEntries.set(dict, list);
  };
  /* dynamic blocks: a block that defines visibility states leaves as a
     dynamic block — the visibility parameter (the one member of the
     family that changes what a viewer draws) inside the evaluation graph
     the reference builds around it, spelled the way the reference spells
     it (see the emission below). R13/R14 cannot name classes, so there
     it is reported. A drawing that still carries the reference's own
     graph as sealed objects (the evaluation graph, the grips, the purge
     preventer — none of which travel, above) gets a fresh graph built
     from the decoded states; the sealed remnants stay home, reported by
     kind. */
  const usesDynBlocks = dynBlocks.length > 0 && V >= 2000;
  /* (one number per class name: a genuine graph travelling from the
     source beside a rebuilt one shares these records) */
  const CLS_BLOCKVIS = usesDynBlocks
    ? clsFor('BLOCKVISIBILITYPARAMETER', 'AcDbBlockVisibilityParameter', 'ObjectDBX Classes', false) : 0;
  const CLS_EVALGRAPH = usesDynBlocks
    ? clsFor('ACAD_EVALUATION_GRAPH', 'AcDbEvalGraph', 'ObjectDBX Classes', false) : 0;
  const CLS_BLOCKVISGRIP = usesDynBlocks
    ? clsFor('BLOCKVISIBILITYGRIP', 'AcDbBlockVisibilityGrip', 'ObjectDBX Classes', false) : 0;
  const CLS_BLOCKGRIPEXPR = usesDynBlocks
    ? clsFor('BLOCKGRIPLOCATIONCOMPONENT', 'AcDbBlockGripExpr', 'ObjectDBX Classes', false) : 0;
  const CLS_DYNPURGE = usesDynBlocks
    ? clsFor('ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION', 'AcDbDynamicBlockPurgePreventer', 'ObjectDBX Classes', false) : 0;
  /* Draw order. A default write needs nothing: fresh handles ascend in
     array order, and array order IS the draw order. Under preserveHandles
     a space whose array order differs from its ascending handle order
     would read back reordered, so each such space gets a native
     SORTENTSTABLE (under an ACAD_SORTENTS entry in the block record's
     extension dictionary). R13/R14 cannot name the class and lose the
     ordering honestly, through `skipped`. */
  const outOfOrder = (hs: number[]): boolean =>
    hs.some((h2, i) => i > 0 && h2 < hs[i - 1]);
  const sortSpaces: { block: number; hs: number[] }[] = [];
  if (preserve) {
    const spaces: [number, number[]][] = [
      [msBH, msEntH], [psBH, psEntH],
      ...userBlocks.map((nm): [number, number[]] =>
        [blockH.get(nm)!, blockEntH.get(nm)!])
    ];
    for (const [block, hs] of spaces) {
      if (!outOfOrder(hs)) continue;
      if (V <= 14) {
        skipped.push('draw order (SORTENTSTABLE needs R2000 or later)');
        continue;
      }
      sortSpaces.push({ block, hs });
    }
  }
  const CLS_SORTENTS = sortSpaces.length
    ? clsFor('SORTENTSTABLE', 'AcDbSortentsTable', 'ObjectDBX Classes', false) : 0;
  const sortentsFor = new Map<number, { dict: number; table: number }>();
  for (const s of sortSpaces) {
    /* the block's sealed extension dictionary, when it travels, is the
       one the table is listed in — keeping its number and whatever else
       it lists; a fresh one otherwise */
    const dict = xdictByOwner.get(s.block)?.h ?? H();
    const table = H();
    sortentsFor.set(s.block, { dict, table });
    if (sealedDictH.has(dict)) listIn(dict, 'ACAD_SORTENTS', table);
  }
  /* the dynamic-block graph's records, per block header (R2000+): the
     extension dictionary (shared with the draw-order entry when the
     block has one), the evaluation graph, the visibility parameter, its
     grip with the grip's two location components, the purge preventer */
  interface DynRec {
    dict: number; graph: number; param: number;
    grip: number; gripX: number; gripY: number; purge: number;
  }
  const dynFor = new Map<number, DynRec>();
  if (usesDynBlocks) {
    for (const nm of dynBlocks) {
      const bh = blockH.get(nm)!;
      const rec: DynRec = {
        dict: sortentsFor.get(bh)?.dict ?? xdictByOwner.get(bh)?.h ?? H(),
        graph: H(), param: H(), grip: H(), gripX: H(), gripY: H(), purge: H()
      };
      dynFor.set(bh, rec);
      if (sealedDictH.has(rec.dict)) {
        /* the fresh graph and preventer replace the stale ones in the
           block's own dictionary (their old entries point at records
           that stay home and are dropped) */
        listIn(rec.dict, 'ACAD_ENHANCEDBLOCK', rec.graph);
        listIn(rec.dict, 'AcDbDynamicBlockRoundTripPurgePreventer', rec.purge);
      }
    }
  }
  /* ---- MTEXT paragraph codes an older release cannot show, and the
     records the reference keeps the original under ----
     The 2008 release's `\px…;` paragraph codes go out natively in AC1032
     alone: the reference's own saves of a text spelled `\pxqc;…` into
     2013, 2010, 2007 and 2004 all carry the 2004 spelling (`\pi…` in
     drawing units, alignment and spacing dropped), and its 2000 and R14
     saves carry no `\p…;` at all. Beside the rewritten text it keeps
     the original in the entity's extension dictionary: an XRECORD
     `ACAD_MTEXT_2008_RT` of (40 = Σ charCode(i)·(i+1) over the 2004
     spelling, 1 = the original text in 250-character pieces), and for
     2000 and R14 a second one, `ACAD_MTEXT_RT` (40 = the same sum over
     the text as written, 1 = the 2004 spelling in pieces) — the 2004
     text restored first on open, the original from it, each only when
     its sum still matches what the entity carries (edited text keeps).
     Pinned on the reference's saves of three probe texts and of its
     Text-and-Tables sample (px2008 scratch): the sums above match every
     record. A source chain that travels sealed under the entity is kept
     (its sums hold: the 2004 spelling is what the source carried); a
     record that does not travel is rebuilt from the source's typed
     values, so the original survives a renumbering write too. */
  const synthXdict = new Map<number, number>();    /* entity → its fresh xdict */
  interface MtextRt { dict: number; fresh: boolean; entries: [string, number, XdataValue[]][] }
  const mtextRt = new Map<Entity, MtextRt>();
  /** The text an MTEXT goes out with in this release. */
  const mtextWritten = (e: Entity & { type: 'mtext' }): string => {
    const t0 = (e.raw ?? e.text).replace(/\n/g, '\\P');
    if (V >= 2018) return t0;
    const height = e.height > 0 ? e.height : 5;
    const t4 = flattenMtextParagraphs(t0, 2004, height);
    return V <= 2000 ? flattenMtextParagraphs(t4, 2000, height) : t4;
  };
  if (V < 2018) {
    const sumPos1 = (s: string): number => {
      let n = 0;
      for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) * (i + 1);
      return n;
    };
    /** what lands in the record: the codepage spelling before R2007 */
    const stored = (s: string): string => (V >= 2007 ? s : outText(s));
    const pieces = (s: string): XdataValue[] => {
      const out: XdataValue[] = [];
      for (let i = 0; i < s.length; i += 250) out.push({ code: 1, value: s.slice(i, i + 250) });
      return out;
    };
    const joined = (values: XdataValue[]): string =>
      values.map((v) => (v.code === 1 && 'value' in v ? String(v.value) : '')).join('');
    for (const [e, h] of entH) {
      if (e.type !== 'mtext') continue;
      const height = e.height > 0 ? e.height : 5;
      const t0 = (e.raw ?? e.text).replace(/\n/g, '\\P');
      const t4 = flattenMtextParagraphs(t0, 2004, height);
      const tw = mtextWritten(e);
      /* the source's own chain, when the entity came with one */
      const srcDict = e.xdict ? sealedByH.get(e.xdict.toUpperCase()) : undefined;
      const srcRt = (key: string): { handle: string; text: string } | undefined => {
        const en = srcDict?.entries?.find((x) => x.name.toUpperCase() === key);
        const vals = en ? xrecordValues.get(en.handle.toUpperCase()) : undefined;
        return en && vals ? { handle: en.handle, text: joined(vals) } : undefined;
      };
      const src2008 = srcRt('ACAD_MTEXT_2008_RT');
      const src2004 = srcRt('ACAD_MTEXT_RT');
      const orig2008 = t4 !== t0 ? t0 : src2008?.text;
      const orig2004 = tw !== t4 ? t4 : (V <= 2000 ? src2004?.text : undefined);
      if (!orig2008 && !orig2004) continue;
      const travelling = (src?: { handle: string }): boolean =>
        !!src && !!srcDict && travel.has(srcDict) && written(src.handle);
      const entries: MtextRt['entries'] = [];
      if (orig2008 && !travelling(src2008)) {
        entries.push(['ACAD_MTEXT_2008_RT', H(),
          [{ code: 40, value: sumPos1(stored(orig2004 ?? tw)) }, ...pieces(orig2008)]]);
      }
      if (orig2004 && !travelling(src2004)) {
        entries.push(['ACAD_MTEXT_RT', H(),
          [{ code: 40, value: sumPos1(stored(tw)) }, ...pieces(orig2004)]]);
      }
      if (!entries.length) continue;
      const sealed = xdictByOwner.get(h);
      const dict = sealed?.h ?? H();
      if (sealed) for (const [n, xh] of entries) listIn(dict, n, xh);
      else synthXdict.set(h, dict);
      mtextRt.set(e, { dict, fresh: !sealed, entries });
    }
    /* The reference restores the original only for an MTEXT its
       ACDB_RECOMPOSE_DATA record names: its own 2000, 2004, 2007 and
       R14 saves list every MTEXT that carries the records (330 each,
       ascending), and from a file of ours without the listing it took
       the 2004 spelling back from ACAD_MTEXT_RT but left the 2008
       original in place — measured on the three-text probe. */
    if (mtextRt.size && !recomposeH) recomposeH = H();
  }
  const underlayDefH = new Map<string, number>();
  function modelEntsAll(): Entity[] { return drawing.entities; }
  function paperEntsAll(): Entity[] { return drawing.paperSpace ?? []; }

  /* ---------------- object encoding ---------------- */
  const objects: Obj[] = [];
  /** The seal's payload inside a proxy record, in the envelope the
   *  reference gives a proxy of its own: from R2004 a 16-bit zero word
   *  precedes the proxy data, and from R2007 the record's strings live in
   *  its string stream, not among the data bits. Both were measured on
   *  the reference's re-save of a file of ours: R2000 files carrying this
   *  seal inline opened, every R2004+ file was refused (ErrorStatus 53)
   *  until the payload took this shape — then all of them opened at AUDIT
   *  zero. The reader's unwrap (objects.ts) mirrors it. */
  const sealBody = (
    w: BitWriter,
    s: { data?: string; dataBits?: number; strData?: string; strBits?: number;
      appClass?: { cppName?: string } },
    cppName?: string
  ): void => {
    if (V >= 2004) w.rs(0);
    w.rl(s.dataBits ?? 0);
    if (s.data && s.dataBits) w.putBits(fromBase64(s.data), s.dataBits);
    w.rl(s.strBits ?? 0);
    if (s.strData && s.strBits) w.putBits(fromBase64(s.strData), s.strBits);
    /* R2007+: the proxy record's string stream is a field of its own —
       one text, "cn:" and the class name — that the reference parses
       (a seal with no string stream at all was refused; the reference's
       re-save of ours replaces whatever was there with exactly this) */
    if (V >= 2007) w.t('cn:' + (cppName ?? s.appClass?.cppName ?? 'AcDbObject'));
  };

  /** An XRECORD's data from its typed values: the byte-counted run of
   *  (RS group, value) the reader decodes — reals as RD, points as three,
   *  8/16/32/64-bit integers as RC/RS/RL/RLL, binary as a counted byte
   *  run, an object id as an absolute 64-bit handle (followed through
   *  this file's numbering), and strings as this release spells them:
   *  a UTF-16 run from R2007, a counted byte run behind a codepage
   *  byte before. The run is byte-aligned by construction. */
  const xrecordBody = (w: BitWriter, values: XdataValue[]): void => {
    const run = new BitWriter();
    for (const val of values) {
      if ('point' in val) {
        run.rs(val.code);
        run.rd(val.point.x); run.rd(val.point.y); run.rd(val.point.z ?? 0);
        continue;
      }
      const value = val.value;
      const num = typeof value === 'number' ? value : Number(value) || 0;
      switch (resbufKind(val.code)) {
        case 'string': {
          run.rs(val.code);
          if (V >= 2007) {
            const s = String(value);
            run.rs(s.length);
            for (let i = 0; i < s.length; i++) run.rs(s.charCodeAt(i));
          } else {
            const s = outText(String(value));
            run.rs(s.length);
            run.rc(30);                   /* ANSI_1252, the file's codepage */
            for (let i = 0; i < s.length; i++) run.rc(s.charCodeAt(i) & 0xff);
          }
          break;
        }
        case 'real': run.rs(val.code); run.rd(num); break;
        case 'point': run.rs(val.code); run.rd(num); run.rd(0); run.rd(0); break;
        case 'int8': case 'bool': run.rs(val.code); run.rc(num & 0xff); break;
        case 'int16': run.rs(val.code); run.rs(num & 0xffff); break;
        case 'int32': run.rs(val.code); run.rl(num >>> 0); break;
        case 'int64': run.rs(val.code); run.rll(num); break;
        case 'binary': {
          const hex = String(value).replace(/[^0-9a-fA-F]/g, '');
          const n = Math.min(255, hex.length >> 1);
          run.rs(val.code); run.rc(n);
          for (let i = 0; i < n; i++) run.rc(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
          break;
        }
        case 'handle': run.rs(val.code); run.rll(mapRef(String(value))); break;
        default: break;                   /* an unknown group is not a value */
      }
    }
    const bytes = run.bytes();
    w.bl(bytes.length);
    w.raw(bytes);
  };

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

  /** The R2007+ string-stream size, in the reader's own two-word spelling:
   *  one RS through 0x7FFF bits, and past that a high word FIRST, then the
   *  low word with its 0x8000 continuation flag. The old single-word write
   *  silently truncated any stream of 32768+ bits — a drawing carrying a
   *  few hundred application classes has exactly that in its CLASSES
   *  section, and the whole section read back as zero classes. */
  const strStreamSize = (w: BitWriter, size: number): void => {
    if (size >= 0x8000) {
      w.rs(size >> 15);
      w.rs((size & 0x7fff) | 0x8000);
    } else {
      w.rs(size);
    }
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
    strStreamSize(w, size);
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

  /** Wrap one object: type + bitsize + body builder + handle builder.
   *  `xdictH` marks an extension dictionary as present — the handle
   *  itself is the caller's to write in its handle stream. */
  const makeObject = (
    type: number, handle: number,
    data: (w: BitWriter) => void,
    handles: (w: BitWriter) => void,
    xdictH = 0,
    xdata?: XdataGroup[],
    /** Persistent reactors: the count here, the handles (code 4, after
     *  the owner) the caller's to write in its handle stream. */
    reactorCount = 0
  ): void => {
    const w = new BitWriter();
    let sizePos = objectPrologue(w, type);
    const sw = withStrings(w);
    w.h(0, handle);
    writeEedGroups(w, xdata);             /* EED, then its end */
    if (V <= 14) { sizePos = w.pos; w.rl(0); }  /* handle-stream position */
    w.bl(reactorCount);                   /* reactor count */
    if (V >= 2004) w.b(xdictH ? 0 : 1);   /* xdict missing */
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
    writeEed(w, e);
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
    /* persistent reactors: the hatch back-links rebuilt above, and the
       source's own (a constraint's dependency, a field) for every
       target that is in this file */
    const reactors = [...(reactorsFor.get(handle) ?? [])];
    for (const r of e.reactors ?? []) {
      const t = outOf(r);
      if (t !== undefined && !reactors.includes(t)) reactors.push(t);
    }
    w.bl(reactors.length);
    const ltFlags = e.linetype && !/^bylayer$/i.test(e.linetype)
      ? (/^byblock$/i.test(e.linetype) ? 1
        : /^continuous$/i.test(e.linetype) ? 2 : 3)
      : 0;
    if (V <= 14) w.b(ltFlags === 0 ? 1 : 0);   /* isbylayerlt */
    /* the entity's extension dictionary, when the sealed one the reader
       kept for it goes out under it (see xdictByOwner), or the one this
       writer builds for an MTEXT's round-trip records (synthXdict) */
    const xd = xdictByOwner.get(handle)?.h ?? synthXdict.get(handle) ?? 0;
    if (V >= 2004) w.b(xd ? 0 : 1);       /* xdict missing */
    if (V <= 2002) w.b(0);                /* nolinks = 0: chain present */
    if (V >= 2018) w.b(ctx.hasDs ? 1 : 0);  /* has_ds_data (2013+) */
    /* ENC (R2004+): a true colour is flags 0x80 in the high byte with
       the nearest ACI as the legacy index, then the 0xC2-method RGB
       dword — bit-for-bit what AutoCAD writes (walked off the field
       corpus). Collapsing it to index 7 painted every true-colour
       entity white/black. */
    if (V >= 2004 && e.color.kind === 'rgb') {
      w.bs(0x8000 | (nearestAci(e.color.rgb) & 0xff));
      w.bl((0xc2000000 | (e.color.rgb & 0xffffff)) >>> 0);
    } else {
      w.bs(colorIndex(e));
    }
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
    for (const rh of reactors) w.h(4, rh);  /* hatch back-link, etc. */
    if (V < 2004 || xd) w.h(3, xd);       /* xdict (2004+: absent = missing) */
    if (V <= 14) {
      /* R13/R14 name the layer and linetype first, then the sibling
       * chain. R2000 swapped the two groups round. */
      w.h(5, layerHandle);
      /* every linetype but ByLayer is a handle here — ByBlock and an
         explicit Continuous included (the reference read the sibling
         chain as the linetype when the entry was missing, and refused
         eleven of its own samples over it) */
      if (ltFlags !== 0) {
        w.h(5, ltFlags === 1 ? ltByblock : ltFlags === 2 ? ltContinuous
          : (ltypeH.get(e.linetype!) ?? ltContinuous));
      }
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
  /** The entity's OCS normal. Forging +Z here relocates every mirrored
   *  entity to its mirror image — the ellipse case already learned this
   *  against AutoCAD 2027 (ErrorStatus 53). */
  const ext3 = (e: { extrusion?: Point3 }): [number, number, number] => {
    const n = e.extrusion;
    return n ? [n.x, n.y, n.z ?? 1] : [0, 0, 1];
  };

  const HA: Record<string, number> = {
    left: 0, center: 1, right: 2, aligned: 3, middle: 4, fit: 5
  };
  const VA: Record<string, number> = {
    baseline: 0, bottom: 1, middle: 2, top: 3
  };

  /** TEXT / ATTRIB / ATTDEF body through valign. Callers append their
   *  own tail (tag, flags, prompt). */
  const writeTextBody = (w: BitWriter, e: TextEntity): void => {
    const ha = HA[e.halign ?? 'left'] ?? 0;
    const va = VA[e.valign ?? 'baseline'] ?? 0;
    const elev = e.position.z ?? 0;
    const wf = e.widthFactor ?? 1;
    const [ex, ey, ez] = ext3(e);
    if (V <= 14) {
      const ap0 = e.alignmentPoint ?? e.position;
      w.bd(elev);
      w.rd(e.position.x); w.rd(e.position.y);
      w.rd(ap0.x); w.rd(ap0.y);
      w.bd3(ex, ey, ez);
      w.bd(0);                          /* thickness */
      w.bd(e.oblique ?? 0);
      w.bd(e.rotation);
      w.bd(e.height > 0 ? e.height : 5);
      w.bd(wf);
      w.t(outText(e.text));
      w.bs(0);                          /* generation */
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
    df |= 0x20;                         /* generation default */
    if (!ha) df |= 0x40;
    if (!va) df |= 0x80;
    w.rc(df);
    if (!(df & 0x01)) w.rd(elev);
    w.rd(e.position.x); w.rd(e.position.y);
    if (!(df & 0x02)) { w.dd(ap!.x, e.position.x); w.dd(ap!.y, e.position.y); }
    w.be(ex, ey, ez);
    w.bt(0);
    if (!(df & 0x04)) w.rd(e.oblique ?? 0);
    if (!(df & 0x08)) w.rd(e.rotation);
    w.rd(e.height > 0 ? e.height : 5);
    if (!(df & 0x10)) w.rd(wf);
    w.t(outText(e.text));
    if (!(df & 0x40)) w.bs(ha);
    if (!(df & 0x80)) w.bs(va);
  };

  const remapXdValue = (val: XdataValue): XdataValue => {
    if (!('value' in val) || (val.code !== 1005 && val.code !== 1003)) return val;
    const src = String(val.value).toUpperCase();
    const out = srcToOut.get(src);
    return { code: val.code, value: out !== undefined ? out.toString(16).toUpperCase() : '0' };
  };

  /** EED groups as a record's prologue carries them, terminated —
   *  entities and dictionary-owned objects alike. */
  const writeEedGroups = (w: BitWriter, xdata?: XdataGroup[]): void => {
    for (const g of xdata ?? []) {
      const name = (g.appName
        || (g.appHandle ? 'APP_' + g.appHandle.toUpperCase() : 'ACAD')).toUpperCase();
      const app = appidH.get(name) ?? appidAcad;
      const payload = encodeEedValues(g.values.map(remapXdValue), V);
      /* A zero-size chunk is the EED terminator — an empty group would
         cut off every group after it. */
      if (!payload.length) continue;
      w.bs(payload.length);
      w.h(5, app);
      w.raw(payload);
    }
    w.bs(0);
  };
  const writeEed = (w: BitWriter, e: Entity): void => writeEedGroups(w, e.xdata);

  /* ---- entity-specific encoders (mirror of the decoders) ---- */
  let attdefSeq = 0;                      /* invented ATTDEF tags */
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
            wbt(w, 0); wbe(w, ...ext3(e));
            return;
          }
          const zZero = (e.start.z ?? 0) === 0 && (e.end.z ?? 0) === 0;
          w.b(zZero ? 1 : 0);
          w.rd(e.start.x); w.dd(e.end.x, e.start.x);
          w.rd(e.start.y); w.dd(e.end.y, e.start.y);
          if (!zZero) { w.rd(e.start.z ?? 0); w.dd(e.end.z ?? 0, e.start.z ?? 0); }
          wbt(w, 0); wbe(w, ...ext3(e));
        });
        return;
      case 'point':
        makeEntity(27, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          wbt(w, 0); wbe(w, ...ext3(e)); w.bd(0);
        });
        return;
      case 'circle':
        makeEntity(18, handle, e, ctx, (w) => {
          w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
          w.bd(e.radius);
          wbt(w, 0); wbe(w, ...ext3(e));
        });
        return;
      case 'arc':
        makeEntity(17, handle, e, ctx, (w) => {
          w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
          w.bd(e.radius);
          wbt(w, 0); wbe(w, ...ext3(e));
          w.bd(e.startAngle); w.bd(e.endAngle);
        });
        return;
      case 'ellipse':
        makeEntity(35, handle, e, ctx, (w) => {
          w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
          w.bd3(e.majorAxis.x, e.majorAxis.y, e.majorAxis.z ?? 0);
          /* The ellipse is a true 3D entity: center and major axis are
             WCS and this field is its plane NORMAL, not an OCS
             extrusion to convert away. Forging +Z here mirrored every
             mirrored ellipse — and AutoCAD 2027 refuses the drawing
             (ErrorStatus 53) when the forged normal is no longer
             perpendicular to the major axis within its tolerance,
             which a real field drawing's near-planar tilts exceed. */
          const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
          w.bd3(n.x, n.y, n.z ?? 1);
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
          wbe(w, ...ext3(e));
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
        const is3d = e.heavy === '3d' || e.vertices.some((v) => v.z !== undefined);
        if (e.heavy || is3d) {
          /* THE HEAVY POLYLINE: a header, a VERTEX record per vertex and a
             SEQEND, chained like the mesh family. A spline-fit polyline
             carries its frame (VERTEX 70 = 16) and the fitted curve (8)
             in the reference's own order — the first frame vertex, then
             the whole fitted run, then the rest of the frame (pinned on
             its DXF of the Road Profile and T-01 samples: 16, 8×n, 16,
             16); a curve-fit one flags the vertices fitting inserted (1);
             a 3D polyline's vertices all carry 32. Both readers sort the
             records by flag, so either order reads back the same. */
          const frame = e.fit && e.fit !== 'curve' ? (e.frame ?? []) : [];
          const vertFlag = (v: PolylineVertex): number =>
            e.fit === 'curve' ? (v.curveFit ? 1 : 0) : e.fit ? 8 : 0;
          const all = [
            ...frame.slice(0, 1).map((v) => ({ v, f: 16 })),
            ...e.vertices.map((v) => ({ v, f: vertFlag(v) })),
            ...frame.slice(1).map((v) => ({ v, f: 16 }))
          ];
          const vertHs = all.map(() => H());
          const seqendH = H();
          const curveType = e.fit === 'quadratic' ? 5 : e.fit === 'cubic' ? 6 : 0;
          const flag70 = (e.closed ? 1 : 0)
            | (e.fit === 'curve' ? 2 : e.fit ? 4 : 0)
            | (e.plineGen ? 128 : 0);
          makeEntity(is3d ? 16 : 15, handle, e, ctx, (w) => {
            if (is3d) {
              /* two bytes: curve type, then the flags (bit 0 closed) */
              w.rc(curveType);
              w.rc(flag70);
            } else {
              w.bs(flag70);
              w.bs(curveType);
              w.bd(0); w.bd(0);           /* default widths */
              wbt(w, 0);                  /* thickness */
              w.bd(e.elevation ?? 0);
              wbe(w, ...ext3(e));
            }
            if (V >= 2004) w.bl(all.length);
          }, (w) => {
            if (V < 2004) {
              w.h(4, vertHs[0] ?? 0);     /* first vertex */
              w.h(4, vertHs[vertHs.length - 1] ?? 0);
            } else {
              for (const vh of vertHs) w.h(4, vh);
            }
            w.h(3, seqendH);
          });
          /* the sub-records repeat the owner's layer, colour, linetype
             and weight — the audit resets a vertex whose colour differs
             from its owner's, one error per vertex */
          const sub = (p: Point3): Entity => ({
            type: 'point', layer: e.layer, color: e.color,
            linetype: e.linetype, lineweight: e.lineweight,
            linetypeScale: e.linetypeScale, position: p
          });
          all.forEach(({ v, f }, i) => {
            const fake = sub({ x: v.x, y: v.y, z: v.z ?? 0 });
            makeEntity(is3d ? 11 : 10, vertHs[i], fake, {
              entmode: 0, owner: handle,
              prev: vertHs[i - 1] ?? 0, next: vertHs[i + 1] ?? 0
            }, (w) => {
              if (is3d) {
                w.rc(32 | f);
                w.bd3(v.x, v.y, v.z ?? 0);
                return;
              }
              w.rc(f | (v.tangent !== undefined ? 2 : 0));
              w.bd3(v.x, v.y, e.elevation ?? 0);
              /* one negative width stands for an equal pair — but 0.0 has
                 no sign to carry, so a zero pair is spelled out */
              const sw = v.startWidth ?? 0, ew = v.endWidth ?? 0;
              if (sw === ew && sw !== 0) w.bd(-sw);
              else { w.bd(sw); w.bd(ew); }
              w.bd(v.bulge ?? 0);
              if (V >= 2010) w.bl(v.id ?? 0);
              w.bd(v.tangent ?? 0);
            });
          });
          makeEntity(6, seqendH, sub({ x: 0, y: 0, z: 0 }),
            { entmode: 0, owner: handle }, () => { /* SEQEND: no data */ });
          return;
        }
        makeEntity(77, handle, e, ctx, (w) => {
          const hasBulges = e.vertices.some((v) => v.bulge);
          const hasWidths = e.vertices.some((v) => v.startWidth || v.endWidth);
          /* R2010+ vertex identifiers (DXF 91): flag 0x400 and one BL per
             vertex, between the bulges and the widths */
          const hasIds = V >= 2010 && e.vertices.some((v) => v.id);
          let flag = 0;
          if (e.constantWidth) flag |= 4;
          if (e.elevation) flag |= 8;
          if (hasBulges) flag |= 16;
          if (hasWidths) flag |= 32;
          if (e.plineGen) flag |= 256;
          if (e.closed) flag |= 512;
          if (hasIds) flag |= 1024;
          if (e.extrusion) flag |= 1;
          w.bs(flag);
          if (e.constantWidth) w.bd(e.constantWidth);
          if (e.elevation) w.bd(e.elevation);
          if (e.extrusion) w.bd3(...ext3(e));
          w.bl(e.vertices.length);
          if (hasBulges) w.bl(e.vertices.length);
          if (hasIds) w.bl(e.vertices.length);
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
          if (hasIds) for (const v of e.vertices) w.bl(v.id ?? 0);
          if (hasWidths) {
            for (const v of e.vertices) { w.bd(v.startWidth ?? 0); w.bd(v.endWidth ?? 0); }
          }
        });
        return;
      }
      case 'text': {
        const attdef = e.attribute === 'attdef';
        /* ATTDEF closes the TEXT body with its definition fields; the
           reader takes the flags back into invisible/constant, so a
           hidden attribute stays hidden across a rewrite. */
        const attdefTail = (w: BitWriter): void => {
          if (!attdef) return;
          const tag = 'ATTD' + ++attdefSeq;   /* model keeps no tag */
          if (V >= 2018) { w.rc(0); w.rc(1); }  /* class version, single-line */
          w.t(V <= 14 ? outText(r14Str(tag)) : tag);
          w.bs(0);                          /* field length */
          w.rc((e.invisible ? 1 : 0) | (e.constant ? 2 : 0));
          if (V >= 2007) w.b(0);            /* lock-position flag */
          if (V >= 2018) w.rc(0);           /* attdef class version */
          w.t('');                          /* prompt */
        };
        makeEntity(attdef ? 3 : 1, handle, e, ctx, (w) => {
          writeTextBody(w, e);
          attdefTail(w);
        }, (w) => {
          w.h(5, styleH.get(e.style ?? '') ?? styleH.get('Standard') ?? [...styleH.values()][0]);
        });
        return;
      }
      case 'mtext': {
        makeEntity(44, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          w.bd3(...ext3(e));              /* extrusion */
          const rot = e.rotation || 0;
          w.bd(Math.cos(rot)); w.bd(Math.sin(rot)); w.bd(0);
          w.bd(e.width ?? 0);
          if (V >= 2007) w.bd(0);         /* rect height (2007+) */
          w.bd(e.height > 0 ? e.height : 5);
          w.bs(e.attachment ?? 1);
          w.bs(1);                        /* flow: left to right */
          w.bd(0); w.bd(0);               /* extents */
          /* paragraph codes the target release cannot show are rewritten
             the way the reference rewrites them on its own older saves
             (mtextWritten), the original kept beside the entity in the
             round-trip records the reference restores it from */
          w.t(outText(mtextWritten(e)));
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
          w.bd3(...ext3(e));              /* normal */
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
        const attrHs = attrs.map((a) => attribH.get(a) ?? H());
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
          w.bd3(...ext3(e));
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
            writeTextBody(w, a);
            if (V >= 2018) {
              /* R2010 added a class-version byte, R2018 the attribute
                 type (1 = single-line) — both sit before the tag, and
                 omitting them shifts AutoCAD's parse (ErrorStatus 53,
                 singleton-proven) */
              w.rc(0);                    /* class version */
              w.rc(1);                    /* attribute type: single-line */
            }
            w.t(V <= 14 ? outText(r14Str('ATTR' + (i + 1))) : 'ATTR' + (i + 1));
            w.bs(0);                      /* field length */
            w.rc((a.invisible ? 1 : 0) | (a.constant ? 2 : 0));
            if (V >= 2007) w.b(0);        /* lock-position flag */
          }, (w) => {
            w.h(5, styleH.get(a.style ?? '') ?? [...styleH.values()][0]);
          });
        });
        if (attrs.length) {
          const fake: Entity = {
            type: 'point', layer: e.layer, color: { kind: 'byLayer' },
            linetype: e.linetype,
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
          w.bd3(...ext3(e));              /* extrusion */
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
        const { associative, loopBounds } = hatchLink.get(e)
          ?? { associative: false, loopBounds: e.loops.map(() => []) };
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
          w.bd3(...ext3(e));
          w.t(outText(e.patternName || (e.solid ? 'SOLID' : 'ANSI31')));
          w.b(e.solid ? 1 : 0);
          /* Associative-with-no-boundary is audited on every such hatch
             ("Boundary Undefined — Remove Associativity"), so the flag
             is only written when the loop's generating handles remapped
             onto entities that are actually in this file. */
          w.b(associative ? 1 : 0);
          w.bl(e.loops.length);
          /* The loop-type bits ride with each loop: external(1),
             derived(4), outermost(16) — audit erases a style-1/2 hatch
             whose loops all lost their external bit. The derived bit is
             only spelled when the pixel size that must follow the
             pattern block is known. */
          const loopBits = (lp: typeof e.loops[number]): number =>
            (lp.external ? 1 : 0)
            | (lp.derived && e.pixelSize !== undefined ? 4 : 0)
            | (lp.outermost ? 16 : 0);
          const anyDerived = e.loops.some(
            (lp) => lp.derived && e.pixelSize !== undefined);
          e.loops.forEach((loop, li) => {
            if (loop.kind === 'polyline') {
              w.bl(2 | loopBits(loop));   /* polyline path */
              const bulges = loop.vertices.some((p) => p.bulge);
              w.b(bulges ? 1 : 0);
              w.b(loop.closed ? 1 : 0);
              w.bl(loop.vertices.length);
              for (const p of loop.vertices) {
                w.rd(p.x); w.rd(p.y);
                if (bulges) w.bd(p.bulge ?? 0);
              }
            } else {
              w.bl(loopBits(loop));       /* edge path */
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
                  /* R2010+ closes a spline edge with its fit data: the
                     count, and — only when there are any — the points
                     and the two end tangents. Omitting the count leaves
                     the record misaligned from here on: our own reader
                     seals such a hatch as an undecodable unknown, and
                     AutoCAD 2027 refuses the drawing (ErrorStatus 53)
                     or dies in regen when they come by the thousand. */
                  if (V >= 2010) {
                    const fits = ed.fitPoints ?? [];
                    w.bl(fits.length);
                    if (fits.length) {
                      for (const p of fits) { w.rd(p.x); w.rd(p.y); }
                      w.rd(0); w.rd(0);   /* start tangent: default */
                      w.rd(0); w.rd(0);   /* end tangent: default */
                    }
                  }
                }
              }
            }
            w.bl(associative ? (loopBounds[li]?.length ?? 0) : 0);
          });
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
          if (anyDerived) w.bd(e.pixelSize!);   /* derived-boundary size */
          const seeds = e.seeds ?? [];
          w.bl(seeds.length);
          for (const s of seeds) { w.rd(s.x); w.rd(s.y); }
        }, (w) => {
          if (!associative) return;
          for (const hs of loopBounds) {
            for (const h of hs) w.h(4, h);
          }
        });
        return;
      }

      case 'mline': {
        makeEntity(47, handle, e, ctx, (w) => {
          w.bd(e.scale || 1);
          w.rc(e.justification & 0xff);
          w.bd3(e.basePoint.x, e.basePoint.y, e.basePoint.z ?? 0);
          w.bd3(...ext3(e));
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
          /* the style its styleName names, else STANDARD (which exists
             in every release, synthesized when the drawing has none) */
          w.h(5, mlineStyleFor(e.styleName));   /* mlinestyle */
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
          w.bd3(...ext3(e));
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
          w.bd3(...ext3(e));
        }, (w) => {
          w.h(5, styleH.get(e.style ?? '') ?? [...styleH.values()][0]);
        });
        return;

      case 'leader': {
        makeEntity(45, handle, e, ctx, (w) => {
          w.b(0);
          /* the annotation the leader points at, when that entity is in
             this file; a leader that claims one while naming none is
             audited by the reference ("Bad mtext id"), so an annotation
             that stayed home makes the leader annotate nothing */
          w.bs(leaderAnnotationH(e) ? (e.annotationType ?? 0) : 3);
          w.bs(e.pathType ?? 0);
          w.bl(e.vertices.length);
          for (const p of e.vertices) w.bd3(p.x, p.y, p.z ?? 0);
          const last = e.vertices[e.vertices.length - 1] ?? { x: 0, y: 0, z: 0 };
          w.bd3(last.x, last.y, last.z ?? 0);   /* origin */
          w.bd3(...ext3(e));              /* extrusion */
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
          w.h(2, leaderAnnotationH(e));   /* associated annotation */
          w.h(5, dimStandardH);           /* dimstyle */
        });
        return;
      }

      case 'viewport': {
        if (V <= 14) {
          /* R13/R14 keep the view in an ACAD "MVIEW" xdata group (kind 16:
             target, direction, twist, height, centre, lens, clips, view
             mode, circle zoom, fast zoom, ucs icon, snap/grid/style/isopair,
             snap angle and base, snap and grid spacing, hidden-plot, frozen
             layers) — the body is centre, width and height, and the handle
             stream one null VX entity header. Proven against the
             reference's own R14 save: a viewport without the group is
             refused, with it the drawing opens at AUDIT 0. */
          const t = e.viewTarget ?? { x: 0, y: 0, z: 0 };
          const dv = e.viewDirection ?? { x: 0, y: 0, z: 1 };
          const vc = e.viewCenter ?? { x: e.center.x, y: e.center.y };
          const P = (p: { x: number; y: number; z?: number }): XdataValue =>
            ({ code: 1010, point: { x: p.x, y: p.y, z: p.z ?? 0 } });
          const R = (v: number): XdataValue => ({ code: 1040, value: v });
          const I = (v: number): XdataValue => ({ code: 1070, value: v });
          const B = (v: string): XdataValue => ({ code: 1002, value: v });
          const values: XdataValue[] = [
            { code: 1000, value: 'MVIEW' }, B('{'), I(16), P(t), P(dv),
            R(e.twistAngle ?? 0), R(e.viewHeight ?? e.height), R(vc.x), R(vc.y),
            R(e.lensLength ?? 50), R(0), R(0), I(0), I(1000), I(1), I(3),
            I(0), I(0), I(0), I(0), R(0), R(0), R(0), R(0.5), R(0.5), R(0.5), R(0.5),
            I(0), B('{'), B('}'), B('}')
          ];
          const isMview = (g: XdataGroup): boolean =>
            g.values.some((v) => v.code === 1000 && 'value' in v && v.value === 'MVIEW');
          const vp = { ...e, xdata: [...(e.xdata ?? []).filter((g) => !isMview(g)), { appName: 'ACAD', values }] };
          makeEntity(34, handle, vp, ctx, (w) => {
            w.bd3(e.center.x, e.center.y, e.center.z ?? 0);
            w.bd(e.width); w.bd(e.height);
          }, (w) => { w.h(5, 0); });      /* VX entity header */
          return;
        }
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
      }

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
        /* the block labels: one value per ATTDEF of the block, named by
           the definition's handle (remapped to this file's numbering) or,
           failing that, by its 1-based position among the block's ATTDEFs */
        const blockAttdefs: TextEntity[] = hasBlock
          ? (drawing.blocks[e.blockName!]?.entities ?? []).filter(
              (a): a is TextEntity => a.type === 'text' && a.attribute === 'attdef')
          : [];
        const labels = hasBlock
          ? (e.attributes ?? []).filter((a) => typeof a.text === 'string') : [];
        const attdefHandleOf = (lb: { attdef?: string; index?: number }): number => {
          if (lb.attdef) {
            const h = srcToOut.get(lb.attdef.toUpperCase());
            if (h !== undefined && blockAttdefs.some((a) => entH.get(a) === h)) return h;
          }
          const byIndex = blockAttdefs[(lb.index || 1) - 1];
          return byIndex ? entH.get(byIndex) ?? 0 : 0;
        };
        /* pre-2010 readers take the class version from an
           ACAD_MLEADERVER xdata group (1070 = 2) on the entity and on
           its style; the reference stamps it in every release, and
           refuses a record without it (proven: a stripped entity refused,
           the same one stamped opened) */
        const MLVER = 'ACAD_MLEADERVER';
        const stamped = e.xdata?.some((g) => g.appName === MLVER) ? e
          : { ...e, xdata: [...(e.xdata ?? []), { appName: MLVER, values: [{ code: 1070, value: 2 }] }] };
        makeEntity(CLS_MLEADER, handle, stamped, ctx, (w) => {
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
            w.bd3(...ext3(e));            /* normal */
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
              w.bd3(...ext3(e));          /* normal */
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
          /* The close of the common data, bit-walked against the
             reference's own saves of its multileader sample at 2000,
             2004, 2007, 2010, 2013 and 2018 (each record lands on its
             last data bit with every handle and string consumed): before
             R2010 an arrowhead list (empty here) — R2010+ has none — then
             the block labels (BL count; per label TV text, BS index, BD
             width; the ATTDEF handle in the handle stream), the
             text-direction bit, IPE alignment, attachment point, the two
             bits (0, 1) every release closes with, and from R2010 the
             attachment-direction trio plus R2013's trailing flag. The
             2000/2004/2007 form was also proven the hard way: a record
             twelve bits short was refused in all three. */
          if (V < 2018) w.bl(0);          /* arrowhead count */
          w.bl(labels.length);
          for (const lb of labels) {
            w.t(outText(lb.text));
            w.bs(lb.index || 1);
            w.bd(lb.width ?? 0);
          }
          w.b(0);                         /* text direction negative */
          w.bs(0); w.bs(1);               /* IPE align, attachment point */
          w.b(0); w.b(1);
          if (V >= 2018) {
            w.bs(0);                      /* attachment direction */
            w.bs(9); w.bs(9);             /* top / bottom attachment */
            w.b(0);                       /* 2013+ trailing flag */
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
          w.h(5, mleaderStyleFor(e.styleName));   /* mleader style */
          w.h(5, 0);                      /* line linetype */
          w.h(5, 0);                      /* arrow head */
          /* the common section's own content references (text style +
             block style), present in every AutoCAD-minted record */
          w.h(5, styleH.get(e.textStyle ?? '') ?? styleH.get('Standard')
            ?? [...styleH.values()][0]);
          w.h(5, hasBlock ? blockH2! : 0);
          /* one soft pointer per block label, after the block reference —
             the reference's own order */
          for (const lb of labels) w.h(4, attdefHandleOf(lb));
        });
        return;
      }

      case 'table': {
        const rows = e.numRows, cols = e.numColumns;
        /* the cells a merge covers — every one but its anchor */
        const covered = new Uint8Array(rows * cols);
        for (let r2 = 0; r2 < rows; r2++) {
          for (let c2 = 0; c2 < cols; c2++) {
            const cell = e.cells[r2 * cols + c2];
            if (!cell || covered[r2 * cols + c2]) continue;
            const sc = Math.max(1, cell.spanColumns ?? 1), sr = Math.max(1, cell.spanRows ?? 1);
            for (let rr = r2; rr < Math.min(rows, r2 + sr); rr++) {
              for (let cc = c2; cc < Math.min(cols, c2 + sc); cc++) {
                if (rr !== r2 || cc !== c2) covered[rr * cols + cc] = 1;
              }
            }
          }
        }
        const EDGES = ['top', 'right', 'bottom', 'left'] as const;
        const cellBlockOf = (cell: TableCell): number | undefined =>
          cell.contentType === 2 && cell.blockName ? blockH.get(cell.blockName) : undefined;
        const cellStyleOf = (cell: TableCell): number | undefined =>
          cell.textStyle ? styleH.get(cell.textStyle) : undefined;
        /* R2010+: what the content's own format states, as its override
           flags — 0x04 rotation, 0x20 colour, 0x40 text style, 0x80 text
           height (bit-walked on the reference's 2018 conversion of this
           library's R2000 fixture) */
        const contentOverride = (cell: TableCell, flags: number): number =>
          (cell.rotation ? 0x04 : 0) | (flags & 0x08 ? 0x20 : 0)
          | (flags & 0x10 ? 0x40 : 0) | (flags & 0x20 ? 0x80 : 0);
        /* the cell flag byte (DXF 172): the edges the cell overrides, 1
           top, 2 right, 4 bottom, 8 left — the reference's own files
           spell 8 for a left edge and 9 for left + top, and its DXFIN
           ignores an edge override the byte does not announce */
        const edgeMask = (cell: TableCell): number =>
          EDGES.reduce((m, edge, i) => cell.borders?.[edge] ? m | (1 << i) : m, 0);
        /* a cell's override flag word in the pre-2010 spelling (the DXF
           177 word): 0x01 alignment, 0x02 fill switch, 0x04 fill colour,
           0x08 text colour, 0x10 text style, 0x20 text height, then per
           edge top/right/bottom/left the colour 0x40<<i, lineweight
           0x400<<i and visibility 0x4000<<i — the reference's own R2000
           export of its Text-and-Tables sample spells 0x2200 for a left
           edge and 0x4440 for a top one */
        const overrideFlags = (cell: TableCell): number => {
          let f = 0;
          if (cell.alignment !== undefined) f |= 0x01;
          if (cell.fillEnabled !== undefined) f |= 0x02;
          if (cell.fillColor) f |= 0x04;
          if (cell.textColor) f |= 0x08;
          if (cellStyleOf(cell) !== undefined) f |= 0x10;
          if (cell.textHeight !== undefined && cell.textHeight > 0) f |= 0x20;
          EDGES.forEach((edge, i) => {
            const b = cell.borders?.[edge];
            if (!b) return;
            if (b.color) f |= 0x40 << i;
            if (b.lineweight !== undefined) f |= 0x400 << i;
            if (b.visible !== undefined) f |= 0x4000 << i;
          });
          return f;
        };
        /* the R2004 CMC spelling the cell records use in every release:
           a zero index, the method in the dword's top byte (0xC0 ByLayer,
           0xC1 ByBlock, 0xC2 rgb, 0xC3 index, 0xC8 none) and no names */
        const cmcCell = (w: BitWriter, c: Color | undefined): void => {
          w.bs(0);
          const dword = !c ? 0xC8000000
            : c.kind === 'byLayer' ? 0xC0000000
            : c.kind === 'byBlock' ? 0xC1000000
            : c.kind === 'aci' ? (0xC3000000 | (c.index & 0xff))
            : (0xC2000000 | (c.rgb & 0xffffff));
          w.bl(dword >>> 0);
          w.rc(0);
        };
        /* row style ids: 1 title, 2 header, 3 data — a suppressed title
           or header row simply is not there (what the reference's 2018
           saves of a header-less schedule show) */
        const rowStyleId = (r2: number): number => {
          let id = 1;
          if (e.titleSuppressed) id = 2;
          if (r2 === 0) return e.headerSuppressed && id === 2 ? 3 : id;
          if (r2 === 1 && !e.titleSuppressed) return e.headerSuppressed ? 3 : 2;
          return 3;
        };
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
              /* a BL, not a BS: identical bits under 256 bytes, which is
                 every schedule cell until a wall-type paragraph — the
                 reference refused a table over one 300-byte cell */
              w.bl((s.length + 1) * 2);
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
            /* A content format, in two places. The content's own carries
               what the reference keeps there — bit-walked on its 2018
               conversion of this library's R2000 fixture and on its own
               saves: 0x04 rotation, 0x20 colour, 0x80 text height with
               the values in the format itself, 0x40 a text style (the
               handle a soft null there; the style rides the cell style's
               format). The cell style's format states the alignment. The
               layout: override flags, property flags, value data and
               unit type, format string, rotation, block scale, alignment,
               colour, text style (handle stream), text height. */
            const contentFormat = (cell: TableCell, override: number, own: boolean): void => {
              w.bl(override);
              w.bl(0);                    /* property flags */
              w.bl(own ? 4 : 512); w.bl(0);   /* data type, unit type */
              w.t('');                    /* format string */
              w.bd(own ? cell.rotation ?? 0 : 0);
              w.bd(1);                    /* block scale */
              w.bl(own ? 1 : cell.alignment ?? 1);
              cmcCell(w, own ? cell.textColor ?? { kind: 'byBlock' } : { kind: 'byBlock' });
              w.bd(own && cell.textHeight ? cell.textHeight : 0.18);
            };
            /* the cell style: what the cell overrides, in the R2010+
               spelling — alignment as property override 0x10 and the fill
               colour as 0x200, the value in the style's content format /
               background colour; edges as border entries (mask 1 top, 2
               right, 4 bottom, 8 left; flags 0x02 lineweight, 0x08
               colour, 0x10 invisibility) */
            const cellStyle = (cell: TableCell, flags: number): void => {
              w.bl(1);                    /* style type: cell */
              if (!flags) { w.bs(0); return; }
              w.bs(1);
              w.bl((flags & 0x01 ? 0x10 : 0) | (flags & 0x04 ? 0x200 : 0));
              w.bl(0);                    /* merge flags */
              cmcCell(w, cell.fillColor);
              w.bl(1);                    /* content layout */
              contentFormat(cell, 0, false);
              w.bs(0);                    /* no margin overrides */
              const edges = EDGES.filter((edge) => cell.borders?.[edge]);
              w.bl(edges.length);
              for (const edge of edges) {
                const b = cell.borders![edge]!;
                w.bl(1 << EDGES.indexOf(edge));
                w.bl((b.lineweight !== undefined ? 0x02 : 0) | (b.color ? 0x08 : 0)
                  | (b.visible !== undefined ? 0x10 : 0));
                w.bl(1);                  /* border type: single */
                cmcCell(w, b.color ?? { kind: 'byBlock' });
                w.bl(b.lineweight ?? -2);
                /* linetype handle rides the handle stream */
                w.bl(b.visible === false ? 1 : 0);
                w.bd(0.045);              /* double line spacing */
              }
            };
            w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
            w.bb(3);                      /* unit scale */
            w.bd(0);                      /* rotation */
            w.bd3(...ext3(e));            /* extrusion */
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
                const flags = overrideFlags(cell);
                const cellBlock = cellBlockOf(cell);
                w.bl(0);                  /* cell flag */
                w.t('');                  /* tooltip */
                w.bl(0); w.bl(0);         /* custom data flag + count */
                w.bl(0);                  /* not externally linked */
                if (cellBlock !== undefined) {
                  w.bl(1);                /* one content */
                  w.bl(4);                /* content type: block */
                  /* block record + attdefs ride the handle stream */
                  const attrs = cell.attributes ?? [];
                  w.bl(attrs.length);
                  for (const a of attrs) { w.t(outText(a.text)); w.bl(a.index ?? 1); }
                  /* a block with attribute values always carries a content
                     format — without one the reference misreads the
                     handles (its AUDIT erases a block reference) */
                  const co = contentOverride(cell, flags);
                  w.bs(co || attrs.length ? 1 : 0);
                  if (co || attrs.length) contentFormat(cell, co, true);
                } else if (cell.text) {
                  w.bl(1);                /* one content */
                  w.bl(1);                /* content type: value */
                  value(cell.text);
                  w.bl(0);                /* attributes */
                  const co = contentOverride(cell, flags);
                  w.bs(co ? 1 : 0);
                  if (co) contentFormat(cell, co, true);
                } else {
                  w.bl(0);                /* no contents */
                }
                cellStyle(cell, flags);
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
              w.bl(rowStyleId(r2));       /* title/header/data */
              w.bd(e.rowHeights[r2] ?? 1);
            }
            w.bl(0);                      /* field references */
            style(4);                     /* the table's own cell style: none */
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
            /* the table's own *T block (withTableBlocks): a NULL here
               beside a real TABLESTYLE is audited "BTR Id invalid" */
            w.h(5, (e.blockName && blockH.get(e.blockName)) || 0);
            for (let i = 0; i < e.numRows * e.numColumns; i++) {
              /* per cell, in the reference's order: the content format's
                 text style (a soft null), the block record and its
                 ATTDEFs, the cell style's text style, one linetype per
                 border entry, then the geometry object */
              const cell = e.cells[i] ?? {};
              const flags = overrideFlags(cell);
              const cellBlock = cellBlockOf(cell);
              if (cellBlock !== undefined || cell.text) {
                if (contentOverride(cell, flags)
                    || (cellBlock !== undefined && cell.attributes?.length)) w.h(4, 0);
                if (cellBlock !== undefined) {
                  w.h(5, cellBlock);
                  for (const a of cell.attributes ?? []) {
                    w.h(4, a.attdef ? srcToOut.get(a.attdef.toUpperCase()) ?? 0 : 0);
                  }
                }
              }
              if (flags) {
                w.h(5, flags & 0x10 ? cellStyleOf(cell)! : 0);
                for (const edge of EDGES) if (cell.borders?.[edge]) w.h(5, 0);
              }
              w.h(4, 0);                  /* per-cell geometry object */
            }
            w.h(4, 0);                    /* trailing unknown */
            w.h(5, tableStyleFor(e.styleName));   /* table style */
          });
          return;
        }
        /* the pre-R2010 record: a block reference followed by the grid */
        makeEntity(CLS_TABLE, handle, e, ctx, (w) => {
          w.bd3(e.position.x, e.position.y, e.position.z ?? 0);
          if (V >= 2000) w.bb(3);         /* scale flag: all ones */
          else { w.bd(1); w.bd(1); w.bd(1); }
          w.bd(0);                        /* rotation */
          w.bd3(...ext3(e));              /* extrusion */
          w.b(0);                         /* no attribs */
          if (V >= 2004) { /* no owned attribs to count */ }
          w.bs(22);                       /* flags for table value (AutoCAD: 22) */
          const dir = e.direction ?? { x: 1, y: 0, z: 0 };
          w.bd3(dir.x, dir.y, dir.z ?? 0);
          w.bl(e.numColumns);
          w.bl(e.numRows);
          for (let i = 0; i < e.numColumns; i++) w.bd(e.columnWidths[i] ?? 1);
          for (let i = 0; i < e.numRows; i++) w.bd(e.rowHeights[i] ?? 1);
          /* the per-cell override group: the flag word, the virtual-edge
             byte, then one field per set bit in the spec's order — the
             grammar the reader walks bit-exact through the reference's
             own 2000/2004/2007 tables (text style, alignment, height and
             edge overrides all present in its samples) */
          const writeOverrides = (w2: BitWriter, cell: TableCell, f: number): void => {
            w2.bl(f);
            w2.rc(0);                     /* virtual edge */
            if (f & 0x01) w2.bs(cell.alignment!);
            if (f & 0x02) w2.b(cell.fillEnabled ? 0 : 1);   /* "fill none" */
            if (f & 0x04) cmcCell(w2, cell.fillColor);
            if (f & 0x08) cmcCell(w2, cell.textColor);
            /* 0x10: the text style handle rides the handle stream */
            if (f & 0x20) w2.bd(cell.textHeight!);
            for (const edge of EDGES) {
              const b = cell.borders?.[edge];
              if (!b) continue;
              if (b.color) cmcCell(w2, b.color);
              if (b.lineweight !== undefined) w2.bs(b.lineweight);
              if (b.visible !== undefined) w2.bs(b.visible ? 0 : 1);
            }
          };
          for (let i = 0; i < e.numRows * e.numColumns; i++) {
            const cell = e.cells[i] ?? {};
            const flags = overrideFlags(cell);
            const cellBlock = cellBlockOf(cell);
            w.bs(cellBlock !== undefined ? 2 : 1);   /* text / block cell */
            w.rc(edgeMask(cell));
            w.b(covered[i] || cell.merged ? 1 : 0);
            w.b(cell.autofit ? 1 : 0);
            w.bl(cell.spanColumns ?? 1);
            w.bl(cell.spanRows ?? 1);
            w.bd(cell.rotation ?? 0);
            if (cellBlock !== undefined) {
              /* the block record rides the handle stream; then its scale
                 and the attribute values (H attdef, BS index, TV text) */
              w.bd(1);
              const attrs = cell.attributes ?? [];
              w.b(attrs.length ? 1 : 0);
              if (attrs.length) {
                w.bs(attrs.length);
                for (const a of attrs) { w.bs(a.index ?? 1); w.t(outText(a.text)); }
              }
              if (V === 2007) {
                w.b(flags ? 1 : 0);
                if (flags) writeOverrides(w, cell, flags);
                w.bl(0);                  /* extended cell flags */
                w.bl(1); w.bl(4);         /* value not stored, string type */
                w.bl(0);                  /* unit type */
                w.t(''); w.t('');         /* format string, rendered form */
              } else {
                w.b(flags ? 1 : 0);
                if (flags) writeOverrides(w, cell, flags);
              }
              continue;
            }
            /* An R2007 cell's content is a full table VALUE rather than a
               bare string: after the override flag come the extended cell
               flags, the format flags, the data type, the text inline as
               byte-counted UTF-16, the unit type, and finally the two
               string-stream entries (the value's format string and its
               rendered form) — the reader's grammar, verified bit-exact
               against the reference's own 2000/2004/2007 tables. Pinned
               here against AutoCAD-minted AC1021 tables: each 1-character
               cell is 109 bits, and the walk lands on the four override
               bits exactly, on a 2x2 grid of single letters and a 3x2 grid
               of 1-to-8 character cells. */
            if (V === 2007) {
              w.b(flags ? 1 : 0);         /* per-cell overrides */
              if (flags) writeOverrides(w, cell, flags);
              w.bl(0);                    /* extended cell flags */
              w.bl(4);                    /* format flags: value inline */
              w.bl(4);                    /* data type: string */
              const s = cell.text ?? '';
              w.bl((s.length + 1) * 2);   /* bytes, NUL included — a BL:
                                             same bits as a BS under 256 */
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
              w.b(flags ? 1 : 0);         /* per-cell overrides */
              if (flags) writeOverrides(w, cell, flags);
            }
          }
          /* the four override-presence flags: table, border colour,
             border lineweight, border visibility. AutoCAD reads them
             unconditionally — omitting them shifts its handle-stream
             parse by four bits and the drawing is refused (splice-proven
             against AutoCAD 2027). The table group carries a flag word
             with one field per bit: 0x01 title suppressed (a B), 0x02
             header suppressed (the bit alone), 0x04 flow direction (BS),
             0x08/0x10 the horizontal/vertical cell margins (BD) — pinned
             against the reference's saves of its schedules (flags 3 and
             2). The three border groups stay absent. */
          const tf = (e.titleSuppressed ? 0x01 : 0) | (e.headerSuppressed ? 0x02 : 0)
            | (e.flowDirection !== undefined ? 0x04 : 0)
            | (e.horizontalMargin !== undefined ? 0x08 : 0)
            | (e.verticalMargin !== undefined ? 0x10 : 0);
          w.b(tf ? 1 : 0);
          if (tf) {
            w.bl(tf);
            if (tf & 0x01) w.b(1);
            if (tf & 0x04) w.bs(e.flowDirection!);
            if (tf & 0x08) w.bd(e.horizontalMargin!);
            if (tf & 0x10) w.bd(e.verticalMargin!);
          }
          w.b(0); w.b(0); w.b(0);
        }, (w) => {
          /* NULL block header and NULL table style are both accepted —
             splice-proven against AutoCAD 2027 (it regenerates the grid
             from the record itself) */
          /* the table's own *T block (withTableBlocks): NULL beside a
             real TABLESTYLE is audited "BTR Id invalid" */
          w.h(5, (e.blockName && blockH.get(e.blockName)) || 0);
          w.h(5, tableStyleFor(e.styleName));   /* table style */
          /* per cell, in cell order: a text cell's style handle (NULL
             even in the reference's files) or a block cell's record and
             one soft pointer per attribute value, then the overriding
             text style when the cell names one */
          for (let i = 0; i < e.numRows * e.numColumns; i++) {
            const cell = e.cells[i] ?? {};
            const cellBlock = cellBlockOf(cell);
            if (cellBlock !== undefined) {
              w.h(5, cellBlock);
              for (const a of cell.attributes ?? []) {
                w.h(4, a.attdef ? srcToOut.get(a.attdef.toUpperCase()) ?? 0 : 0);
              }
            } else {
              w.h(5, 0);
            }
            const sh = cellStyleOf(cell);
            if (sh !== undefined) w.h(5, sh);
          }
        });
        return;
      }

      case 'acis': {
        const typeNum = e.kind === 'region' ? 37 : e.kind === 'solid3d' ? 38 : 39;
        if (V >= 2018 && e.sab && !e.surfaceKind) {
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
          if (blob.length) {
            acdsSolids.push({ handle, sab: blob });
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
           branch above carries every solid's SAB there (proven: the
           records open in AutoCAD 2027 with AUDIT 0/0, while every
           inline form is refused with ErrorStatus 53 — and a drawing
           where only the FIRST solid rode AcDs was refused for the
           inline rest, or with dozens of them died outright in regen).
           KNOWN LIMIT: AutoCAD only accepts modern ASM-format blobs; a
           pre-ASM "ACIS BinaryFile" payload still makes it refuse the
           drawing, whichever way it is stored. A solid the AcDs branch
           cannot take falls through to the inline SAB below: it
           round-trips through this library and other readers
           losslessly, which beats discarding the payload. */
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
            linetype: e.linetype,
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
            linetype: e.linetype,
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
            linetype: e.linetype,
            position: { x: 0, y: 0, z: 0 }
          };
          makeEntity(6, seqendH, fake, { entmode: 0, owner: handle },
            () => { /* SEQEND: no data */ });
        }
        return;
      }

      case 'image': {
        /* A WIPEOUT references NO imagedef: every wipeout of the
           AutoCAD-written corpus carries a null handle there, and one
           we mint (path-less, "loaded") plots the mask as a black box.
           Real images share one imagedef per path+size. */
        let defH = 0;
        if (!e.wipeout) {
          const key = (e.path ?? '') + '|' + e.widthPx + 'x' + e.heightPx;
          const got = imageDefH.get(key);
          defH = got ?? H();
          if (got === undefined) imageDefH.set(key, defH);
        }
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
          if (V >= 2018) w.b(e.clipInverted ? 1 : 0);   /* clip mode (2010+) */
          const clip = e.clip?.length ? e.clip
            : [{ x: -0.5, y: -0.5 }, { x: e.widthPx - 0.5, y: e.heightPx - 0.5 }];
          w.bs(clip.length === 2 ? 1 : 2);
          if (clip.length !== 2) w.bl(clip.length);
          for (const p of clip) { w.rd(p.x); w.rd(p.y); }
        }, (w) => {
          w.h(5, defH);                   /* imagedef (null for wipeouts) */
          w.h(3, 0);                      /* imagedef reactor */
        });
        return;
      }

      case 'spline': {
        /* R2013+ spells the scenario differently: the leading BL is
           ALWAYS 1, and the truth moves into the two flag longs — a fit
           spline is flags1 9 with chord knots (0), a control spline is
           flags1 0 with custom knots (15). That is what AutoCAD writes,
           uniformly, across every spline of the reference corpus, and
           AutoCAD 2027 FATALs during regen on the old scenario-2
           spelling that pre-2013 files carry (our reader accepts both,
           which is why no round trip ever saw it). */
        makeEntity(36, handle, e, ctx, (w) => {
          const hasCtrl = e.controlPoints.length >= 2;
          if (hasCtrl) {
            w.bl(1);                      /* scenario: full spline */
            if (V >= 2018) { w.bl(0); w.bl(15); }  /* flags1, custom knots */
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
            w.bl(V >= 2018 ? 1 : 2);      /* scenario: fit points */
            if (V >= 2018) { w.bl(9); w.bl(0); }   /* flags1 (fit), chord knots */
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
            w.h(ref.code, mapRef(ref.value));
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
            w.h(ref.code, mapRef(ref.value));
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
            sealBody(w, e, e.appClass?.cppName ?? 'AcDbEntity');
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
  /** A dictionary key: NUL-closed in the R14, 2000 and 2004 containers,
   *  as the reference's own files of those releases spell every one. */
  const dictKey = (name: string): string =>
    V >= 2000 && V < 2007 && name ? nameText(name) + '\0' : nameText(r14Str(name));

  /** @param xrefH the attachment an xref-dependent record belongs to —
   *  its block record's handle; 0 for the drawing's own records
   *  @param attachment the record is itself an external reference's block */
  const tableFlags = (w: BitWriter, name: string, xrefH = 0, attachment = false): void => {
    w.t(nameText(r14Name(name)));
    if (V <= 2004) {
      /* the "used" 64-flag: AutoCAD writes 1 on every record it mints
         (bit-walked in refR14.dwg and ref2000.dwg) */
      w.b(1);
      /* "xref resolved" (DXF 70 bit 32): the reference's own 2000 and
         2004 re-saves of A-01 carry 1 on both attachments' block records
         and on every record that belongs to one, 0 on the drawing's own */
      w.bs(xrefH || attachment ? 1 : 0);
      w.b(xrefH ? 1 : 0);                 /* xref dependent */
    } else {
      /* R2007+ folds the two into one short: 256 marks a dependent
         record; an attachment's own block record carries 0 */
      w.bs(xrefH ? 256 : 0);
    }
  };

  const makeLayer = (ly: Layer): void => {
    const h = layerH.get(ly.name)!;
    const xd = xdictByOwner.get(h)?.h ?? 0;
    makeObject(51, h, (w) => {
      tableFlags(w, ly.name, xrefH(ly.name));
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
      if (V < 2004 || xd) w.h(3, xd);     /* xdict */
      w.h(5, xrefH(ly.name));             /* xref block (from tableFlags) */
      if (V >= 2000) w.h(5, 0);           /* plotstyle — R2000 and later */
      if (V >= 2007) w.h(5, 0);           /* material */
      const lt = ly.linetype && ltypeH.get(ly.linetype);
      w.h(5, lt || ltContinuous);         /* linetype */
      if (V >= 2018) w.h(5, 0);           /* unknown trailing (R2013+) */
    }, xd);
  };

  const makeStyle = (st: TextStyle): void => {
    const h = styleH.get(st.name)!;
    const xd = xdictByOwner.get(h)?.h ?? 0;
    makeObject(53, h, (w) => {
      tableFlags(w, st.name, xrefH(st.name));
      w.b(st.shapeFile ? 1 : 0);          /* shape file (an .shx of shapes) */
      w.b(0);                             /* vertical */
      w.bd(st.fixedHeight ?? 0);
      w.bd(st.widthFactor ?? 1);
      w.bd(st.oblique ?? 0);
      w.rc(0);                            /* generation */
      w.bd(2.5);                          /* last height */
      w.t(outText(r14Str(st.font ?? 'txt')));
      w.t(outText(r14Str(st.bigFont ?? '')));
    }, (w) => {
      w.h(4, styleControl);
      if (V < 2004 || xd) w.h(3, xd);
      w.h(5, xrefH(st.name));             /* xref */
    }, xd);
  };

  const makeLtype = (name: string, h: number, lt?: Linetype): void => {
    /* AutoCAD's audit refuses a one-dash pattern ("Dash Count Less
       than 2 — Continuous"): a lone dash with no gap draws solid
       anyway, so it is written as the continuous form the audit would
       make of it. */
    const pattern = (lt?.pattern ?? []).length >= 2 ? lt!.pattern : [];
    const xd = xdictByOwner.get(h)?.h ?? 0;
    makeObject(57, h, (w) => {
      tableFlags(w, name, xrefH(name));
      w.t(outText(r14Str(lt?.description ?? '')));
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
      if (V < 2004 || xd) w.h(3, xd);
      w.h(5, xrefH(name));                /* xref */
      for (const d of pattern) { void d; w.h(5, 0); }  /* per-dash style */
    }, xd);
  };

  const makeAppid = (name: string, handle: number): void => {
    makeObject(67, handle, (w) => {
      tableFlags(w, name);
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
    const h = dimStyleH.get(ds.name.toLowerCase())!;
    const xd = xdictByOwner.get(h)?.h ?? 0;
    makeObject(69, h, (w) => {
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
      if (V < 2004 || xd) w.h(3, xd);   /* xdict */
      w.h(5, 0);                        /* xref block */
      w.h(5, txsty);                    /* DIMTXSTY */
      if (V >= 2000) {
        w.h(5, 0); w.h(5, 0); w.h(5, 0); w.h(5, 0);   /* DIMLDRBLK, DIMBLK/1/2 */
      }
      if (V >= 2007) { w.h(5, 0); w.h(5, 0); w.h(5, 0); }   /* DIMLTYPE, DIMLTEX1/2 */
    }, xd);
  };

  /** A named VIEW record — the VPORT's layout up to the paper-space
   *  flag (height, width, centre, target THEN direction, twist, lens,
   *  clips, the four mode bits, the R2000+ render mode, the R2007+
   *  lighting block), then the flag, the R2000+ associated UCS and the
   *  R2007+ camera flag; in the handle stream the xref slot, the R2007+
   *  background / visual style / sun, the UCS pair when the view keeps
   *  one, and the R2007+ live section. Named views are what a sheet
   *  set's view list and the reference's own VIEW command hold, their
   *  thumbnails in the record's extension dictionary. */
  const makeView = (vw: View, h: number): void => {
    const xd = xdictByOwner.get(h)?.h ?? 0;
    const hasUcs = V >= 2000 && !!(vw.ucsOrigin || vw.ucsXAxis || vw.ucsYAxis);
    makeObject(61, h, (w) => {
      tableFlags(w, vw.name);
      w.bd(vw.height); w.bd(vw.width);
      w.rd(vw.center.x); w.rd(vw.center.y);
      const t = vw.target ?? { x: 0, y: 0, z: 0 };
      w.bd3(t.x, t.y, t.z ?? 0);
      const d = vw.direction ?? { x: 0, y: 0, z: 1 };
      w.bd3(d.x, d.y, d.z ?? 0);
      w.bd(vw.twist ?? 0);
      w.bd(vw.lensLength ?? 50);
      w.bd(vw.frontClip ?? 0); w.bd(vw.backClip ?? 0);
      const vm = vw.viewMode ?? 0;
      w.b(vm & 1); w.b((vm >> 1) & 1); w.b((vm >> 2) & 1); w.b(1);
      if (V >= 2000) w.rc(vw.renderMode ?? 0);
      if (V >= 2007) {
        w.b(1);                           /* default lights */
        w.rc(1);                          /* default lighting type */
        w.bd(0); w.bd(0);                 /* brightness, contrast */
        w.bs(250); w.bl(0); w.rc(0);      /* ambient colour (CMC) */
      }
      w.b(vw.paperSpace ? 1 : 0);
      if (V >= 2000) {
        w.b(hasUcs ? 1 : 0);
        if (hasUcs) {
          const o = vw.ucsOrigin ?? { x: 0, y: 0, z: 0 };
          const ux = vw.ucsXAxis ?? { x: 1, y: 0, z: 0 };
          const uy = vw.ucsYAxis ?? { x: 0, y: 1, z: 0 };
          w.bd3(o.x, o.y, o.z ?? 0);
          w.bd3(ux.x, ux.y, ux.z ?? 0); w.bd3(uy.x, uy.y, uy.z ?? 0);
          w.bd(vw.ucsElevation ?? 0);
          w.bs(vw.ucsOrthoType ?? 0);
        }
      }
      if (V >= 2007) w.b(0);              /* camera plottable */
    }, (w) => {
      w.h(4, viewControl);
      if (V < 2004 || xd) w.h(3, xd);
      w.h(5, 0);                          /* xref */
      if (V >= 2007) { w.h(4, 0); w.h(5, 0); w.h(3, 0); }  /* bg, style, sun */
      if (hasUcs) { w.h(5, 0); w.h(5, 0); }   /* base / named UCS */
      if (V >= 2007) w.h(4, 0);           /* live section */
    }, xd);
  };

  /** A GROUP object: the description, the unnamed and selectable flags,
   *  the member count, then the members as hard pointers — the ones that
   *  are in this file. The name is its ACAD_GROUP key. */
  const makeGroup = (g: Group, h: number, members: number[]): void => {
    const xd = xdictByOwner.get(h)?.h ?? 0;
    makeObject(72, h, (w) => {
      w.t(outText(r14Str(g.description ?? '')));
      w.bs(/^\*/.test(g.name) ? 1 : 0);   /* unnamed */
      w.bs(g.selectable === false ? 0 : 1);
      w.bl(members.length);
    }, (w) => {
      w.h(4, groupDict);
      if (V < 2004 || xd) w.h(3, xd);
      for (const m of members) w.h(5, m);
    }, xd);
  };

  /** An MLINESTYLE object, owned by the ACAD_MLINESTYLE dictionary: the
   *  name, description, flags, fill colour, the two cap angles, then
   *  the elements — offset, colour, and the linetype as a table index
   *  through R2013 (32767 BYLAYER, 32766 BYBLOCK, else the record's
   *  position in the linetype table's list) or a handle per element
   *  from R2018 on (155 genuine AC1021/AC1024/AC1027 files carry the
   *  index in the data stream and nothing in the handle stream). The
   *  STANDARD values mirror the reference's own (refR14, ref2004,
   *  ref2018): no fill, 90° caps, ±0.5 ByLayer/BYLAYER. A colour takes
   *  the 2004+ CMC spelling where the container does. */
  const mlineLtypeIndex = (name?: string): number => {
    if (!name || /^bylayer$/i.test(name)) return 32767;
    if (/^byblock$/i.test(name)) return 32766;
    const i = userLtypes.findIndex((lt) => lt.name.toLowerCase() === name.toLowerCase());
    return i >= 0 ? i : 32767;
  };
  const mlineLtypeRef = (name?: string): number => {
    if (!name || /^bylayer$/i.test(name)) return ltBylayer;
    if (/^byblock$/i.test(name)) return ltByblock;
    return ltypeH.get(name) ?? ltBylayer;
  };
  const makeMlineStyle = (s: MLineStyle, h: number): void => {
    const xd = xdictByOwner.get(h)?.h ?? 0;
    const elements = s.elements.slice(0, 64);
    /* 2000 and 2004 close the name and a non-empty description with a
       NUL, as R14 does (the reference's own re-saves of a WALL style,
       bit-walked beside its STANDARD) */
    const cstr = (s: string): string => (V >= 2000 && V < 2007 && s ? s + '\0' : s);
    makeObject(73, h, (w) => {
      w.t(cstr(nameText(r14Name(s.name))));   /* real files spell STANDARD uppercase */
      w.t(cstr(nameText(r14Str(s.description ?? ''))));
      w.bs(s.flags ?? 0);
      objCmc(w, s.fillColor ?? { kind: 'byLayer' });   /* fill colour */
      w.bd(s.startAngle ?? Math.PI / 2); w.bd(s.endAngle ?? Math.PI / 2);
      w.rc(elements.length);
      for (const el of elements) {
        w.bd(el.offset);
        objCmc(w, el.color ?? { kind: 'byLayer' });
        if (V < 2018) w.bs(mlineLtypeIndex(el.linetype));
      }
    }, (w) => {
      w.h(4, mlineDict);                /* owner */
      if (V < 2004 || xd) w.h(3, xd);   /* xdict (2004+ says "missing") */
      if (V >= 2018) for (const el of elements) w.h(5, mlineLtypeRef(el.linetype));
    }, xd);
  };

  /** A named UCS record: name and flags, origin and the two axes, then
   *  from R2000 the elevation, the orthographic view type and the
   *  remembered origin per orthographic type; in the handle stream the
   *  xref slot, then (R2000+) the base UCS and an always-null second
   *  pointer — bit-walked on the reference's 2000/2004/2007/2018 saves
   *  of its Tower sample. */
  const makeUcs = (u: Ucs, h: number): void => {
    const xd = xdictByOwner.get(h)?.h ?? 0;
    makeObject(63, h, (w) => {
      tableFlags(w, u.name);
      w.bd3(u.origin.x, u.origin.y, u.origin.z ?? 0);
      w.bd3(u.xAxis.x, u.xAxis.y, u.xAxis.z ?? 0);
      w.bd3(u.yAxis.x, u.yAxis.y, u.yAxis.z ?? 0);
      if (V >= 2000) {
        w.bd(u.elevation ?? 0);
        w.bs(u.orthoViewType ?? 0);
        const origins = u.orthoOrigins ?? [];
        w.bs(origins.length);
        for (const o of origins) {
          w.bs(o.type);
          w.bd3(o.origin.x, o.origin.y, o.origin.z ?? 0);
        }
      }
    }, (w) => {
      w.h(4, ucsControl);
      if (V < 2004 || xd) w.h(3, xd);
      w.h(5, 0);                          /* xref */
      if (V >= 2000) {
        w.h(5, ucsRef(u.baseUcs));        /* base UCS (346) */
        w.h(5, 0);                        /* named UCS: always null */
      }
    }, xd);
  };

  /** A DICTIONARYVAR: the schema byte, the value as text — NUL-closed in
   *  the codepage containers, as the reference writes it (its 2000 and
   *  2004 saves spell "Standard" as nine characters) — and, in the
   *  handle stream, the variable dictionary twice: as the owner and as
   *  the record's one persistent reactor (bit-walked on the reference's
   *  2004, 2007 and 2018 saves of A-01, record LIGHTINGUNITS: data
   *  identical to ours, `4:dict 4:dict` where ours had `4:dict` — and
   *  without the reactor the R2007+ files read the defaults back, 2 for
   *  LIGHTINGUNITS where the record says 0). */
  const makeDictionaryVar = (v: DrawingVariable, h: number): void => {
    const xd = xdictByOwner.get(h)?.h ?? 0;
    makeObject(CLS_DICTVAR, h, (w) => {
      w.rc(v.schema ?? 0);
      w.t(V >= 2007 ? v.value : outText(v.value) + '\0');
    }, (w) => {
      w.h(4, varDictH);                   /* owner */
      w.h(4, varDictH);                   /* reactor */
      if (V < 2004 || xd) w.h(3, xd);
    }, xd, undefined, 1);
  };

  /** A colour inside an object record: the 2004 CMC layout — a zero
   *  index, the method dword (ByLayer C0, ByBlock C1, RGB C2, ACI C3),
   *  no names — where the container uses it, or where the record asks
   *  for it in every release (TABLESTYLE does); the bare index before. */
  const objCmc = (w: BitWriter, c: Color | undefined, force2004 = false): void => {
    const color = c ?? { kind: 'byBlock' as const };
    if (V >= 2004 || force2004) {
      w.bs(0);
      const dword = color.kind === 'byLayer' ? 0xC0000000
        : color.kind === 'byBlock' ? 0xC1000000
        : color.kind === 'rgb' ? (0xC2000000 | (color.rgb & 0xffffff))
        : (0xC3000000 | (color.index & 0xff));
      w.bl(dword >>> 0);
      w.rc(0);
      return;
    }
    w.bs(color.kind === 'byLayer' ? 256 : color.kind === 'byBlock' ? 0
      : color.kind === 'rgb' ? nearestAci(color.rgb) : color.index);
  };

  /** The text style a style record points at: the named one, else
   *  Standard, else the first in the table. */
  const textStyleRef = (name?: string): number =>
    styleH.get(name ?? '') ?? styleH.get('Standard') ?? [...styleH.values()][0] ?? 0;

  /** A TABLESTYLE. Before R2010 the record is the description, the
   *  table-level switches and the data, title and header cell styles in
   *  that order — text style (a handle), height, alignment, text and
   *  fill colour, the fill switch, six borders (lineweight, visibility,
   *  colour) and from R2007 the value's type and format — its colours in
   *  the 2004 CMC layout in every release and its 2000/2004 description
   *  NUL-terminated, as the reference writes them. From R2010 the record
   *  is the reference's cell-style map: a zero byte, the name, the flag
   *  word (the old group 71), the table's own cell style (id 101, class
   *  5, "Table", carrying the margins and a flow direction of "up" as
   *  override bit 0x10000), the constants 4 and 2, and the three named
   *  styles _TITLE, _HEADER and _DATA — each an id, the cell style, the
   *  id again, its class and its name. A border's trailing word counts
   *  invisibility there. Walked bit-exact against the reference's own
   *  2000, 2004, 2007, 2010, 2013 and 2018 saves of three drawings; the
   *  title/header suppression switches have no home in the R2010+
   *  record (the reference keeps them beside it). Values not given take
   *  the reference's defaults: 0.06 margins, 0.18/0.25/0.18 text
   *  heights, ByBlock text, no fill, six ByBlock visible borders. */
  const makeTableStyle = (s: TableStyle, handle: number): void => {
    const cellOf = (
      c: TableStyleCell | undefined, height: number, align: number
    ): TableStyleCell => ({
      textHeight: height, alignment: align, textColor: { kind: 'byBlock' },
      fillColor: { kind: 'aci', index: 7 }, fillOn: false,
      dataType: 512, unitType: 0, ...c
    });
    const data = cellOf(s.data, 0.18, 2);
    const title = cellOf(s.title, 0.25, 5);
    const header = cellOf(s.header, 0.18, 5);
    const border = (c: TableStyleCell, i: number): NonNullable<TableStyleCell['borders']>[number] =>
      c.borders?.[i] ?? {};
    const hm = s.horizontalMargin ?? 0.06, vm = s.verticalMargin ?? 0.06;
    const desc = s.description ?? s.name;
    /* the style's extension dictionary (the reference's 2008 cell-style
       map lives there), when the sealed one goes out under it */
    const xd = xdictByOwner.get(handle)?.h ?? 0;
    if (V < 2010) {
      makeObject(CLS_TABLESTYLE, handle, (w) => {
        w.t(nameText(desc) + (V < 2007 ? '\0' : ''));
        w.bs(s.flowDirection ?? 0);
        w.bs(s.flags ?? 0);
        w.bd(hm); w.bd(vm);
        w.b(s.titleSuppressed ? 1 : 0);
        w.b(s.headerSuppressed ? 1 : 0);
        for (const c of [data, title, header]) {
          w.bd(c.textHeight ?? 0.18);
          w.bs(c.alignment ?? 5);
          objCmc(w, c.textColor, true);
          objCmc(w, c.fillColor ?? { kind: 'aci', index: 7 }, true);
          w.b(c.fillOn ? 1 : 0);
          for (let i = 0; i < 6; i++) {
            const b = border(c, i);
            w.bs(b.lineweight ?? -2);
            w.b(b.visible === false ? 0 : 1);
            objCmc(w, b.color, true);
          }
          if (V >= 2007) {
            w.bl(c.dataType ?? 512); w.bl(c.unitType ?? 0);
            w.t(nameText(c.format ?? ''));
          }
        }
      }, (w) => {
        w.h(4, tableDictH);             /* owner */
        if (V < 2004 || xd) w.h(3, xd); /* xdict */
        for (const c of [data, title, header]) w.h(5, textStyleRef(c.textStyle));
      }, xd, s.xdata);
      return;
    }
    const margins = [vm, hm, vm, hm, 0.18, 0.18];
    const cell2010 = (
      w: BitWriter, c: TableStyleCell, entry: boolean, mergeAll: boolean, overrides: number
    ): void => {
      w.bl(entry ? 5 : 1);              /* style type */
      w.bs(entry ? 1 : 0);              /* merge flags follow */
      w.bl(overrides);                  /* property overrides */
      if (entry) w.bl(mergeAll ? 32768 : 0);
      if (c.fillOn && c.fillColor) objCmc(w, c.fillColor);
      else { w.bs(0); w.bl(0xC8000000); w.rc(0); }   /* background: none */
      w.bl(1);                          /* content layout */
      w.bl(0); w.bl(0);                 /* format override, property flags */
      w.bl(c.dataType ?? 512); w.bl(c.unitType ?? 0);
      w.t(c.format ?? '');
      w.bd(0); w.bd(1);                 /* rotation, block scale */
      w.bl(c.alignment ?? 5);
      objCmc(w, c.textColor);
      w.bd(c.textHeight ?? 0.18);
      w.bs(1);                          /* margins follow */
      for (const m of margins) w.bd(m);
      if (!entry) { w.bl(0); return; }  /* no borders on the table style */
      w.bl(6);
      for (let i = 0; i < 6; i++) {
        const b = border(c, i);
        w.bl(1 << i); w.bl(0); w.bl(1); /* edge mask, overrides, type */
        objCmc(w, b.color);
        w.bl(b.lineweight ?? -2);
        w.bl(b.visible === false ? 1 : 0);   /* invisibility */
        w.bd(0.045);                    /* double-line spacing */
      }
    };
    const entries: [number, TableStyleCell, number, string][] = [
      [1, title, 1, '_TITLE'], [2, header, 1, '_HEADER'], [3, data, 2, '_DATA']
    ];
    makeObject(CLS_TABLESTYLE, handle, (w) => {
      w.rc(0);
      w.t(desc);
      w.bl(s.flags ?? 0);
      w.bl(101); w.bl(5);               /* the table's own cell style */
      cell2010(w, { textHeight: 0.18, alignment: 1, textColor: { kind: 'byBlock' } },
        false, false, s.flowDirection ? 0x10000 : 0);
      w.t('Table');
      w.bl(4); w.bl(2);                 /* constants */
      w.bl(entries.length);
      for (const [id, c, cls, name] of entries) {
        w.bl(id);
        cell2010(w, c, true, id === 1, 0);
        w.bl(id); w.bl(cls); w.t(name);
      }
    }, (w) => {
      w.h(4, tableDictH);               /* owner */
      if (xd) w.h(3, xd);               /* xdict */
      w.h(3, 0);                        /* unknown hard owner */
      w.h(5, 0);                        /* the table cell style's text style */
      for (const [, c] of entries) {
        w.h(5, textStyleRef(c.textStyle));
        for (let i = 0; i < 6; i++) w.h(5, 0);   /* border linetypes */
      }
    }, xd, s.xdata);
  };

  /** An MLEADERSTYLE — the record every MULTILEADER's style handle must
   *  resolve to (AutoCAD 2027 audits a null style: "found 1 fixed 1" on
   *  an otherwise clean singleton). Field-walked bit-for-bit against the
   *  Standard style in an AutoCAD 2027 save (famD_2018.dwg: the walk
   *  consumes its data stream to the exact bit) and against the
   *  reference's 2000 … 2018 saves of its multileader sample. Values not
   *  given take AutoCAD's own defaults: mtext content, two-point
   *  straight leaders, ByBlock colours and linetype, 0.09 landing gap,
   *  0.36 dogleg, 0.18 arrowhead/text height, 0.125 break size. The
   *  ACAD_MLEADERVER stamp (1070 = 2) rides as EED in every release. */
  const makeMLeaderStyle = (s: MLeaderStyle, handle: number): void => {
    const MLVER = 'ACAD_MLEADERVER';
    const xdata = s.xdata?.some((g) => g.appName === MLVER) ? s.xdata
      : [...(s.xdata ?? []), { appName: MLVER, values: [{ code: 1070, value: 2 }] }];
    const xd = xdictByOwner.get(handle)?.h ?? 0;
    makeObject(CLS_MLEADERSTYLE, handle, (w) => {
      if (V >= 2010) w.bs(2);           /* class version */
      w.bs(s.contentType ?? 2);         /* content type: mtext */
      w.bs(s.drawMLeaderOrder ?? 1);    /* draw-mleader order */
      w.bs(s.drawLeaderOrder ?? 0);     /* draw-leader order */
      w.bl(s.maxLeaderPoints ?? 2);     /* max leader points */
      w.bd(s.firstSegmentAngle ?? 0); w.bd(s.secondSegmentAngle ?? 0);
      w.bs(s.leaderType ?? 1);          /* leader type: straight */
      objCmc(w, s.lineColor);           /* line colour */
      w.bl(s.lineweight ?? -2);         /* lineweight: ByBlock */
      w.b(s.landing === false ? 0 : 1); /* landing enabled */
      w.bd(s.landingGap ?? 0.09);       /* landing gap */
      w.b(s.dogleg === false ? 0 : 1);  /* dogleg enabled */
      w.bd(s.doglegLength ?? 0.36);     /* dogleg length */
      w.t(nameText(s.description ?? s.name));   /* description */
      w.bd(s.arrowSize ?? 0.18);        /* arrowhead size */
      w.t(nameText(s.defaultText ?? ''));       /* default mtext contents */
      w.bs(s.textLeftAttachment ?? 1); w.bs(s.textRightAttachment ?? 1);
      w.bs(s.textAngleType ?? 1);       /* text angle type */
      w.bs(s.textAlignment ?? 0);       /* text alignment type */
      objCmc(w, s.textColor);           /* text colour */
      w.bd(s.textHeight ?? 0.18);       /* text height */
      w.b(s.textFrame ? 1 : 0);         /* text frame */
      w.b(s.alwaysAlignLeft ? 1 : 0);   /* text always left */
      w.bd(s.alignSpace ?? 0.18);       /* align space */
      objCmc(w, s.blockColor);          /* block colour */
      const bs = s.blockScale ?? { x: 1, y: 1, z: 1 };
      w.bd(bs.x); w.bd(bs.y); w.bd(bs.z ?? 1);   /* block scale */
      w.b(s.useBlockScale === false ? 0 : 1);
      w.bd(s.blockRotation ?? 0);       /* block rotation */
      w.b(s.useBlockRotation === false ? 0 : 1);
      w.bs(s.blockConnection ?? 0);     /* block connection */
      w.bd(s.scale ?? 1);               /* overall scale */
      w.b(s.propertyChanged ? 1 : 0);
      w.b(s.annotative ? 1 : 0);
      w.bd(s.breakSize ?? 0.125);       /* break size */
      if (V >= 2010) {                  /* attach dir / bottom / top */
        w.bs(s.attachmentDirection ?? 0);
        w.bs(s.bottomAttachment ?? 9); w.bs(s.topAttachment ?? 9);
      }
      if (V >= 2013) w.b(0);            /* extended text */
    }, (w) => {
      w.h(4, mleaderDictH);             /* owner */
      if (V < 2004 || xd) w.h(3, xd);   /* xdict */
      w.h(5, (s.linetype && ltypeH.get(s.linetype)) || ltByblock);
      w.h(5, (s.arrowBlock && blockH.get(s.arrowBlock)) || 0);   /* arrowhead */
      w.h(5, textStyleRef(s.textStyle));
      w.h(5, (s.blockName && blockH.get(s.blockName)) || 0);     /* block content */
    }, xd, xdata);
  };

  /** The stored name of an anonymous block. The file keeps the bare
   *  stem ("*X", "*D", "*U") and AutoCAD assigns the display numbers at
   *  load — the reader numbers them back the same way. Writing the
   *  numbered display name is what audit flags, once per block, as
   *  `Name Invalid anonymous name "*X"` (396 times in the field
   *  corpus). References are by handle, so the stem loses nothing. */
  const storedBlockName = (name: string): string =>
    /^\*[A-Za-z]\d+$/.test(name) ? name.slice(0, 2)
    /* every paper-space layout's header is spelled *Paper_Space in the
       file — the reference's own sheet sets carry four of them under
       that one name, and the reader numbers them back on load */
    : /^\*paper_space.+$/i.test(name) ? '*PAPER_SPACE' : name;
  const makeBlockHeader = (
    h: number, name: string, blockEnt: number, endblkEnt: number,
    ownedEnts: number[], base = { x: 0, y: 0, z: 0 }, layoutHandle = 0,
    xdictH = 0, hasAttdefs = false,
    xref?: { path: string; overlay?: boolean }, inserts: number[] = []
  ): void => {
    /* An external reference's record, as the reference's own 2000, 2004
       and 2018 re-saves of A-01 spell it (bit-walked): the xref and
       overlay bits, loaded 0, NO owned-object count, the stored path,
       one 0x01 per INSERT in the count run, and in the handle stream
       no entity handles at all — the BLOCK and ENDBLK entities, then
       one soft pointer per INSERT before the layout. The count is what
       kept every earlier attempt out: an R2004+ record that carries it
       (even a 0) is refused outright (ErrorStatus 53 — the BL's two
       bits shift the base point and everything after it). Loaded must
       be 0 as well: written 1, the reference takes the attachment as
       already loaded and never resolves it (BLOCK 70=4 instead of 36,
       measured). R13/R14 spell it the same way short of the R2000
       additions — the reference's own R14 save of A-01 (bit-walked,
       "WALL" 270CF): used 1, xrefindex+1 = 1, xrefdep 0, xref 1,
       overlaid 0/1, base point, the path as a NUL-closed T, and in the
       handle stream block begin then endblk, no first/last entity and
       no insert list. */
    const attached = !!xref;
    makeObject(49, h, (w) => {
      tableFlags(w, storedBlockName(name), 0, attached);
      /* the two space blocks start with '*' but are NOT anonymous —
         AutoCAD's audit flags them when marked so */
      w.b(name.startsWith('*')
        && !/^\*(model_space|paper_space)/i.test(name) ? 1 : 0);
      w.b(hasAttdefs ? 1 : 0);            /* has attdefs */
      w.b(attached ? 1 : 0);              /* xref */
      w.b(attached && xref!.overlay ? 1 : 0);   /* overlaid */
      if (V >= 2000) w.b(0);              /* loaded (R2000+) */
      if (V >= 2004 && !attached) w.bl(ownedEnts.length);
      w.bd3(base.x, base.y, base.z ?? 0);
      w.t(attached ? nameText(r14Str(xref!.path)) : '');   /* xref path */
      if (V >= 2000) {
        /* R2000 additions — a real R14 BLOCK_HEADER ends at the xref
           path (decode-gap 0 against AutoCAD-minted R14) */
        if (attached) for (const ih of inserts) { void ih; w.rc(1); }
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
      if (V < 2004 || xdictH) w.h(3, xdictH);   /* xdict */
      w.h(5, 0);                          /* xref */
      w.h(3, blockEnt);                   /* block begin entity */
      if (attached) {
        /* an attachment owns no entities: no chain, no owned list */
      } else if (V < 2004) {
        w.h(4, ownedEnts[0] ?? 0);        /* first entity in chain */
        w.h(4, ownedEnts[ownedEnts.length - 1] ?? 0);
      } else {
        for (const eh of ownedEnts) w.h(4, eh);
      }
      w.h(3, endblkEnt);                  /* endblk */
      if (V >= 2000) {
        if (attached) for (const ih of inserts) w.h(4, ih);
        w.h(5, layoutHandle);             /* layout (R2000+) */
      }
    }, xdictH);
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
      w.t(nameText(r14Name(storedBlockName(name))));
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

  /** Control object: BL count, then INLINE handles (R2000 layout). Its
   *  extension dictionary, when the sealed one goes out under it (the
   *  layer table's ACAD_LAYERSTATES / ACAD_LAYERFILTERS chain). */
  const makeControl = (
    type: number, handle: number, entries: number[],
    tail?: (w: BitWriter) => void
  ): void => {
    const xd = xdictByOwner.get(handle)?.h ?? 0;
    const w = new BitWriter();
    let sizePos = objectPrologue(w, type);
    const sw = withStrings(w);
    w.h(0, handle);
    w.bs(0);                              /* EED */
    if (V <= 14) { sizePos = w.pos; w.rl(0); }  /* handle-stream position */
    w.bl(0);                              /* reactors */
    if (V >= 2004) w.b(xd ? 0 : 1);       /* xdict missing */
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
    if (V < 2004 || xd) w.h(3, xd);       /* xdict */
    for (const h of entries) w.h(2, h);
    tail?.(w);
    finishObject(w, handle, bitsize);
  };

  /* Note: our reader reads BlockTable as: BL num (data), then handles
     inline: owner, reactors, xdict, entries, model, paper. The generic
     makeControl matches that shape (num in data stream, rest as handles). */

  /** @param hardOwner the dictionary owns its entries hard (DXF 280 = 1):
   *  what the reference gives an entity's extension dictionary. The keys
   *  are NUL-closed in the 2000 and 2004 containers as in R14 — every
   *  dictionary of the reference's own 2000/2004 saves spells them so
   *  (its root, its variable dictionary, its MTEXT round-trip ones). */
  const makeDictionary = (
    handle: number, owner: number, items: [string, number][], hardOwner = false
  ): void => {
    /* the dictionary's own extension dictionary, when the source's sealed
       one goes out under it (the root's, a sub-dictionary's) */
    const xd = xdictByOwner.get(handle)?.h ?? 0;
    makeObject(42, handle, (w) => {
      w.bl(items.length);
      if (V >= 2000) w.bs(1);             /* cloning (R2000+ only) */
      if (V >= 14) w.rc(hardOwner ? 1 : 0);   /* hard owner (R13c3 and later) */
      for (const [name] of items) w.t(dictKey(name));
    }, (w) => {
      w.h(4, owner);
      if (V < 2004 || xd) w.h(3, xd);
      for (const [, h] of items) w.h(hardOwner ? 3 : 2, h);
    }, xd);
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
    /* the record points at its extension dictionary: only when that
       dictionary goes out under this entity is the pointer still true */
    if (e.xdict && !xdictByOwner.has(handle)) return undefined;
    /* an extension dictionary this writer builds (an MTEXT's round-trip
       records) is not in the retained bytes */
    if (synthXdict.has(handle)) return undefined;
    /* likewise its reactor list: a watcher that is not in this file
       would be a dangling reactor in the retained bytes */
    if (e.reactors?.some((r) => outOf(r) === undefined)) return undefined;
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
  makeControl(60, viewControl, viewH);
  makeControl(62, ucsControl, ucsH);
  makeControl(64, vportControl, [vportActive]);
  makeControl(66, appidControl, [appidAcad, ...extraAppids.map((a) => a.handle)]);
  makeControl(68, dimstyleControl,
    dimStyles.map((ds) => dimStyleH.get(ds.name.toLowerCase())!));
  /* the VX table died with R2000; AutoCAD's own later files omit it */
  if (V <= 2000) makeControl(70, vxControl, []);

  makeDictionary(nod, 0, ([
    ...(V >= 2000 ? [['ACAD_LAYOUT', layoutDict] as [string, number]] : []),
    ['ACAD_GROUP', groupDict],
    ['ACAD_MLINESTYLE', mlineDict],
    ...(usesTableStyles
      ? [['ACAD_TABLESTYLE', tableDictH] as [string, number]] : []),
    ...(usesMLeaderStyles
      ? [['ACAD_MLEADERSTYLE', mleaderDictH] as [string, number]] : []),
    /* the variable dictionary, spelled as the reference's own files
       spell the key */
    ...(usesVariables
      ? [['ACDBVARIABLEDICTIONARY', varDictH] as [string, number]] : []),
    ...(recomposeH
      ? [['ACDB_RECOMPOSE_DATA', recomposeH] as [string, number]] : []),
    ...(geoData ? [['ACAD_GEOGRAPHICDATA', geoDataH] as [string, number]] : []),
    /* proxy and sealed objects whose owner is not in this file are
       re-homed here under their dictionary names; an unnamed one (its
       owner was not a dictionary in the source) still needs a key. The
       ones whose owner IS written go out under it, and are not listed. */
    ...proxyObjs.flatMap((p, i): [string, number][] =>
      !underNod(p) ? []
        : [[p.name ?? `PROXY_OBJECT_${i + 1}`, proxyObjH[i]]]),
    ...unknownObjs.flatMap((p, i): [string, number][] =>
      !underNod(p) ? []
        : [[p.name ?? `SEALED_OBJECT_${i + 1}`, unknownObjH[i]]])
  ] as [string, number][]).reduce<[string, number][]>((out, [name, h]) => {
    /* one key per entry: sealed objects that shared a name in their
       source (27 annotation contexts all called *A1, say) would put the
       same key into the dictionary 27 times over, and the reference
       refuses a dictionary with a repeated key */
    let key = name;
    for (let n = 2; out.some(([k]) => k === key); n++) key = `${name}~${n}`;
    out.push([key, h]);
    return out;
  }, []));
  /* the groups: one key each (a second of the same name is numbered),
     the members that are in this file */
  {
    const keys = new Set<string>();
    const items: [string, number][] = groupsOut.map((g, i) => {
      let key = g.name || '*A';
      for (let n = 2; keys.has(key.toLowerCase()); n++) key = `${g.name || '*A'}${n}`;
      keys.add(key.toLowerCase());
      return [key, groupH[i]];
    });
    makeDictionary(groupDict, nod, items);
    groupsOut.forEach((g, i) => {
      const members = g.entityHandles
        .map((eh) => outOf(eh))
        .filter((m): m is number => m !== undefined);
      makeGroup(g, groupH[i], members);
    });
  }
  views.forEach((vw, i) => makeView(vw, viewH[i]));
  ucsOut.forEach((u, i) => makeUcs(u, ucsH[i]));
  if (recomposeH) {
    /* the XRECORD's data is a byte-counted run of (RS group, value):
       RL for 90, an absolute 64-bit handle for 330 — walked bit-exact
       off the reference's own R14 and R2000 saves */
    const parents = [...new Set([...columnParents, ...mtextRt.keys()]
      .map((e) => entH.get(e))
      .filter((h): h is number => h !== undefined))]
      .sort((a, b) => a - b);             /* ascending, as the reference lists them */
    makeObject(xrecordType(), recomposeH, (w) => {
      w.bl(6 + 10 * parents.length);
      w.rs(90); w.rl(1);
      for (const h of parents) { w.rs(330); w.rll(h); }
      if (V >= 2000) w.bs(1);             /* cloning flag (R2000+) */
    }, (w) => {
      w.h(4, nod);
      if (V < 2004) w.h(3, 0);            /* xdict */
    });
  }
  /* the dictionary names every style, STANDARD among them, in every release */
  makeDictionary(mlineDict, nod,
    mlineStylesOut.map((s) => [s.name, mlineStyleH.get(s.name.toLowerCase())!]));
  /* the variable dictionary and its DICTIONARYVARs (R2000+) */
  if (usesVariables) {
    makeDictionary(varDictH, nod, variablesOut.map((v, i) => [v.name, varH[i]]));
    variablesOut.forEach((v, i) => makeDictionaryVar(v, varH[i]));
  }
  /* the MTEXT round-trip records: a fresh extension dictionary per
     entity that had none travelling, then the XRECORDs (typed runs:
     the sum as a real, the text in pieces, the R2000+ cloning flag) */
  for (const [e, rt] of mtextRt) {
    const owner = entH.get(e)!;
    /* a hard-owner dictionary, as the reference gives an entity's */
    if (rt.fresh) makeDictionary(rt.dict, owner, rt.entries.map(([n, h]) => [n, h]), true);
    for (const [, h, values] of rt.entries) {
      /* the dictionary owns the record and watches it — its one
         persistent reactor, as the reference's own records carry it */
      makeObject(xrecordType(), h, (w) => {
        xrecordBody(w, values);
        if (V >= 2000) w.bs(1);           /* cloning flag */
      }, (w) => {
        w.h(4, rt.dict);                  /* owner */
        w.h(4, rt.dict);                  /* reactor */
        if (V < 2004) w.h(3, 0);          /* xdict */
      }, 0, undefined, 1);
    }
  }
  /* the table and multileader styles, each listed by name under its
     dictionary — the drawing's own, plus a Standard when it has none */
  if (usesTableStyles) {
    makeDictionary(tableDictH, nod,
      tableStylesOut.map((s) => [s.name, tableStyleFor(s.name)]));
    for (const s of tableStylesOut) makeTableStyle(s, tableStyleFor(s.name));
  }
  if (usesMLeaderStyles) {
    makeDictionary(mleaderDictH, nod,
      mleaderStylesOut.map((s) => [s.name, mleaderStyleFor(s.name)]));
    for (const s of mleaderStylesOut) makeMLeaderStyle(s, mleaderStyleFor(s.name));
  }

  /* ---- layouts (R2000+): the objects behind the drawing tabs.
     AutoCAD's open path walks Model and at least one paper layout via
     the ACAD_LAYOUT dictionary; without them the drawing is refused. ---- */
  /** LAYOUT object handle per extra paper-space block, for its header. */
  const layoutOfBlock = new Map<string, number>();
  if (V >= 2000) {
    const metas = layoutMetas;
    const paperName = paperMeta?.name ?? 'Layout1';
    /* the other layouts, one per *Paper_Space<n> block: named by the
       LAYOUT record that points at the block, else Layout<n>; every
       tab name is unique in the dictionary */
    const usedNames = new Set(['model', paperName.toLowerCase()]);
    const extras = extraLayouts.map(({ nm, meta, h }, i) => {
      const stem = meta?.name ?? 'Layout';
      let name = meta?.name ?? stem + (i + 2);
      for (let k = 2; usedNames.has(name.toLowerCase()); k++) name = stem + k;
      usedNames.add(name.toLowerCase());
      layoutOfBlock.set(nm, h);
      return { nm, h, name, meta, tabOrder: meta?.tabOrder ?? i + 2 };
    });
    makeDictionary(layoutDict, nod, [
      ['Model', layoutModelH], [paperName, layoutPaperH],
      ...extras.map((x): [string, number] => [x.name, x.h])
    ]);
    const makeLayout = (
      handle: number, name: string, tabOrder: number, blockHdr: number,
      meta: typeof metas[number] | undefined
    ): void => {
      const xd = xdictByOwner.get(handle)?.h ?? 0;
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
        if (V < 2004 || xd) w.h(3, xd);   /* xdict */
        if (V >= 2004) w.h(4, 0);         /* plot view */
        if (V >= 2007) w.h(4, 0);         /* shade plot */
        w.h(4, blockHdr);                 /* the space it lays out */
        w.h(4, 0);                        /* active viewport */
        w.h(5, 0); w.h(5, 0);             /* base / named UCS */
      }, xd);
    };
    makeLayout(layoutModelH, 'Model', modelMeta?.tabOrder ?? 0, msBH, modelMeta);
    makeLayout(layoutPaperH, paperName, paperMeta?.tabOrder ?? 1, psBH, paperMeta);
    for (const x of extras) makeLayout(x.h, x.name, x.tabOrder, blockH.get(x.nm)!, x.meta);
  }

  /* ---- the active model viewport: every AutoCAD drawing has one ---- */
  {
    /* The saved view goes out as the drawing carries it — the twist above
       all, since a drawing laid out at an angle is drawn turned without
       it. A drawing with no view of its own gets the defaults that were
       here before. */
    const av = activeVport;
    const xd = xdictByOwner.get(vportActive)?.h ?? 0;
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
      if (V < 2004 || xd) w.h(3, xd);     /* xdict */
      w.h(5, 0);                          /* xref */
      if (V >= 2007) { w.h(4, 0); w.h(5, 0); w.h(3, 0); }  /* bg, style, sun */
      if (V >= 2000) { w.h(5, 0); w.h(5, 0); }  /* named / base UCS */
    }, xd);
  }

  /* ---- dictionary-owned proxy objects: passthrough, same discipline as
     the entity form — retained prologue, payload bits, reference codes ---- */
  proxyObjs.forEach((p, i) => {
    const key = p.appClass?.dxfName ?? p.sourceType ?? 'ACAD_PROXY_OBJECT';
    const cls = proxyClsH.get(key);
    const refs = (w: BitWriter): void => {
      w.h(4, ownerOut(p) ?? nod);         /* its owner, else the root dictionary */
      if (V < 2004) w.h(3, 0);
      for (const ref of p.refs ?? []) {
        w.h(ref.code, mapRef(ref.value));
      }
    };
    /* A proxy with no payload at all — an application that keeps its
       whole object in EED, as the reference's dbConnect link records do
       — goes out as a plain object of its class: an empty body under
       the class's own type number, the EED in the prologue. That is
       the form the reference's own DWG gives such records and the one
       its loader takes back; wrapped in a proxy record, the same object
       makes it refuse the drawing outright (ErrorStatus 53, measured on
       its dbConnect sample, EED or no EED). */
    if (!p.data && cls) {
      makeObject(cls.num, proxyObjH[i], () => { /* the object is its EED */ },
        refs, 0, p.xdata);
      return;
    }
    makeObject(0x1f3, proxyObjH[i], (w) => {
      w.bl(cls?.num ?? 0x1f3);
      w.bl(p.proxyVersion ?? 0);
      if (V >= 2018) w.bl(p.proxyMaint ?? 0);
      if (V >= 2000) w.b(p.fromDxf ? 1 : 0);
      if (p.data && p.dataBits) w.putBits(fromBase64(p.data), p.dataBits);
    }, refs, 0, p.xdata);
  });

  /* ---- sealed unknown objects: universal passthrough, object side.
     Same generation → the record goes out native (original fixed type or
     re-emitted class); foreign generation → wrapped in a proxy object
     tagged with its encoding, unwrapped when the generations match. ---- */
  unknownObjs.forEach((p, i) => {
    const key = p.appClass?.dxfName ?? p.sourceType;
    const h = unknownObjH[i];
    /* the common prologue of the handle stream: the owner (its own when
       that is written, else the root dictionary), the reactors that are
       in this file, the extension dictionary when the sealed one goes
       out under this record */
    const owner = ownerOut(p) ?? nod;
    const reactors = (p.reactors ?? [])
      .map((r) => outOf(r))
      .filter((r): r is number => r !== undefined);
    const xd = xdictByOwner.get(h)?.h ?? 0;
    const prologue = (w: BitWriter): void => {
      w.h(4, owner);
      for (const r of reactors) w.h(4, r);
      if (V < 2004 || xd) w.h(3, xd);
    };
    if (isDict(p)) {
      /* A dictionary — an extension dictionary, one of the named-objects
         tree, the plot style name dictionary with its default —
         re-encoded from its entries in the spelling of makeDictionary:
         the entries whose targets are in this file (and, in a tree
         dictionary, native — see `listable`), each under the code the
         source gave it, and after them this writer's own (a draw-order
         table, a rebuilt graph), which replace a stale entry of the same
         key. The cloning code and the hard-owner flag are the record's
         own. */
      const fresh = extraDictEntries.get(h) ?? [];
      const freshKeys = new Set(fresh.map(([n]) => n.toUpperCase()));
      const ownCode = p.hardOwner ? 3 : 2;
      const items: [string, number, number][] = [];
      for (const en of p.entries ?? []) {
        if (freshKeys.has(en.name.toUpperCase())) continue;
        if (!listable(p, en)) continue;
        const t = outOf(en.handle);
        if (t === undefined) continue;
        const code = en.code !== undefined && en.code >= 2 && en.code <= 5 ? en.code : ownCode;
        items.push([en.name, t, code]);
      }
      for (const [n, t] of fresh) items.push([n, t, ownCode]);
      const wdflt = isWdflt(p);
      const type = wdflt
        ? clsFor('ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', 'ObjectDBX Classes', false)
        : 42;
      makeObject(type, h, (w) => {
        w.bl(items.length);
        if (V >= 2000) w.bs(p.cloning ?? 1);
        if (V >= 14) w.rc(p.hardOwner ? 1 : 0);
        for (const [n] of items) w.t(dictKey(n));
      }, (w) => {
        prologue(w);
        for (const [, t, code] of items) w.h(code, t);
        /* the default record closes the handle stream */
        if (wdflt) w.h(5, outOf(p.defaultHandle) ?? 0);
      }, xd, p.xdata, reactors.length);
      return;
    }
    const refs = (w: BitWriter): void => {
      prologue(w);
      for (const ref of p.refs ?? []) {
        w.h(ref.code, mapRef(ref.value));
      }
    };
    /* the placeholder: an empty body under its fixed type in every
       release, the plot style name dictionary's default */
    if (kindOf(p) === 'ACDBPLACEHOLDER') {
      makeObject(80, h, () => { /* no data */ }, refs, xd, p.xdata, reactors.length);
      return;
    }
    /* an XRECORD of another generation, re-encoded from its typed values
       in this file's spelling (the bits of its own generation go out
       whole, below): the byte-counted run of (group, value), then the
       R2000+ cloning flag */
    const typed = p.encoding !== encodingGroup(V) ? typedXrecord(p) : undefined;
    if (typed) {
      makeObject(xrecordType(), h, (w) => {
        xrecordBody(w, typed);
        if (V >= 2000) w.bs(1);
      }, refs, xd, p.xdata, reactors.length);
      return;
    }
    if (p.encoding === encodingGroup(V) || p.data === undefined) {
      makeObject(isXrecord(p) && V <= 14 ? xrecordType()
        : p.typeCode ?? proxyClsH.get(key)?.num ?? 0x1f3,
        h, (w) => {
          if (p.data && p.dataBits) w.putBits(fromBase64(p.data), p.dataBits);
          if (p.strData && p.strBits) {
            w.strTarget?.putBits(fromBase64(p.strData), p.strBits);
          }
        }, refs, xd, p.xdata, reactors.length);
    } else {
      makeObject(0x1f3, h, (w) => {
        w.bl(p.typeCode === undefined ? (proxyClsH.get(key)?.num ?? 0) : 0);
        w.bl((SEAL_MAGIC | (p.encoding ?? 0)) >>> 0);
        if (V >= 2018) w.bl(0);
        if (V >= 2000) w.b(0);
        sealBody(w, p, p.appClass?.cppName ?? 'AcDbObject');
      }, refs, xd, p.xdata, reactors.length);
    }
  });

  for (const ly of layers) makeLayer(ly);
  for (const st of styles) makeStyle(st);
  makeLtype('ByLayer', ltBylayer);
  makeLtype('ByBlock', ltByblock);
  for (const lt of userLtypes) makeLtype(lt.name, ltypeH.get(lt.name)!, lt);
  makeAppid('ACAD', appidAcad);
  for (const a of extraAppids) makeAppid(a.name, a.handle);
  for (const ds of dimStyles) makeDimStyle(ds);
  for (const s of mlineStylesOut) makeMlineStyle(s, mlineStyleH.get(s.name.toLowerCase())!);

  makeBlockHeader(msBH, '*MODEL_SPACE', msBlockEnt, msEndblk, msEntH,
    undefined, V >= 2000 ? layoutModelH : 0,
    sortentsFor.get(msBH)?.dict ?? xdictByOwner.get(msBH)?.h);
  makeBlockHeader(psBH, '*PAPER_SPACE', psBlockEnt, psEndblk, psEntH,
    undefined, V >= 2000 ? layoutPaperH : 0,
    sortentsFor.get(psBH)?.dict ?? xdictByOwner.get(psBH)?.h);
  for (const nm of userBlocks) {
    const bh = blockH.get(nm)!;
    makeBlockHeader(bh, nm,
      blockBeginH.get(nm)!, blockEndH.get(nm)!,
      blockEntH.get(nm)!,
      drawing.blocks[nm].basePoint, layoutOfBlock.get(nm) ?? 0,
      sortentsFor.get(bh)?.dict ?? dynFor.get(bh)?.dict ?? xdictByOwner.get(bh)?.h,
      blockEnts.get(nm)!.some(
        (e) => e.type === 'text' && e.attribute === 'attdef'),
      isXrefBlock(nm) ? drawing.blocks[nm].xref : undefined,
      isXrefBlock(nm) ? insertsOf(nm) : []);
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

  /* ---- dynamic blocks: the visibility graph, spelled the way the
     reference spells it — measured on its own re-save of a
     visibility-only block, identical in every release from R2000 to
     R2018. A lone BLOCKVISIBILITYPARAMETER owned by the block header,
     without this graph, is refused outright (ErrorStatus 53) in every
     release, genuine and synthetic blocks alike. The chain: the block
     header's extension dictionary names the ACAD_EVALUATION_GRAPH under
     ACAD_ENHANCEDBLOCK; the graph hard-owns four nodes — the parameter,
     its grip and the grip's two location components — wired by three
     edges (grip -> parameter, parameter -> each component); a purge
     preventer beside the graph keeps an unreferenced dynamic block from
     being purged. The parameter mirrors the reader field for field
     (AcDbEvalExpr prologue, element block, member list, states). Member
     and per-state references name the block's entities: the model
     carries them as the source file's handles, so they are remapped
     here through each entity's retained `handle`. The reader binds the
     record to its block through the members' owner. ---- */
  /* a block whose dynamic behaviour is parameters and actions alone —
     no visibility states, so no graph is built for it — is written as a
     plain static block in every release, and says so the same way */
  for (const nm of userBlocks) {
    if (dynBlocks.includes(nm)) continue;
    /* the reference's own graph travels whole under the block (sealed,
       preserveHandles): nothing about it is static */
    if (genuineGraphTravels(nm)) continue;
    const def = drawing.blocks[nm];
    const nParams = def.parameters?.length ?? 0;
    const nActions = def.actions?.length ?? 0;
    if (nParams || nActions) {
      downgraded.push(`dynamic block ${nm}: `
        + `${nParams} parameter(s) and ${nActions} action(s) written static`);
    }
  }
  for (const nm of dynBlocks) {
    const def = drawing.blocks[nm];
    if (V <= 14) {
      skipped.push(`dynamic-block visibility of ${nm} (needs R2000 or later)`);
      continue;
    }
    const bh = blockH.get(nm)!;
    const rec = dynFor.get(bh)!;
    /* the block's other parameters and its actions have no writer yet:
       the graph built here carries the visibility alone, and says so */
    const nParams = def.parameters?.length ?? 0;
    const nActions = def.actions?.length ?? 0;
    if (nParams || nActions) {
      downgraded.push(`dynamic block ${nm}: visibility states kept, `
        + `${nParams} parameter(s) and ${nActions} action(s) written static`);
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
    const bx = def.basePoint?.x ?? 0, by = def.basePoint?.y ?? 0,
      bz = def.basePoint?.z ?? 0;
    /* node ids inside the graph (the reference numbers its own from 9) */
    const N_PARAM = 9, N_GRIP = 10, N_GRIPX = 11, N_GRIPY = 12;
    /* the evaluation-expression prologue every node opens with: no
       parent, the version pair the reference stamps, no inline value,
       the node id */
    const evalExpr = (w: BitWriter, node: number): void => {
      w.bl(-1); w.bl(33); w.bl(427); w.bs(-9999); w.bl(node);
    };
    const noXdict = (w: BitWriter): void => { if (V < 2004) w.h(3, 0); };
    /* the block's extension dictionary, its entries hard-owned */
    const entries: [string, number][] = [['ACAD_ENHANCEDBLOCK', rec.graph]];
    const so = sortentsFor.get(bh);
    if (so) entries.push(['ACAD_SORTENTS', so.table]);
    entries.push(['AcDbDynamicBlockRoundTripPurgePreventer', rec.purge]);
    /* (the block's own sealed dictionary, when it travels, lists these
       entries itself — see the sealed-object emission above) */
    if (!sealedDictH.has(rec.dict)) {
      makeObject(42, rec.dict, (w) => {
        w.bl(entries.length);
        if (V >= 2000) w.bs(1);           /* cloning: keep existing */
        if (V >= 14) w.rc(1);             /* hard-owner flag */
        for (const [name] of entries) w.t(dictKey(name));
      }, (w) => {
        w.h(4, bh);
        noXdict(w);
        for (const [, h2] of entries) w.h(3, h2);
      });
    }
    /* the graph: per node its index, flags, expression node id and
       first/last incoming and outgoing edge; per edge its index, two
       constants, source and target node and five sibling links */
    makeObject(CLS_EVALGRAPH, rec.graph, (w) => {
      w.bl(12); w.bl(12);                 /* version pair */
      const nodes: [number, number[]][] = [
        [N_PARAM, [0, 0, 1, 2]], [N_GRIP, [-1, -1, 0, 0]],
        [N_GRIPX, [1, 1, -1, -1]], [N_GRIPY, [2, 2, -1, -1]]
      ];
      w.bl(nodes.length);
      nodes.forEach(([id, e], i) => {
        w.bl(i); w.bl(32); w.bl(id);
        for (const v of e) w.bl(v);
      });
      const edges: [number, number, number[]][] = [
        [1, 0, [-1, -1, -1, -1, -1]], [0, 2, [-1, -1, -1, 2, -1]],
        [0, 3, [-1, -1, 1, -1, -1]]
      ];
      w.bl(edges.length);
      edges.forEach(([from, to, o], i) => {
        w.bl(i); w.bl(0); w.bl(1); w.bl(from); w.bl(to);
        for (const v of o) w.bl(v);
      });
    }, (w) => {
      w.h(4, rec.dict);
      noXdict(w);
      for (const h2 of [rec.param, rec.grip, rec.gripX, rec.gripY]) w.h(3, h2);
    });
    /* the visibility parameter */
    makeObject(CLS_BLOCKVIS, rec.param, (w) => {
      evalExpr(w, N_PARAM);
      w.t(outText('Visibility'));         /* element name */
      w.bl(33); w.bl(427);                /* element version pair */
      w.bl(0);                            /* extended-data marker */
      w.b(1); w.b(0);                     /* show properties, chain actions */
      w.bd3(bx, by, bz);                  /* definition point */
      w.bl(0); w.bl(0);                   /* two empty property-info blocks */
      w.bl(N_GRIP);                       /* the grip's node */
      w.b(1);                             /* is initialized */
      w.t(outText(def.visibilityName ?? 'Visibility'));
      w.t(outText(def.visibilityPrompt ?? ''));
      w.b(0);
      w.bl(hs.length);                    /* members: every block entity */
      w.bl(states.length);
      for (const st of states) {
        w.t(outText(st.name));
        w.bl(st.visible.length);
        w.bl(2);                          /* state parameters: self, grip */
      }
    }, (w) => {
      w.h(4, rec.graph);                  /* owner: the graph */
      noXdict(w);
      for (const h2 of hs) w.h(4, h2);    /* members */
      for (const st of states) {
        for (const h2 of st.visible) w.h(4, h2);
        w.h(4, rec.param); w.h(4, rec.grip);
      }
    });
    /* the grip at the definition point and its two location components */
    makeObject(CLS_BLOCKVISGRIP, rec.grip, (w) => {
      evalExpr(w, N_GRIP);
      w.t(outText('Grip'));               /* element name */
      w.bl(33); w.bl(427);                /* element version pair */
      w.bl(0);                            /* extended-data marker */
      w.bl(N_GRIPX); w.bl(N_GRIPY);       /* the location components */
      w.bd3(bx, by, bz);
      w.b(0); w.bl(-1);                   /* insert cycling: off, weight */
    }, (w) => {
      w.h(4, rec.graph);
      noXdict(w);
    });
    const components = [
      [rec.gripX, N_GRIPX, 'UpdatedX'], [rec.gripY, N_GRIPY, 'UpdatedY']
    ] as const;
    for (const [h2, node, expr] of components) {
      makeObject(CLS_BLOCKGRIPEXPR, h2, (w) => {
        evalExpr(w, node);
        w.bl(N_PARAM);                    /* the parameter it locates */
        w.t(outText(expr));
      }, (w) => {
        w.h(4, rec.graph);
        noXdict(w);
      });
    }
    makeObject(CLS_DYNPURGE, rec.purge, (w) => {
      w.bs(1);
    }, (w) => {
      w.h(4, rec.dict);
      noXdict(w);
      w.h(5, bh);                         /* the block kept from purging */
    });
  }

  /* ---- draw order: one SORTENTSTABLE per space whose array order is
     not its ascending handle order (preserveHandles only — a default
     write's fresh handles already ascend in array order). The sort keys
     reuse the space's own entity handles: the i-th array entity sorts
     under the i-th smallest handle, so ascending keys replay the array
     exactly — no fresh numbers, no collisions. Each table hangs off an
     ACAD_SORTENTS entry in its block record's extension dictionary,
     which is where AutoCAD looks for it. ---- */
  for (const { block, hs } of sortSpaces) {
    const { dict, table } = sortentsFor.get(block)!;
    /* a dynamic block's extension dictionary carries this entry beside
       its graph and is written with the graph, above */
    if (!dynFor.has(block) && !sealedDictH.has(dict)) {
      makeDictionary(dict, block, [['ACAD_SORTENTS', table]]);
    }
    const sorted = [...hs].sort((a, b) => a - b);
    makeObject(CLS_SORTENTS, table, (w) => {
      w.bl(hs.length);
      for (const s of sorted) w.h(0, s);  /* sort keys, in entry order */
    }, (w) => {
      w.h(4, dict);                       /* owner: the extension dict */
      if (V < 2004) w.h(3, 0);
      w.h(4, block);                      /* the block record governed */
      for (const h2 of hs) w.h(4, h2);    /* entities, in entry order */
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
      if (typeof x === 'number' && Number.isFinite(x)) return x;
      /* a slot the source kept in its variable dictionary instead (a
         2000 file's DIMASSOC) */
      const v = variablesOut.find((q) => q.name.toLowerCase() === k.toLowerCase());
      const n = v ? Number(v.value) : NaN;
      return Number.isFinite(n) ? n : dflt;
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
    H(5, mlineStyleFor(drawing.header.vars?.CMLSTYLE));   /* CMLSTYLE */
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
    H(5, ucsRef(drawing.header.vars?.PUCSNAME));   /* PUCSNAME */
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
    H(5, ucsRef(drawing.header.vars?.UCSNAME));    /* UCSNAME */
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
      H(5, layoutDict); H(5, 0);          /* LAYOUT / PLOTSETTINGS dicts */
      H(5, plotStyleDictH);               /* PLOTSTYLE dict: the source's when carried */
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
      strStreamSize(hv, strSize);
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
    const noClasses = proxyClsH.size === 0;
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
    /* every class this file names, in the order the numbers were handed
       out (the registry is insertion-ordered): the writer's own classes,
       the application classes behind the proxies and sealed objects
       being passed through, the dynamic-block and draw-order records */
    for (const [dxfName, c] of proxyClsH) {
      cls(c.num, dxfName, c.cpp, c.ent, c.app);
    }
    if (noClasses) {
      /* the benign stub record that keeps the 2018 section non-empty */
      cls(500, 'VISUALSTYLE', 'AcDbVisualStyle', false, 'ObjectDBX Classes');
    }
    if (strW) {
      clsW.strTarget = undefined;
      const strSize = strW.pos;
      clsW.appendBits(strW);
      strStreamSize(clsW, strSize);
      clsW.b(1);                          /* strings-present flag */
      clsW.patchRl(sizePos, clsW.pos - sizePos);
    }
    clsW.align();
    return clsW.bytes();
  }

  /* ---------------- assemble the file ---------------- */
  const acdsSection = acdsSolids.length
    ? buildAcDs(acdsSolids) ?? undefined : undefined;
  if (V >= 2004) {
    return {
      data: assemble2004(hvBytes(), clsBytes(), objects, handseed,
        V === 2018 ? 2018 : V === 2007 ? 2007 : 2004, undefined,
        acdsSection, opts.preview),
      downgraded,
      skipped
    };
  }
  const out = new ByteSink();
  const push = (bytes: Uint8Array | readonly number[]): void => { out.append(bytes); };
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
    pushRS(crc16(0xC0C1, out.view(sizeStart)));
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

  /* preview: the DIB when one was given (these releases predate PNG
   * previews), else the empty block every file carries */
  const previewAddr = out.length;
  if (opts.preview?.bmp) {
    push(previewBlock(previewAddr, [{ type: 2, data: asDib(opts.preview.bmp) }]));
  } else {
    push(SN_PREVIEW_BEGIN);
    pushRL(5);
    out.push(0);                                /* zero images */
  }
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
    pushRS(crc16(0xC0C1, out.view(offset)));
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
      out.set(pageStart, (pageSize >> 8) & 0xff); /* big-endian size */
      out.set(pageStart + 1, pageSize & 0xff);
      const crc = crc16(0xC0C1, out.view(pageStart));
      out.push((crc >> 8) & 0xff, crc & 0xff);    /* big-endian CRC */
    }
    /* terminator page */
    const tStart = out.length;
    out.push(0, 2);
    const tcrc = crc16(0xC0C1, out.view(tStart));
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
  const data = out.bytes();
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
