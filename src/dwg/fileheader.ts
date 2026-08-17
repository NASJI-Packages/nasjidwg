/* nasjidwg — DWG file header: version detection and the R13-R2000
 * section locator table.
 *
 * R13-R2000 files locate their sections through a flat table right after
 * the header: (id RC, address RL, size RL) records. R2004+ replaced this
 * with compressed page/section maps (see sections2004.ts / sections2007.ts).
 */

import type { FileVersion } from '../core/model.js';

const MAGIC_TO_VERSION: Record<string, FileVersion> = {
  /* the releases before R13 each had their own signature */
  'MC0.0': 'R1.1', 'AC1.2': 'R1.2', 'AC1.3': 'R1.3', 'AC1.40': 'R1.4',
  'AC1.50': 'R2.0', 'AC2.10': 'R2.10', 'AC2.21': 'R2.21', 'AC2.22': 'R2.22',
  AC1001: 'R2.4', AC1002: 'R2.5', AC1003: 'R2.6',
  AC1004: 'R9', AC1005: 'R9', AC1006: 'R10',
  AC1007: 'R12', AC1008: 'R12', AC1009: 'R12',
  AC1012: 'R13', AC1014: 'R14', AC1015: 'R2000', AC1018: 'R2004',
  AC1021: 'R2007', AC1024: 'R2010', AC1027: 'R2013', AC1032: 'R2018'
};

/** Numeric rank for version comparisons (pre-R13 releases sort below 13). */
export const versionRank = (v: FileVersion): number => ({
  'R1.1': 1, 'R1.2': 1.2, 'R1.3': 1.3, 'R1.4': 1.4,
  'R2.0': 2, 'R2.10': 2.1, 'R2.21': 2.21, 'R2.22': 2.22,
  'R2.4': 2.4, 'R2.5': 2.5, 'R2.6': 2.6,
  R9: 9, R10: 10, R12: 12,
  R13: 13, R14: 14, R2000: 2000, R2004: 2004, R2007: 2007,
  R2010: 2010, R2013: 2013, R2018: 2018
})[v];

export const detectVersion = (data: Uint8Array): FileVersion => {
  const magic = String.fromCharCode(...data.subarray(0, 6));
  /* the oldest signatures are five characters, the rest six */
  const v = MAGIC_TO_VERSION[magic] ?? MAGIC_TO_VERSION[magic.slice(0, 5)];
  if (!v) throw new Error(`Not a supported DWG file (magic "${magic}").`);
  return v;
};

export interface SectionLocator { id: number; address: number; size: number }

export interface FileHeaderR2000 {
  codepage: string | undefined;
  /** By convention: 0 header vars, 1 classes, 2 handles (object map),
   *  3 ObjFreeSpace, 4 Template, 5 AuxHeader. */
  sections: SectionLocator[];
}

/** The header stores the drawing's codepage as a small integer. Names are
 *  the ones DXF's $DWGCODEPAGE spells, so a file converted either way keeps
 *  the same label. The numbering runs in three regular stretches — the ISO
 *  8859 parts, the DOS pages, the Windows pages — with a handful of
 *  one-offs scattered between them, so it is built rather than listed. */
const CODEPAGE_NAMES: Record<number, string> = (() => {
  const names: Record<number, string> = {
    0: 'UTF8', 1: 'US_ASCII', 23: 'MAC_ROMAN', 24: 'BIG5', 25: 'CP949',
    26: 'JOHAB', 27: 'CP866', 31: 'GB2312', 43: 'UTF16'
  };
  for (let part = 1; part <= 9; part++) names[part + 1] = `ISO8859_${part}`;
  [437, 850, 852, 855, 857, 860, 861, 863, 864, 865, 869, 932]
    .forEach((page, i) => { names[11 + i] = `CP${page}`; });
  ([[28, 1250], [29, 1251], [30, 1252], [32, 1253], [33, 1254], [34, 1255],
    [35, 1256], [36, 1257], [37, 874], [38, 932], [39, 936], [40, 949],
    [41, 950], [42, 1361], [44, 1258]] as const)
    .forEach(([at, page]) => { names[at] = `ANSI_${page}`; });
  return names;
})();

export const codepageName = (num: number): string =>
  CODEPAGE_NAMES[num] ?? ('CP' + num);

/** Parse the R13-R2000 fixed header (starts right after the 6-byte magic). */
export const readFileHeaderR2000 = (data: Uint8Array): FileHeaderR2000 => {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  /* layout: 0x0B maint RC, 0x0C one RC, 0x0D thumbnail RL, 0x11 dwg_ver RC,
     0x12 maint_ver RC, 0x13 codepage RS, 0x15 section count RL, 0x19 records */
  const codepage = codepageName(dv.getUint16(0x13, true));
  const count = dv.getUint32(0x15, true);
  if (count > 16) throw new Error(`Implausible DWG section count ${count}`);
  const sections: SectionLocator[] = [];
  let p = 0x19;
  for (let i = 0; i < count; i++) {
    sections.push({
      id: data[p],
      address: dv.getUint32(p + 1, true),
      size: dv.getUint32(p + 5, true)
    });
    p += 9;
  }
  return { codepage, sections };
};
