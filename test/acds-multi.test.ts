/* nasjidwg — every solid's SAB rides the R2018 AcDs section.
 *
 * AC1032 keeps ACIS payloads in the AcDb:AcDsPrototype_1b section, one
 * data record per solid. The writer used to put only the FIRST solid
 * there and spell the rest inline — a form AutoCAD 2027 refuses
 * (ErrorStatus 53 at open with two solids, a fatal regen error with
 * dozens). The multi-record spelling — 20-byte directory entries, the
 * payload cells packed back to back, one datidx entry per record and
 * the search keys sorted by handle — was read off AutoCAD's own
 * two-solid 2018 save and is pinned here structurally, plus the
 * round trip: N solids in, the same N blobs bound back in order.
 */

import { describe, expect, it } from 'vitest';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { readAcDsSabBlobs } from '../src/dwg/meta.js';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

/** A synthetic ASM-dialect blob the AcDs machinery can carry: the "ASM
 *  BinaryFile" magic, a distinguishing filler, and the end-of-data
 *  marker the extractor bounds records with. */
const END_ASM = '\x0e\x03End\x0e\x02of\x0e\x03ASM\r\x04data';
const asmBlob = (tag: string): string => {
  const text = 'ASM BinaryFile synthetic ' + tag + ' ' + END_ASM;
  let b64 = '';
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  const CH =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    b64 += CH[a >> 2] + CH[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (i + 1 < bytes.length ? CH[(((b ?? 0) & 15) << 2) | ((c ?? 0) >> 6)] : '=')
      + (i + 2 < bytes.length ? CH[(c ?? 0) & 63] : '=');
  }
  return b64;
};

const solids = (n: number): Drawing => {
  const d = emptyDrawing();
  d.entities = Array.from({ length: n }, (_, i): Entity => ({
    type: 'acis', layer: '0', color: { kind: 'byLayer' },
    kind: i % 2 ? 'region' : 'solid3d', sab: asmBlob('S' + i)
  }));
  return d;
};

describe('R2018 multi-solid AcDs', () => {
  it('three solids: three AcDs records, three blobs back in order', () => {
    const bytes = writeDwg2018(solids(3)).data;
    const sections = readSections2004(bytes);
    const ds = [...sections].find(([n]) => n.startsWith('AcDb:AcDs'));
    expect(ds).toBeDefined();
    const blobs = readAcDsSabBlobs(ds![1]);
    expect(blobs).toEqual([asmBlob('S0'), asmBlob('S1'), asmBlob('S2')]);
    const back = readDwg(bytes);
    const sabs = back.entities
      .filter((e) => e.type === 'acis')
      .map((e) => e.type === 'acis' ? e.sab : undefined);
    expect(sabs).toEqual([asmBlob('S0'), asmBlob('S1'), asmBlob('S2')]);
  });

  it('the section carries the multi-record directory AutoCAD writes', () => {
    const bytes = writeDwg2018(solids(2)).data;
    const s = [...readSections2004(bytes)]
      .find(([n]) => n.startsWith('AcDb:AcDs'))![1];
    const u16 = (o: number): number => s[o] | (s[o + 1] << 8);
    const u32 = (o: number): number =>
      (s[o] | (s[o + 1] << 8) | (s[o + 2] << 16)) + s[o + 3] * 0x1000000;
    const u64 = (o: number): number => u32(o) + u32(o + 4) * 0x100000000;
    /* walk segments off the 0x80 grid */
    const segs = new Map<string, number>();
    for (let at = 0x80; at + 48 <= s.length;) {
      if (u16(at) !== 0xd5ac) { at += 0x80; continue; }
      const name = String.fromCharCode(...s.subarray(at + 2, at + 8))
        .replace(/\0.*$/, '');
      if (!segs.has(name)) segs.set(name, at);
      const size = u64(at + 16);
      at += size > 0 ? size : 0x80;
    }
    /* datidx: two records, directory entries 20 bytes apart */
    const di = segs.get('datidx')! + 48;
    expect(u64(di)).toBe(2);
    expect(u32(di + 8 + 4)).toBe(0);      /* record 0 at offset 0 */
    expect(u32(di + 20 + 4)).toBe(20);    /* record 1 at offset 20 */
    /* _data_: entry i names handle i's solid and its packed cell */
    const da = segs.get('_data_')! + 48;
    const h0 = u64(da + 8);
    const cell0 = u32(da + 16);
    const h1 = u64(da + 20 + 8);
    const cell1 = u32(da + 20 + 16);
    expect(h1).toBeGreaterThan(h0);       /* fresh handles ascend */
    expect(cell0).toBe(0);
    /* cells are packed: the second starts right after [len, bytes] */
    const cellsAt = da + Math.ceil((2 * 20) / 16) * 16;
    expect(cell1).toBe(4 + u32(cellsAt + cell0));
    /* search: one table, both handles as sorted keys */
    const se = segs.get('search')! + 48;
    expect(u32(se)).toBe(1);              /* one table */
    const nrec = u64(se + 8);
    expect(nrec).toBe(2);
    const keysAt = se + 8 + 8 + Number(nrec) * 8 + 8;
    expect(u32(keysAt)).toBe(2);          /* two keys */
    expect(u64(keysAt + 4)).toBe(h0);     /* sorted ascending */
    expect(u64(keysAt + 4 + 24)).toBe(h1);
  });
});
