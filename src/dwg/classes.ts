/* nasjidwg — the CLASSES section: class number -> DXF name.
 *
 * Object types >= 500 are application classes; their meaning comes from
 * this table (500 + index into it, in file order). Strings are codepage
 * text through R2004; R2007+ moves them to a trailing string stream, which
 * we locate with the same backwards walk objects use.
 */

import { BitReader, decodeCodepage } from './bitstream.js';
import type { FileVersion } from '../core/model.js';
import { versionRank } from './fileheader.js';

export interface DwgClassInfo {
  classNum: number;
  dxfName: string;
  cppName: string;
  appName: string;
  isEntity: boolean;                     /* itemclass 0x1F2 = entity */
  /** R2004+: the drawing-format code and maintenance number the record
   *  carries for the class (the reference's own files: 33/427 for its
   *  dynamic-block graph classes, say). */
  dwgVersion?: number;
  maintVersion?: number;
}

const CLASSES_SENTINEL_FIRST = 0x8d;

/** Parse the classes section. Tolerant: returns what it could read. */
export const readClasses = (
  section: Uint8Array, version: FileVersion, codepage?: string
): Map<number, DwgClassInfo> => {
  const out = new Map<number, DwgClassInfo>();
  const v = versionRank(version);
  try {
    let p = 0;
    if (section[0] === CLASSES_SENTINEL_FIRST) p = 16;   /* skip sentinel */
    const dv = new DataView(section.buffer, section.byteOffset, section.byteLength);
    const size = dv.getUint32(p, true);
    p += 4;

    let bitEnd: number;
    let strings: BitReader | null = null;
    if (v >= 2007) {
      /* R2010+ may write an extra RL (high dword of a 64-bit size, ~always
         0) before the RL bitsize; presence depends on the file's maint
         version, so detect it by which RL is plausible as the bitsize of a
         `size`-byte data area. */
      const plausible = (x: number): boolean =>
        x > 0 && x <= size * 8 && x >= size * 8 - 512;
      if (v >= 2010 && !plausible(dv.getUint32(p, true))
          && plausible(dv.getUint32(p + 4, true))) {
        p += 4;                          /* skip hsize */
      }
      /* bitsize counts the class data area (records + string stream) from
         the START of the bitsize field itself; the trailing flag bit of the
         string stream sits at its last bit. */
      const bitsizeFieldBit = p * 8;
      const bitsize = dv.getUint32(p, true);
      p += 4;
      const endBit = bitsizeFieldBit + bitsize - 1;
      const probe = new BitReader(section, endBit);
      if (probe.b()) {
        let pos = endBit - 16;
        probe.pos = pos;
        let strSize = probe.rs();
        if (strSize & 0x8000) {
          pos -= 16;
          probe.pos = pos;
          const hi = probe.rs();
          strSize = (strSize & 0x7fff) | (hi << 15);
        }
        strings = new BitReader(section, pos - strSize, endBit);
      }
      bitEnd = endBit;
    } else {
      bitEnd = (p + size) * 8 - 8;       /* leave room for CRC */
    }

    const r = new BitReader(section, p * 8);
    /* R2004+ prefixes the records with BS max class number + RS 0 + B 1;
       the record count follows from it (numbers run 500..max). R13-R2000
       has no prefix and no count — records run until size is exhausted. */
    let remaining = Infinity;
    if (v >= 2004) {
      const maxNum = r.bs();
      r.rc(); r.rc(); r.b();
      if (maxNum < 500 || maxNum > 5000) return out;
      remaining = maxNum - 499;
    }

    const text = (): string => {
      if (strings) return strings.tu();
      return decodeCodepage(r.tBytes(), codepage);
    };

    while (remaining-- > 0 && r.pos + 20 < bitEnd) {
      const classNum = r.bs();
      r.bs();                            /* proxy capability flags */
      const appName = text();
      const cppName = text();
      const dxfName = text();
      r.b();                             /* was-a-proxy flag */
      const itemClass = r.bs();
      let dwgVersion: number | undefined, maintVersion: number | undefined;
      if (v >= 2004) {
        /* The record tail is FIVE bitlongs: instance count, dwg version,
           maintenance version, and two unknowns. For values 0..255 a BS
           and a BL encode identically, which long hid the difference —
           real AutoCAD 2027 files carry MLEADERSTYLE maint = 427, where
           the old BS read (16-bit payload) misaligned every record after
           it. Reading BLs accepts both spellings for small values. */
        r.bl();                          /* number of instances */
        dwgVersion = r.bl(); maintVersion = r.bl();   /* dwg/maint version pair */
        r.bl(); r.bl();                  /* two unknowns */
      }
      if (classNum < 500 || classNum > 5000 || !dxfName) break;
      out.set(classNum, {
        classNum, dxfName, cppName, appName,
        isEntity: itemClass === 0x1f2,
        ...(dwgVersion !== undefined ? { dwgVersion, maintVersion } : {})
      });
    }
  } catch {
    /* keep whatever parsed; unknown classes decode as 'unknown' objects */
  }
  return out;
};
