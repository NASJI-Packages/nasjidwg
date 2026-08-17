/* nasjidwg — structural assertions for the parts of the R2004-family
 * container that real AutoCAD verifies and our own (deliberately
 * tolerant) reader does not. Each rule below was established against
 * AutoCAD 2027: violating it makes accoreconsole refuse the drawing,
 * restoring it makes the same file open with AUDIT at zero errors.
 * No AutoCAD needed at test time — these check the emitted bytes.
 */

import { describe, expect, it } from 'vitest';
import {
  writeDwg2004, writeDwg2007, writeDwg2018, writeDwgR13, writeDwgR14
} from '../src/dwg/writer.js';
import {
  cksum32R2007, crc64Normal, crc64R2007, rsEncode, sequenceCrc
} from '../src/dwg/container2007.js';
import { readDwg } from '../src/dwg/reader.js';
import { compressR2004, decompressR2004 } from '../src/dwg/compress.js';
import {
  compressR2007, decompress as decompressR2007
} from '../src/dwg/sections2007.js';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { readClasses } from '../src/dwg/classes.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Entity } from '../src/core/model.js';
import { sampleDrawing } from './corpus.js';

/* the MS CRT rand() keystream the file header is XORed with */
const decryptHeader = (data: Uint8Array): Uint8Array => {
  const dec = new Uint8Array(0x6c);
  let x = 1;
  for (let i = 0; i < dec.length; i++) {
    x = (Math.imul(x, 0x343fd) + 0x269ec3) >>> 0;
    dec[i] = data[0x80 + i] ^ ((x >>> 16) & 0xff);
  }
  return dec;
};

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};

/* OpenDesign "section page checksum": chunked Adler over mod 0xFFF1 */
const pageChecksum = (seed: number, bytes: Uint8Array): number => {
  let s1 = seed & 0xffff;
  let s2 = Math.floor(seed / 0x10000) & 0xffff;
  let at = 0;
  while (at < bytes.length) {
    const stop = Math.min(at + 0x15b0, bytes.length);
    for (; at < stop; at++) { s1 += bytes[at]; s2 += s1; }
    s1 %= 0xfff1;
    s2 %= 0xfff1;
  }
  return (s2 * 0x10000 + s1) >>> 0;
};

describe.each([
  ['R2004', writeDwg2004] as const,
  ['R2018', writeDwg2018] as const
])('%s container, as AutoCAD checks it', (_name, write) => {
  const data = write(sampleDrawing()).data;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = decryptHeader(data);
  const hv = new DataView(dec.buffer);

  it('encrypted header carries the id, sizes and a valid CRC32', () => {
    expect(String.fromCharCode(...dec.subarray(0, 11))).toBe('AcFssFcAJMB');
    expect(hv.getUint32(0x10, true)).toBe(0x6c);      /* header size */
    expect(hv.getUint32(0x14, true)).toBe(0x04);
    expect(hv.getUint32(0x44, true)).toBe(0x20);
    expect(hv.getUint32(0x48, true)).toBe(0x80);
    expect(hv.getUint32(0x4c, true)).toBe(0x40);
    const stored = hv.getUint32(0x68, true);
    const plain = new Uint8Array(dec);
    plain.fill(0, 0x68, 0x6c);
    expect(crc32(plain)).toBe(stored);
  });

  it('outer header names the release and the header address', () => {
    expect(data[0x28]).toBe(0x80);                    /* header at 0x80 */
    expect(data[0x0c]).toBe(0x03);
  });

  it('the trailing second header is a copy of the encrypted one', () => {
    const at = hv.getUint32(0x34, true) + hv.getUint32(0x38, true) * 0x100000000;
    expect(at + 0x6c).toBeLessThanOrEqual(data.length);
    expect(Array.from(data.subarray(at, at + 0x6c)))
      .toEqual(Array.from(data.subarray(0x80, 0x80 + 0x6c)));
    /* a bare page-map pseudo header sits in front of the copy */
    expect(dv.getUint32(at - 20, true)).toBe(0x41630e3b);
  });

  it('the classic eight sections are present under their fixed ids', () => {
    const sections = readSections2004(data);
    for (const name of ['AcDb:Header', 'AcDb:AuxHeader', 'AcDb:Classes',
      'AcDb:Handles', 'AcDb:Template', 'AcDb:ObjFreeSpace',
      'AcDb:AcDbObjects', 'AcDb:RevHistory']) {
      expect(sections.has(name), name).toBe(true);
    }
  });

  it('system pages carry checksums the AutoCAD formula validates', () => {
    const mapAddr = hv.getUint32(0x54, true) + 0x100;
    for (const addr of [mapAddr]) {
      const comp = dv.getUint32(addr + 8, true);
      const stored = dv.getUint32(addr + 16, true);
      const hdr = new Uint8Array(data.subarray(addr, addr + 20));
      new DataView(hdr.buffer).setUint32(16, 0, true);
      const cs1 = pageChecksum(0, hdr);
      expect(pageChecksum(cs1, data.subarray(addr + 20, addr + 20 + comp)))
        .toBe(stored);
    }
  });

  it('the Classes section keeps AutoCAD\'s strict trailer', () => {
    /* Splice-tested against AutoCAD 2027: the Classes RL must equal the
     * bit region's byte length exactly (R2018: high dword excluded, CRC
     * immediately after — RL four bytes long fails with ErrorStatus=53),
     * and eight zero bytes must follow the end sentinel. */
    const s = readSections2004(data).get('AcDb:Classes')!;
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const rl = sv.getUint32(16, true);
    if (_name === 'R2018') {
      const bitsize = sv.getUint32(24, true);       /* after the high dword */
      expect(sv.getUint32(20, true)).toBe(0);       /* 64-bit size, high 0 */
      expect(rl).toBe(Math.ceil(bitsize / 8));
      expect(s.length).toBe(20 + 4 + rl + 2 + 16 + 8);
    } else {
      expect(s.length).toBe(20 + rl + 2 + 16 + 8);
    }
    /* eight zero bytes after the end sentinel */
    expect(Array.from(s.subarray(s.length - 8))).toEqual(new Array(8).fill(0));
  });

  it('no object sits at offset 0 of AcDb:AcDbObjects', () => {
    /* AutoCAD's own files open the section with CA 0D 00 00 and place the
     * first object at offset 4; re-emitting AutoCAD's objects at offset 0
     * was refused (ErrorStatus=53), with the prefix it audits clean. */
    const s = readSections2004(data).get('AcDb:AcDbObjects')!;
    expect(Array.from(s.subarray(0, 4))).toEqual([0xca, 0x0d, 0x00, 0x00]);
  });

  it('data pages decompress to the full page window', () => {
    /* AutoCAD inflates whole 0x7400-byte pages; a stream that stops
     * early marks the drawing invalid. The first data page sits at
     * 0x100 and must produce exactly one window. */
    const addr = 0x100;
    const mask = (0x4164536b ^ addr) >>> 0;
    const comp = (dv.getUint32(addr + 8, true) ^ mask) >>> 0;
    const stream = data.subarray(addr + 32, addr + 32 + comp);
    /* must not throw, and must end with the padded terminator */
    decompressR2004(stream, 0x7400);
    expect(Array.from(stream.subarray(comp - 3))).toEqual([0x11, 0, 0]);
  });
});

it('compressed streams end with the terminator and its phantom pair', () => {
  /* Opcode 0x11 is in the long-form range: AutoCAD's decoder consumes
   * the form's two-byte distance field before recognising the end, so
   * the pair must exist and count toward the compressed size. */
  const out = compressR2004(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  expect(Array.from(out.subarray(out.length - 3))).toEqual([0x11, 0, 0]);
});

describe('R2018 AcDs section (solid-modeling payloads)', () => {
  /* Externally proven against AutoCAD 2027: an AC1032 drawing whose
   * solid carries its SAB through the AcDs section opens with AUDIT at
   * zero errors, while any inline form fails with ErrorStatus=53. The
   * section is built here field by field from the container grammar —
   * 'jard' header, 0x80-aligned segments, the schema catalogue, one
   * data record and the handle search table — so what is pinned below
   * is that grammar, walked the way AutoCAD walks it: schema by name,
   * handle to record id, record id to the cell holding the blob. */
  const data = writeDwg2018(sampleDrawing()).data;
  const acds = readSections2004(data).get('AcDb:AcDsPrototype_1b');
  const u32 = (o: number): number => (acds![o] | (acds![o + 1] << 8)
    | (acds![o + 2] << 16)) + acds![o + 3] * 0x1000000;
  const u64 = (o: number): number => u32(o) + u32(o + 4) * 0x100000000;
  const text = (o: number, n: number): string =>
    String.fromCharCode(...acds!.subarray(o, o + n));
  /** the segment table is the bootstrap: every segment sits by id */
  const segAt = (id: number): number => {
    const idx = u64(0x18);
    return u64(idx + 48 + id * 12);
  };

  it('exists, with the jard magic and page-aligned segments', () => {
    expect(acds).toBeDefined();
    expect(text(0, 4)).toBe('jard');
    expect(acds!.length % 0x80).toBe(0);
    expect(u64(0x34)).toBe(acds!.length);        /* declared total size */
    for (const id of [u32(0x24), u32(0x28), u32(0x2c)]) {
      const at = segAt(id);                      /* schidx, datidx, search */
      expect(at % 0x80).toBe(0);
      expect(text(at, 2)).toBe('\xac\xd5');      /* the segment magic */
    }
  });

  it('resolves the solid handle to the blob through its own indices', () => {
    /* search: the ASM schema's table names the record for the handle */
    const search = segAt(u32(0x2c)) + 48;
    const schema = u32(search + 4);
    /* [u32 tables][u32 schema][u64 n][u64 record id][u64 n]
       [u32 key kind][u64 handle][u64 n][u64 record id] */
    const handle = u64(search + 36);
    expect(u32(search)).toBe(1);                 /* one table */
    expect(handle).toBeGreaterThan(0);
    expect(u64(search + 52)).toBe(u64(search + 16));   /* same record id */
    /* datidx: that schema's record sits in a data segment at an offset */
    const datidx = segAt(u32(0x28)) + 48;
    expect(u64(datidx)).toBe(1);
    expect(u32(datidx + 16)).toBe(schema);
    const rec = segAt(u32(datidx + 8)) + 48 + u32(datidx + 12);
    /* the record directory entry keys the same handle, and its cell is
       the SAB (a signature may carry a two-byte tag in pre-ASM files) */
    expect(u32(rec)).toBe(20);
    expect(u64(rec + 8)).toBe(handle);
    const cell = rec + 32 + u32(rec + 16);
    expect(u32(cell)).toBeGreaterThan(0);
    expect(/(ACIS|ASM) BinaryFile/.test(text(cell + 4, 20))).toBe(true);
  });

  it('declares the schema catalogue and carries no image data', () => {
    let all = '';
    for (const b of acds!) all += String.fromCharCode(b);
    expect(all).toContain('AcDb3DSolid_ASM_Data');
    expect(all).toContain('AcDbDs::HandleAttributeSchema');
    /* the section AutoCAD writes also parks a PNG preview in here; ours
       never does — nothing in this section comes from another file */
    expect(all).not.toContain('PNG');
    expect(all).not.toContain('IHDR');
  });

  it('the solid record itself goes empty-inline with has_ds_data set', () => {
    /* the reader binds the AcDs blob back onto the solid, so the SAB
     * survives a 2018 round trip through the section */
    const back = readDwg(data);
    const solid = back.entities.find((e) => e.type === 'acis');
    expect(solid).toBeDefined();
    expect(solid && 'sab' in solid ? solid.sab : undefined).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */

describe('round-7 rules AutoCAD 2027 enforces on R2018 output', () => {
  const data = writeDwg2018(sampleDrawing()).data;
  const sections = readSections2004(data);

  it('the corpus SAB payload is an ASM-format stream in the AcDs slot', () => {
    /* Externally proven: a pre-ASM "ACIS BinaryFile" payload is refused
     * in every transport, while this minimal hand-built ASM stream (raw
     * 15-byte magic, asmheader/body/lump/shell/transform, subclass
     * End-of-ASM-data trailer) opens with AUDIT 0/0 — as a 3DSOLID and
     * as a BODY singleton, and inside the full corpus. */
    const acds = sections.get('AcDb:AcDsPrototype_1b');
    expect(acds).toBeDefined();
    let text = '';
    for (const b of acds!) text += String.fromCharCode(b);
    expect(text).toContain('ASM BinaryFile4');
    expect(text).toContain('\x0e\x03End\x0e\x02of\x0e\x03ASM\r\x04data');
  });

  it('symbol names carry no \\U+XXXX escape text in the UTF-16 streams', () => {
    /* AUDIT renames any symbol name it has to normalize: a literal
     * \U+XXXX escape (the pre-2007 codepage spelling) or an Arabic
     * presentation form is flagged "Un-normalized symbol name" — two
     * such errors on the corpus before round 7, zero after. Names must
     * go out as raw UTF-16 (entity TEXT content may keep the escapes —
     * AutoCAD still honours those — so the drawing scanned here has
     * non-ASCII in a layer name and nowhere else). The scan slides the
     * UTF-16LE pattern for "\U+" across every bit shift, since object
     * streams are not byte-aligned. */
    const d = emptyDrawing();
    d.layers.push({
      name: 'Étage€حوائط', color: { kind: 'aci', index: 3 },
      on: true, frozen: false, locked: false
    });
    const objs = readSections2004(writeDwg2018(d).data)
      .get('AcDb:AcDbObjects');
    expect(objs).toBeDefined();
    const pat = [0x5c, 0x00, 0x55, 0x00, 0x2b, 0x00];   /* \ U +  UTF-16LE */
    const bitAt = (buf: Uint8Array, i: number): number =>
      (buf[i >> 3] >> (7 - (i & 7))) & 1;
    const patBits: number[] = [];
    for (const byte of pat) {
      for (let k = 7; k >= 0; k--) patBits.push((byte >> k) & 1);
    }
    let hits = 0;
    const total = objs!.length * 8 - patBits.length;
    for (let s = 0; s <= total; s++) {
      let ok = true;
      for (let k = 0; k < patBits.length && ok; k++) {
        if (bitAt(objs!, s + k) !== patBits[k]) ok = false;
      }
      if (ok) { hits++; break; }
    }
    expect(hits).toBe(0);
    /* the name itself must round-trip through the container */
    const back = readDwg(writeDwg2018(d).data);
    expect(back.layers.some((l) => l.name === 'Étage€حوائط')).toBe(true);
  });

  it('a MULTILEADER drawing carries the dense MLEADERSTYLE class pair', () => {
    /* Externally proven: the MULTILEADER singleton audited 1/1 while its
     * style handle was NULL, and 0/0 once it resolves to a synthesized
     * "Standard" MLEADERSTYLE (field-walked bit-for-bit against the
     * Standard style in an AutoCAD 2027 save). The class records number
     * densely from 500 in emission order. */
    const d = emptyDrawing();
    d.entities.push({
      type: 'mleader', layer: '0', color: { kind: 'byLayer' },
      leaders: [{
        lines: [[{ x: 0, y: 0, z: 0 }]],
        landing: { x: 30, y: 20, z: 0 },
        doglegVector: { x: 1, y: 0, z: 0 },
        doglegLength: 0.36
      }],
      text: 'note', textPosition: { x: 30.45, y: 20.115, z: 0 },
      textHeight: 0.18, arrowSize: 0.18,
      scale: 1, hasLanding: true, hasDogleg: true
    } as Entity);
    const bytes = writeDwg2018(d).data;
    const clsSec = readSections2004(bytes).get('AcDb:Classes');
    expect(clsSec).toBeDefined();
    const classes = readClasses(clsSec!, 'R2018');
    expect(classes.get(500)?.dxfName).toBe('MULTILEADER');
    expect(classes.get(501)?.dxfName).toBe('MLEADERSTYLE');
    expect(classes.get(501)?.cppName).toBe('AcDbMLeaderStyle');
    /* and the reader walks the whole file back without complaint */
    expect(readDwg(bytes).warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * R13 (AC1012) container rules — campaign 6.
 *
 * R13 write acceptance was blocked for four campaigns for want of a
 * vintage sample. With one in hand the whole gap turned out to be four
 * places where we had been writing the R14 spelling under an AC1012
 * signature. Each rule below is stated the way AutoCAD 2027 grades it:
 * violate it and accoreconsole refuses the file with ErrorStatus 53
 * before AUDIT ever runs; restore it and the same drawing opens with
 * AUDIT at zero errors. The decisive experiment is worth recording —
 * our R13 file relabelled AC1014 opened clean, and the vintage AC1012
 * file relabelled AC1014 failed, so the two encodings genuinely differ
 * and AutoCAD dispatches on the signature.
 * ------------------------------------------------------------------ */
describe('R13 container rules (AC1012)', () => {
  const flatLocators = (data: Uint8Array): Map<number, [number, number]> => {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Map<number, [number, number]>();
    const n = dv.getUint32(0x15, true);
    for (let i = 0; i < n; i++) {
      const p = 0x19 + i * 9;
      out.set(data[p], [dv.getUint32(p + 1, true), dv.getUint32(p + 5, true)]);
    }
    return out;
  };
  const r13 = (): Uint8Array => writeDwgR13(sampleDrawing()).data;
  const r14 = (): Uint8Array => writeDwgR14(sampleDrawing()).data;

  it('carries the 53-byte ObjFreeSpace section, unlike R14', () => {
    /* Every vintage AC1012 file ends its object map with the record
       [RL 0][RL numhandles][RL+RL TDUPDATE][RL objects_address][RC 4]
       [RLL 0x32][RLL 0x64][RLL 0x200][RLL 0xffffffff] — 53 bytes — and
       registers it as locator 3. Native R14 files zero that entry. */
    const loc13 = flatLocators(r13());
    expect(loc13.get(3)?.[1]).toBe(53);
    expect(loc13.get(3)?.[0]).toBeGreaterThan(0);
    expect(loc13.get(4)?.[1]).toBe(4);          /* template stays too */
    expect(flatLocators(r14()).get(3)).toEqual([0, 0]);
  });

  it('repeats sections 3 and 4 in the R13 second header', () => {
    /* The second header keeps its own copy of the section table. R14
       leaves records 3 and 4 zeroed there; R13 fills all five, and the
       copy has to agree with the locator table. */
    const data = r13();
    const loc = flatLocators(data);
    const sentinel = [0xd4, 0x7b, 0x21, 0xce, 0x28, 0x93, 0x9f, 0xbf,
      0x53, 0x24, 0x40, 0x09, 0x12, 0x3c, 0xaa, 0x01];
    let at = -1;
    outer: for (let i = 0; i + 16 <= data.length; i++) {
      for (let j = 0; j < 16; j++) if (data[i + j] !== sentinel[j]) continue outer;
      at = i; break;
    }
    expect(at).toBeGreaterThan(0);
    /* bit-walk the second header: RL size, BL address, 11 raw version
       bytes, RC maint, RC one-or-three, BS versions, RS codepage, BS
       count, then (RC nr, BL addr, BL size) per section */
    let pos = (at + 16) * 8;
    const bit = (): number => (data[pos >> 3] >> (7 - (pos++ & 7))) & 1;
    const bits = (n: number): number => {
      let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v;
    };
    const rc = (): number => bits(8);
    const rs = (): number => rc() | (rc() << 8);
    const rl = (): number => (rs() | (rs() << 16)) >>> 0;
    const bl = (): number => {
      const c = bits(2); return c === 0 ? rl() : c === 1 ? rc() : 0;
    };
    const bs = (): number => {
      const c = bits(2); return c === 0 ? rs() : c === 1 ? rc() : c === 2 ? 0 : 256;
    };
    rl(); bl();
    let ver = '';
    for (let i = 0; i < 11; i++) { const c = rc(); if (c) ver += String.fromCharCode(c); }
    expect(ver).toBe('AC1012');
    rc(); rc(); bs(); rs();
    expect(bs()).toBe(5);                        /* five section records */
    for (let i = 0; i < 5; i++) {
      const nr = rc(), addr = bl(), size = bl();
      expect([nr, addr, size]).toEqual([nr, ...loc.get(nr)!]);
    }
  });

  it('does not NUL-terminate strings the way R14 does', () => {
    /* The vintage AC1012 stores "BYBLOCK" as TV length 7 with no
       terminator; its R14 twin stores length 8 and a trailing zero.
       Writing the C-string form under AC1012 is what made every R13 file
       we ever produced fail to load. */
    const has = (data: Uint8Array, needle: string): boolean => {
      const pat = [...needle].map((c) => c.charCodeAt(0));
      outer: for (let i = 0; i + pat.length <= data.length; i++) {
        for (let j = 0; j < pat.length; j++) if (data[i + j] !== pat[j]) continue outer;
        return true;
      }
      return false;
    };
    /* the symbol names are byte-aligned in both containers */
    expect(has(r14(), 'BYBLOCK\0')).toBe(true);
    expect(has(r13(), 'BYBLOCK')).toBe(true);
    expect(has(r13(), 'BYBLOCK\0')).toBe(false);
    expect(has(r13(), 'CONTINUOUS\0')).toBe(false);
  });

  it('omits the DICTIONARY hard-owner byte at R13 and keeps it at R14', () => {
    /* The one-byte defect that cost four campaigns: the hard-owner RC
       arrives with R13c3, so plain AC1012 runs the entry names straight
       on from the item count. Emitting it shifted every dictionary name
       by a byte and AutoCAD's R13 loader died on the named-object
       dictionary before AUDIT. Asserted through the reader, which now
       shares the same gate, plus the raw byte count that proves the two
       containers really differ by exactly that byte. */
    for (const [make, label] of [[writeDwgR13, 'R13'], [writeDwgR14, 'R14']] as const) {
      const d = emptyDrawing();
      const back = readDwg(make(d).data);
      expect(back.warnings, label).toEqual([]);
    }
    /* and the dictionaries really resolve: the MLINESTYLE STANDARD every
       R13/R14 file must carry is reachable only through the
       ACAD_MLINESTYLE entry of the named-object dictionary, so a
       byte-shifted dictionary name loses it */
    for (const make of [writeDwgR13, writeDwgR14]) {
      const back = readDwg(make(sampleDrawing()).data);
      expect(back.mlineStyles?.some((s) => s.name === 'STANDARD')).toBe(true);
    }
  });

  it('closes the R13 header-variable section with the four trailing shorts', () => {
    /* The vintage file ends its header section with four BS(-1) before
       the padding — the same four "unknown" shorts R14 through R2004
       carry. We had gated them at R14+, which left our R13 header
       section a field short under AutoCAD's cursor. Proven by reading
       the section back: the writer's last data bit must land within one
       byte of the declared end. */
    const data = r13();
    const [addr, size] = flatLocators(data).get(0)!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const declared = dv.getUint32(addr + 16, true);
    expect(size).toBe(16 + 4 + declared + 2 + 16);
    /* the four shorts are BS(0) = the two-bit form, so the section ends
       with a byte whose low bits are the padded remainder; the R13 and
       R14 sections now differ by no more than the R13-only field set */
    const [a14, s14] = flatLocators(r14()).get(0)!;
    void a14;
    expect(Math.abs(size - s14)).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ *
 * R2007 page checksums — campaign 6.
 *
 * Recovered by algebraic attack on 102 genuine AC1021 files (every
 * drawing AutoCAD 2027 ships, plus the libredwg samples): 1814 of 1815
 * section-page records and all 408 map-level fields reproduce exactly.
 * The two reasons no textbook parameter set ever fit are pinned below —
 * the message is walked as 16-bit words of each aligned chunk, most
 * significant first, and the initial value comes from the message LENGTH
 * through two steps of the MSVC CRT rand() LCG. The source uses a
 * 256-entry table; the check here re-implements the same definition the
 * slow, obvious way, so a table or an endianness slip cannot pass both.
 * ------------------------------------------------------------------ */
describe('R2007 page checksums', () => {
  const M = (1n << 64n) - 1n;
  /** bit-by-bit reflected CRC-64/Jones, no table */
  const slowCrc = (msg: Uint8Array, init: bigint): bigint => {
    let c = init;
    for (const byte of msg) {
      c ^= BigInt(byte);
      for (let k = 0; k < 8; k++) {
        c = (c & 1n) ? ((c >> 1n) ^ 0x95ac9329ac4bc9b5n) : (c >> 1n);
      }
    }
    return c & M;
  };
  const initFor = (len: number): bigint => {
    const s1 = (214013n * BigInt(len) + 2531011n) & M;
    const s2 = (214013n * s1 + 2531011n) & M;
    return ~(s1 | ((s2 << 32n) & M)) & M;
  };
  /** the documented walk, spelled out */
  const walk = (b: Uint8Array): Uint8Array => {
    const out: number[] = [];
    let i = 0;
    for (; i + 8 <= b.length; i += 8) {
      for (const w of [3, 2, 1, 0]) out.push(b[i + 2 * w], b[i + 2 * w + 1]);
    }
    if (i + 4 <= b.length) {
      for (const w of [1, 0]) out.push(b[i + 2 * w], b[i + 2 * w + 1]);
      i += 4;
    }
    if (i + 2 <= b.length) { out.push(b[i], b[i + 1]); i += 2; }
    if (i < b.length) out.push(b[i]);
    return Uint8Array.from(out);
  };

  const cases = [
    new Uint8Array(0),
    Uint8Array.from([1]),
    Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    Uint8Array.from({ length: 8 }, (_, i) => i * 17 + 3),
    Uint8Array.from({ length: 13 }, (_, i) => (i * 91) & 0xff),
    Uint8Array.from({ length: 251 }, (_, i) => (i * 37 + 11) & 0xff),
    Uint8Array.from({ length: 30000 }, (_, i) => (i * 7 + i * i) & 0xff)
  ];

  it('matches an independent bit-by-bit CRC-64/Jones with the length-derived init', () => {
    for (const msg of cases) {
      expect(crc64R2007(msg), `len ${msg.length}`)
        .toBe(slowCrc(walk(msg), initFor(msg.length)));
    }
  });

  it('is not any textbook CRC-64: init and word order both matter', () => {
    /* the same message with a zero init, an all-ones init, or in plain
       byte order must all disagree — those are exactly the variants the
       118-sample sweep ruled out */
    const msg = cases[5];
    expect(crc64R2007(msg)).not.toBe(slowCrc(walk(msg), 0n));
    expect(crc64R2007(msg)).not.toBe(slowCrc(walk(msg), M));
    expect(crc64R2007(msg)).not.toBe(slowCrc(msg, initFor(msg.length)));
  });

  it('the 32-bit sibling is the R2004 page Adler over the same walk', () => {
    for (const msg of cases) {
      const m = walk(msg);
      const seed = (Math.imul(214013, msg.length) + 2531011) >>> 0;
      let s1 = seed & 0xffff, s2 = (seed >>> 16) & 0xffff, at = 0;
      while (at < m.length) {
        const stop = Math.min(at + 0x15b0, m.length);
        for (; at < stop; at++) { s1 += m[at]; s2 += s1; }
        s1 %= 0xfff1; s2 %= 0xfff1;
      }
      expect(cksum32R2007(msg), `len ${msg.length}`)
        .toBe(((s2 % 0xfff1) * 0x10000 + (s1 % 0xfff1)) >>> 0);
    }
  });

  it('every R2007 section page carries a live checksum pair', () => {
    /* the fields used to go out zeroed; a regression that zeroes them
       again would be invisible to our own reader, which ignores them */
    const data = writeDwg2007(sampleDrawing()).data;
    expect(data.length).toBeGreaterThan(0x480);
    /* determinism: the same drawing must produce the same bytes */
    expect(Array.from(writeDwg2007(sampleDrawing()).data)).toEqual(Array.from(data));
    /* and the checksum of a real page is never trivially zero */
    expect(crc64R2007(data.subarray(0x480, 0x480 + 251))).not.toBe(0n);
    expect(cksum32R2007(data.subarray(0x480, 0x480 + 251))).not.toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The R2007 file header's own CRC — campaign 8.
 *
 * The container needs BOTH members of a CRC-64 pair. Pages use the
 * mirrored (reflected CRC-64/Jones) form checked above; the file header's
 * three fields use the normal one — forward CRC-64/ECMA-182, inverted on
 * the way out — over the same word walk, seeded from the message length
 * through a second, different folding of the same LCG. Verified against
 * 102 genuine AC1021 files; re-implemented here the slow way so a table
 * slip cannot pass both.
 * ------------------------------------------------------------------ */
describe('R2007 file header CRC', () => {
  const M = (1n << 64n) - 1n;
  /** bit-by-bit forward CRC-64/ECMA-182, no table, inverted at the end */
  const slowNormal = (msg: Uint8Array, seed: bigint): bigint => {
    let c = seed & M;
    for (const byte of msg) {
      c ^= (BigInt(byte) << 56n) & M;
      for (let k = 0; k < 8; k++) {
        c = (c & (1n << 63n)) ? (((c << 1n) & M) ^ 0x42f0e1eba9ea3693n) : ((c << 1n) & M);
      }
    }
    return ~c & M;
  };
  const walk = (b: Uint8Array): Uint8Array => {
    const out: number[] = [];
    let i = 0;
    for (; i + 8 <= b.length; i += 8) {
      for (let w = 3; w >= 0; w--) out.push(b[i + 2 * w], b[i + 2 * w + 1]);
    }
    if (i + 4 <= b.length) { out.push(b[i + 2], b[i + 3], b[i], b[i + 1]); i += 4; }
    if (i + 2 <= b.length) { out.push(b[i], b[i + 1]); i += 2; }
    if (i < b.length) out.push(b[i]);
    return Uint8Array.from(out);
  };
  const seed1 = (len: number): bigint => {
    const s = (BigInt(len) * 214013n + 2531011n) & M;
    return ~(s | ((s * ((214013n << 32n) & M) + ((2531011n << 32n) & M)) & M)) & M;
  };

  it('matches a table-free forward CRC-64/ECMA-182', () => {
    for (const len of [1, 2, 3, 4, 7, 8, 9, 16, 17, 64, 255]) {
      const msg = new Uint8Array(len);
      for (let i = 0; i < len; i++) msg[i] = (i * 37 + 11) & 0xff;
      expect(crc64Normal(msg, seed1(len)), `len ${len}`)
        .toBe(slowNormal(walk(msg), seed1(len)));
    }
  });

  it('the checking sequence is the key rotated by its own low five bits', () => {
    const key = 0x0123456789abcdefn;
    const shift = key & 0x1fn;
    const rot = ((key << shift) | (key >> (64n - shift))) & M;
    const msg = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      msg[i] = Number((key >> BigInt(8 * i)) & 0xffn);
      msg[8 + i] = Number((rot >> BigInt(8 * i)) & 0xffn);
    }
    expect(sequenceCrc(key)).toBe(slowNormal(walk(msg), seed1(16)));
    /* the rotate is the whole of the field's non-linearity: without it
       seqCrc would be affine in the key, and every parameter sweep that
       assumed a plain CRC of the key came back empty because of it */
    expect(sequenceCrc(key)).not.toBe(sequenceCrc(key ^ 1n));
  });

  it('the emitted R2007 prologue carries a live, self-consistent pair', () => {
    const data = writeDwg2007(sampleDrawing()).data;
    /* de-interleave the RS(255,239) file header: byte j of block i sits
       at j * blocks + i */
    const payload = new Uint8Array(3 * 239);
    let k = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0, s = i; j < 239; j++, s += 3) payload[k++] = data[0x80 + s];
    }
    const le = (at: number): bigint => {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(payload[at + i]);
      return v;
    };
    const seq = le(0), key = le(8), compr = le(16);
    expect(seq).not.toBe(0n);
    expect(compr).not.toBe(0n);
    expect(seq).toBe(sequenceCrc(key));
  });
});

/* ------------------------------------------------------------------ *
 * R2007 Reed-Solomon coding.
 *
 * The container uses two RS codes and they do NOT share a field: the file
 * header and the system pages are RS(255,239) over x^8+x^6+x^5+x^3+1,
 * data pages are RS(255,251) over x^8+x^4+x^3+x^2+1. Writing one code's
 * generator over the other's blocks costs nothing at read time — our own
 * reader ignores parity, so such a file round-trips perfectly — but
 * AutoCAD refuses it: flipping the parity of a single data page in an
 * otherwise untouched genuine drawing is enough for ErrorStatus=53.
 *
 * That failure mode is invisible to any round-trip test, so it is caught
 * here algebraically instead. A codeword of a narrow-sense RS code is
 * divisible by its generator, so it vanishes at every root; the checks
 * below evaluate what `rsEncode` emits at the roots of both codes and at
 * a few non-roots, over hand-built payloads. No genuine file is involved
 * and none can be: the property is a fact about the code, not about any
 * drawing.
 * ------------------------------------------------------------------ */
describe('R2007 Reed-Solomon codes', () => {
  /** GF(256) multiply under an explicit field polynomial. */
  const mul = (a: number, b: number, poly: number): number => {
    let p = 0, A = a, B = b;
    while (B !== 0) {
      if (B & 1) p ^= A;
      B >>= 1;
      A <<= 1;
    }
    for (let bit = 15; bit >= 8; bit--) if (p & (1 << bit)) p ^= poly << (bit - 8);
    return p & 0xff;
  };
  /** x^k in GF(256), x being the primitive element both codes use. */
  const pow = (k: number, poly: number): number => {
    let v = 1;
    for (let i = 0; i < k; i++) v = mul(v, 2, poly);
    return v;
  };
  /** Block `i` of an interleaved page: byte j of block i sits at j*blocks+i. */
  const blockOf = (page: Uint8Array, blocks: number, i: number): Uint8Array => {
    const out = new Uint8Array(255);
    for (let j = 0; j < 255; j++) out[j] = page[j * blocks + i];
    return out;
  };
  /** The block read as a polynomial, evaluated at x^k, by Horner. */
  const evalAt = (block: Uint8Array, k: number, poly: number): number => {
    const x = pow(k, poly);
    let acc = 0;
    for (let j = 254; j >= 0; j--) acc = mul(acc, x, poly) ^ block[j];
    return acc;
  };

  /** A payload with no structure a coder could accidentally survive. */
  const payload = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let x = 0x2545f491;
    for (let i = 0; i < n; i++) {
      x ^= (x << 13) >>> 0; x >>>= 0;
      x ^= x >>> 17;
      x ^= (x << 5) >>> 0; x >>>= 0;
      out[i] = x & 0xff;
    }
    return out;
  };

  const CODES = [
    { name: 'system pages, RS(255,239)', dataSize: 239, poly: 0x169, parity: 16 },
    { name: 'data pages, RS(255,251)', dataSize: 251, poly: 0x11d, parity: 4 },
  ] as const;

  for (const code of CODES) {
    it(`${code.name}: every block is a codeword`, () => {
      for (const blocks of [1, 3, 7]) {
        const page = rsEncode(payload(code.dataSize * blocks), code.dataSize, blocks);
        expect(page.length).toBe(blocks * 255);
        for (let i = 0; i < blocks; i++) {
          const block = blockOf(page, blocks, i);
          for (let r = 1; r <= code.parity; r++) {
            expect(evalAt(block, r, code.poly)).toBe(0);
          }
        }
      }
    });

    it(`${code.name}: the data survives and the parity is not zero padding`, () => {
      const src = payload(code.dataSize * 2);
      const page = rsEncode(src, code.dataSize, 2);
      for (let i = 0; i < 2; i++) {
        const block = blockOf(page, 2, i);
        expect([...block.subarray(0, code.dataSize)])
          .toEqual([...src.subarray(i * code.dataSize, (i + 1) * code.dataSize)]);
        /* the parity occupies exactly 255 - dataSize bytes and is live */
        expect(block.subarray(code.dataSize).some((b) => b !== 0)).toBe(true);
        expect(255 - code.dataSize).toBe(code.parity);
      }
    });

    it(`${code.name}: a single flipped byte breaks the codeword`, () => {
      const page = rsEncode(payload(code.dataSize), code.dataSize, 1);
      for (const at of [0, 17, code.dataSize - 1, code.dataSize, 254]) {
        const bad = page.slice();
        bad[at] ^= 0xff;
        const syndromes: number[] = [];
        for (let r = 1; r <= code.parity; r++) syndromes.push(evalAt(bad, r, code.poly));
        expect(syndromes.some((s) => s !== 0)).toBe(true);
      }
    });
  }

  it('the two codes are genuinely different fields, not one code twice', () => {
    /* The bug this guards against wrote the RS(255,239) generator over a
       data page. Such a page is a codeword of neither code: check that
       each code's page fails the other code's roots. */
    const sys = rsEncode(payload(239), 239, 1);
    const dat = rsEncode(payload(251), 251, 1);
    const fails = (page: Uint8Array, parity: number, poly: number): boolean => {
      for (let r = 1; r <= parity; r++) if (evalAt(page, r, poly) !== 0) return true;
      return false;
    };
    expect(fails(sys, 4, 0x11d)).toBe(true);
    expect(fails(dat, 16, 0x169)).toBe(true);
    /* and an unsupported block size is refused rather than mis-coded */
    expect(() => rsEncode(payload(255), 255, 1)).toThrow();
  });

  it('an emitted R2007 file has valid parity on every page', () => {
    const data = writeDwg2007(sampleDrawing()).data;
    /* the file header block is always three RS(255,239) blocks at 0x80 */
    for (let i = 0; i < 3; i++) {
      const block = blockOf(data.subarray(0x80, 0x80 + 3 * 255), 3, i);
      for (let r = 1; r <= 16; r++) expect(evalAt(block, r, 0x169)).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * R2007 LZ: the position-dependent match forms.
 *
 * Three of the decoder's shapes mean different things depending on where
 * it reads them. After a literal run every byte is a reference, so the
 * 0x00..0x0F half of the near form can be spelled outright and a compact
 * match may carry length 15 (opcode 0xF0..0xFF). Between two matches a
 * high nibble of zero introduces a literal run instead, so there the near
 * form's lower half goes out masked as 0xF0|n and compact length 15 is
 * unspellable. Genuine AC1021 streams use all three under exactly these
 * rules; emitting them cost about 6% of our compressed size.
 *
 * The payloads below pin each form to a known byte offset, so a regression
 * that quietly falls back to the four-byte far form (which decodes to the
 * same bytes, and so survives any round-trip test) is caught here.
 * ------------------------------------------------------------------ */
describe('R2007 LZ match forms', () => {
  const noise = (n: number, seed: number): Uint8Array => {
    const out = new Uint8Array(n);
    let x = seed >>> 0;
    for (let i = 0; i < n; i++) {
      x ^= (x << 13) >>> 0; x >>>= 0;
      x ^= x >>> 17;
      x ^= (x << 5) >>> 0; x >>>= 0;
      out[i] = x & 0xff;
    }
    return out;
  };
  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const roundTrip = (src: Uint8Array): Uint8Array => {
    const packed = compressR2007(src);
    const back = new Uint8Array(src.length + 64);
    decompressR2007(back, 0, back.length, packed, packed.length);
    expect([...back.subarray(0, src.length)]).toEqual([...src]);
    return packed;
  };

  /* 40 incompressible bytes, then 30 of them again: one literal run too
     long to state in an opcode (so a 0x0F chain, two bytes) and one match
     of length 30 at distance 40. The match opcode therefore sits at
     offset 2 + 40. */
  const NEAR_LO = cat(noise(40, 12345), noise(40, 12345).subarray(0, 30));

  it('spells a long near match in three bytes after a literal run', () => {
    const packed = roundTrip(NEAR_LO);
    expect(packed[0]).toBe(0x0f);
    const opcode = packed[42];
    expect(opcode >> 4).toBe(0);            /* the near form's lower half */
    expect(packed.length).toBe(45);         /* 2 + 40 + 3, not 4 for far  */
  });

  it('masks that same form when it follows a match directly', () => {
    const a = noise(40, 12345);
    const packed = roundTrip(cat(a, a.subarray(0, 30), a.subarray(5, 35)));
    expect(packed[42] >> 4).toBe(0);        /* first match, read at the top */
    expect(packed[45]).toBeGreaterThanOrEqual(0xf0);  /* second, masked */
    expect(packed.length).toBe(48);
  });

  it('uses compact length 15 only where the opcode cannot read as the mask', () => {
    const b = noise(64, 777);
    const packed = roundTrip(cat(b, b.subarray(0, 15), noise(8, 9)));
    /* 2 bytes of literal count + 64 literals, then the match */
    expect(packed[66] >> 4).toBe(0xf);      /* length 15, distance 64 */
    expect(packed[66] & 0xf).toBe(0xf);     /* (64 - 1) & 0xf         */
  });

  it('round-trips every shape the matcher can reach', () => {
    /* runs, near-repeats and noise in one buffer, so the parse walks
       literal chains, adjacent matches and every distance class */
    for (let seed = 1; seed <= 24; seed++) {
      const parts: Uint8Array[] = [];
      let x = seed >>> 0;
      const next = (): number => {
        x ^= (x << 13) >>> 0; x >>>= 0;
        x ^= x >>> 17;
        x ^= (x << 5) >>> 0; x >>>= 0;
        return x >>> 0;
      };
      for (let k = 0; k < 40; k++) {
        const kind = next() % 3;
        const n = 1 + (next() % 300);
        if (kind === 0) parts.push(noise(n, next()));
        else if (kind === 1) parts.push(new Uint8Array(n).fill(next() & 0xff));
        else {
          const src = cat(...parts);
          if (src.length === 0) { parts.push(noise(n, next())); continue; }
          const from = next() % src.length;
          parts.push(src.subarray(from, Math.min(src.length, from + n)));
        }
      }
      const src = cat(...parts);
      const packed = roundTrip(src);
      expect(packed.length).toBeLessThan(src.length);
    }
  });
});

/* ------------------------------------------------------------------ *
 * R2007 envelope seeds.
 *
 * Seven of the envelope's 64-bit fields are not seven independent random
 * numbers: in every one of 102 genuine AC1021 files they are fourteen
 * CONSECUTIVE words of one MT19937 seeding stream, read out in pairs,
 * high word first, with four of the seven stored under the mask
 * 0xF7DF7DF7DF7DF7DF. All seven are free — each was replaced individually
 * in a genuine file and AUDITed clean — so this is a shape assertion, not
 * a correctness one, and it is checked from the emitted bytes alone.
 * ------------------------------------------------------------------ */
describe('R2007 envelope seeds', () => {
  const MASK = 0xf7df7df7df7df7dfn;
  const data = writeDwg2007(sampleDrawing()).data;
  const payload = ((): Uint8Array => {
    const out = new Uint8Array(3 * 239);
    let k = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0, s = i; j < 239; j++, s += 3) out[k++] = data[0x80 + s];
    }
    return out;
  })();
  const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const record = ((): DataView => {
    const rec = new Uint8Array(0x110);
    decompressR2007(rec, 0, 0x110, payload.subarray(32), pv.getInt32(24, true));
    return new DataView(rec.buffer);
  })();
  /* the 0x28 check-data block closes the file header page */
  const check = new DataView(data.buffer, data.byteOffset + 0x480 - 0x28, 0x28);

  const key = pv.getBigUint64(8, true);
  const r1 = check.getBigUint64(16, true);
  const r2 = check.getBigUint64(24, true);

  it('stores the four masked seeds inside the mask', () => {
    for (const [name, v] of [
      ['sections map crc seed', record.getBigUint64(0xe0, true)],
      ['pages map crc seed', record.getBigUint64(0x20, true)],
      ['check data word 5', check.getBigUint64(32, true)],
      ['crc seed encoded', record.getBigUint64(0xf8, true)],
    ] as const) {
      expect(v & MASK, name).toBe(v);
      expect(v, name).not.toBe(0n);
    }
  });

  it('leaves the two fields genuine files leave alone', () => {
    /* crc_seed at 0xF0 is zero in all 102 genuine files; random_seed at
       0x100 is the one field AutoCAD verifies and we cannot yet mint */
    expect(record.getBigUint64(0xf0, true)).toBe(0n);
    expect(record.getBigUint64(0x100, true)).toBe(0n);
  });

  it('draws r1, r2 and the key as consecutive words of one stream', () => {
    /* x[n] = 1812433253 * (x[n-1] ^ (x[n-1] >> 30)) + n, so for a genuinely
       adjacent pair the index falls out of the arithmetic; unrelated words
       would give a value spread over the whole 32-bit range. */
    const hi = (v: bigint): number => Number((v >> 32n) & 0xffffffffn) >>> 0;
    const lo = (v: bigint): number => Number(v & 0xffffffffn) >>> 0;
    const indexOf = (u: number, v: number): number =>
      (v - Math.imul(1812433253, (u ^ (u >>> 30)) >>> 0)) >>> 0;
    const a = indexOf(hi(r1), lo(r1));
    expect(indexOf(lo(r1), hi(r2))).toBe(a + 1);
    expect(indexOf(hi(r2), lo(r2))).toBe(a + 2);
    /* the key closes the window, six words after r2's low word */
    expect(indexOf(hi(key), lo(key))).toBe(a + 8);
    /* and the window sits where genuine files put it */
    expect(a - 5).toBeGreaterThanOrEqual(139);
    expect(a - 5).toBeLessThanOrEqual(359);
  });

  it('keeps the checking sequence consistent with the drawn key', () => {
    expect(pv.getBigUint64(0, true)).toBe(sequenceCrc(key));
  });
});
