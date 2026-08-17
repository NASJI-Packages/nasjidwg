/* Pins for reader behaviours proven against real AutoCAD 2027 output
 * (campaign 5: a 30-file corpus minted via accoreconsole — three family
 * drawings x 7 container versions plus variation refs — cross-checked
 * field-by-field against AutoCAD's own DXFOUT of the same drawings).
 *
 * The fixtures here are synthetic round trips: the writer emits the same
 * grammar the real files carry, so these lock both sides at once. The
 * real-file evidence itself is recorded in the comments. */
import { describe, expect, it } from 'vitest';
import { emptyDrawing, readDwg, writeDwg2000, writeDwg2007, writeDwg2018 } from '../src/index.js';
import type { Drawing, Entity } from '../src/index.js';
import { dwgOf } from './corpus.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { decodeObjectBody, makeContext } from '../src/dwg/objects.js';
import { versionRank } from '../src/dwg/fileheader.js';

const line = (over: Partial<Entity & { type: 'line' }> = {}): Entity => ({
  type: 'line', layer: '0', color: { kind: 'byLayer' },
  start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 5, z: 0 }, ...over
} as Entity);

describe('real-world reader pins (campaign 5)', () => {
  it('R2007 ACAD_TABLE: the 2007-only per-cell extras round-trip', () => {
    /* AutoCAD-2027-minted 2007 tables carry a BD (1.0) after each cell's
       rotation and close each cell with three BLs (3,0,0) — solved by
       brute force against 2x4 and 3x4 real grids until every cell decoded
       with the title-row merge pattern and the stream landed exactly on
       the four tail bits. The writer emits the same spelling at 2007, and
       the reader's strict pass must accept it. */
    const d: Drawing = emptyDrawing();
    d.entities.push({
      type: 'table', layer: '0', color: { kind: 'byLayer' },
      position: { x: 1, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 },
      numRows: 3, numColumns: 2,
      rowHeights: [0.5, 0.4, 0.4], columnWidths: [2.5, 2.5],
      cells: [
        { text: 'Title', spanColumns: 2 }, {},
        { text: 'A' }, { text: 'B' },
        { text: 'C1' }, {}
      ]
    } as Entity);
    const bytes = writeDwg2007(d).data;
    const back = readDwg(bytes);
    const t = back.entities.find((e) => e.type === 'table');
    expect(t?.type).toBe('table');
    if (t?.type !== 'table') return;
    expect(t.numRows).toBe(3);
    expect(t.numColumns).toBe(2);
    expect(t.cells[0].spanColumns).toBe(2);
    expect(t.cells[0].text).toBe('Title');
    expect(t.cells[3].text).toBe('B');
    expect(back.warnings).toEqual([]);
  });

  it('anonymous block stems number from 1, the way AutoCAD displays them', () => {
    /* Real DWGs store every anonymous block as its bare stem ("*D" + NUL
       for each of six dimension blocks in one AutoCAD 2027 file); the
       numbers exist only at load time, and AutoCAD's DXFOUT of the same
       drawing names them *D1..*D6 — so the first stem takes 1, not the
       bare name. */
    const d: Drawing = emptyDrawing();
    d.blocks['*D'] = { name: '*D', entities: [line()] };
    d.entities.push({
      type: 'insert', layer: '0', color: { kind: 'byLayer' },
      blockName: '*D', position: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }, rotation: 0
    } as Entity);
    const back = readDwg(writeDwg2018(d).data);
    expect(Object.keys(back.blocks)).toContain('*D1');
    expect(Object.keys(back.blocks)).not.toContain('*D');
    const ins = back.entities.find((e) => e.type === 'insert');
    expect(ins && 'blockName' in ins ? ins.blockName : '').toBe('*D1');
  });

  it('R2010+ ACAD_TABLE: the inline TABLECONTENT form round-trips', () => {
    /* AutoCAD 2010+ folds the grid into the entity itself. The writer's
       spelling of that record — block-reference prologue, twelve constant
       bits, content, merges, direction, five-field break range — opens
       AUDIT-clean in AutoCAD 2027 and its DXFOUT returns every cell text
       (verified externally in campaign 5). This pins both directions. */
    const d: Drawing = emptyDrawing();
    d.entities.push({
      type: 'table', layer: '0', color: { kind: 'byLayer' },
      position: { x: 5, y: 10, z: 0 }, direction: { x: 1, y: 0, z: 0 },
      numRows: 3, numColumns: 2,
      rowHeights: [0.5, 0.4, 0.4], columnWidths: [3, 2.5],
      cells: [
        { text: 'Title', spanColumns: 2 }, {},
        { text: 'A' }, { text: 'B' },
        { text: 'C' }, {}
      ]
    } as Entity);
    const back = readDwg(writeDwg2018(d).data);
    const t = back.entities.find((e) => e.type === 'table');
    expect(t?.type).toBe('table');
    if (t?.type !== 'table') return;
    expect(t.numRows).toBe(3);
    expect(t.numColumns).toBe(2);
    expect(t.position).toEqual({ x: 5, y: 10, z: 0 });
    expect(t.cells[0].text).toBe('Title');
    expect(t.cells[0].spanColumns).toBe(2);
    expect(t.cells[3].text).toBe('B');
    expect(back.warnings).toEqual([]);
  });

  it('ByBlock linetype survives the R2000+ two-bit shortcut', () => {
    /* Entity linetype flags at R2000+: 0 ByLayer, 1 ByBlock, 2 Continuous,
       3 handle. AutoCAD's own table-grid block lines carry flag 1
       (verified against its DXFOUT); the reader used to drop it. */
    for (const write of [writeDwg2000, writeDwg2018]) {
      const d: Drawing = emptyDrawing();
      d.entities.push(line({ linetype: 'ByBlock' }));
      const back = readDwg(write(d).data);
      const l = back.entities.find((e) => e.type === 'line');
      expect(l?.linetype).toBe('ByBlock');
    }
  });

  it('R2018 AcDs: the ASM payload comes back marker-delimited (round 7)', () => {
    /* AutoCAD 2027 refuses every pre-ASM "ACIS BinaryFile" payload but
       opens the corpus's minimal hand-built ASM stream in the AcDs slot
       with AUDIT 0/0. The slot is zero-filled past the trailer, and the
       readers bound the stream at End-of-ASM-data, so what returns is
       exactly the stream up to and including the trailer — the slot
       padding never reaches the model. */
    const back = readDwg(dwgOf('R2018'));
    const solid = back.entities.find((e) => e.type === 'acis');
    expect(solid && 'sab' in solid && solid.sab).toBeTruthy();
    const blob = Uint8Array.from(
      atob((solid as Entity & { type: 'acis' }).sab ?? ''),
      (c) => c.charCodeAt(0));
    expect(String.fromCharCode(...blob.subarray(0, 15)))
      .toBe('ASM BinaryFile4');
    /* …\x0e ASM \x0d \x04 data closes the stream */
    expect(String.fromCharCode(...blob.subarray(blob.length - 11)))
      .toBe('\x0e\x03ASM\x0d\x04data');
  });
});

/* ------------------------------------------------------------------ *
 * Campaign 6 — pins from the real-world reader certification sweep.
 *
 * 317 externally produced files (118 Autodesk AC1021 samples, 58 field
 * drawings up to 3 MB, the libredwg and ACadSharp corpora, 1982 to 2027)
 * were read with CRC checking on. Nothing threw, but instrumenting the
 * two places the decoder swallows exceptions showed it had absorbed 332
 * of them across 167 files and silently sealed those records. The
 * defects that exposed are pinned below with records built byte by byte
 * here — no external file is ever read by the suite.
 * ------------------------------------------------------------------ */

type RecVersion = 'R13' | 'R14' | 'R2000' | 'R2004' | 'R2007' | 'R2010'
  | 'R2013' | 'R2018';

/** The common preamble every non-control object record opens with: type,
 *  handle, empty EED, the R13/R14 handle-stream position, reactor count,
 *  and (2004+) the "no extension dictionary" bit. The bitsize fields are
 *  patched once the body closes, exactly as the writer does it. */
const objectRecord = (
  version: RecVersion, type: number,
  body: (w: BitWriter) => void, handles: (w: BitWriter) => void
): Uint8Array => {
  const v = versionRank(version);
  const w = new BitWriter();
  if (v >= 2010) { w.bb(0); w.rc(type); } else w.bs(type);
  let sizePos = -1;
  if (v >= 2000 && v <= 2007) { sizePos = w.pos; w.rl(0); }
  w.h(0, 0x40);                            /* object handle */
  w.bs(0);                                 /* no EED */
  let r13Size = -1;
  if (v <= 14) { r13Size = w.pos; w.rl(0); }
  w.bl(0);                                 /* reactors */
  if (v >= 2004) w.b(1);                   /* xdict missing */
  if (v >= 2013) w.b(0);                   /* has_ds_data */
  body(w);
  const bitsize = w.pos;
  if (sizePos >= 0) w.patchRl(sizePos, bitsize);
  if (r13Size >= 0) w.patchRl(r13Size, bitsize);
  w.h(4, 0);                               /* owner */
  if (v < 2004) w.h(3, 0);                 /* xdict */
  handles(w);
  return w.bytes();
};

const ctx = (version: RecVersion) => makeContext(version, new Map());

describe('reader pins from the real-world sweep (campaign 6)', () => {
  it('R13 dictionaries have no hard-owner byte; R14 and later do', () => {
    /* 61 of the 71 dictionaries in the vintage AC1012 reference were
       failing to decode and being sealed, because the hard-owner RC that
       arrives with R13c3 was read unconditionally: the stray byte shifts
       every entry name and the string lengths come out as garbage. Same
       byte on the write side made every R13 file we ever produced fail
       to load in AutoCAD. */
    const names = ['ACAD_GROUP', 'ACAD_MLINESTYLE'];
    const body = (hardOwner: boolean) => (w: BitWriter): void => {
      w.bl(names.length);
      if (hardOwner) w.rc(0);
      for (const n of names) w.t(n);
    };
    const refs = (w: BitWriter): void => { w.h(2, 9); w.h(2, 10); };
    const r13 = decodeObjectBody(
      objectRecord('R13', 42, body(false), refs), ctx('R13'));
    expect(r13?.dictionary?.names).toEqual(names);
    const r14 = decodeObjectBody(
      objectRecord('R14', 42, body(true), refs), ctx('R14'));
    expect(r14?.dictionary?.names).toEqual(names);
    /* and the gate is real: the R14 spelling read as R13 does not decode */
    const wrong = decodeObjectBody(
      objectRecord('R13', 42, body(true), refs), ctx('R13'));
    expect(wrong?.dictionary?.names).not.toEqual(names);
  });

  it('MLINESTYLE linetypes are an index through R2013 and handles at R2018', () => {
    /* Every one of the 155 genuine AC1021/AC1024/AC1027 files in the
       sweep carries the per-element linetype as a BSd index in the data
       stream and nothing in the handle stream. Asking the handle stream
       for it left one or two bits, threw, and sealed the record — so
       drawing.mlineStyles came back empty for every 2007/2010/2013 file
       and MLINE entities lost their style. */
    const offsets = [0.5, -0.5];
    const mline = (indexForm: boolean) => (w: BitWriter): void => {
      w.t('STANDARD');
      w.t('');
      w.bs(0);                             /* flags */
      w.bs(256);                           /* fill colour: ByLayer */
      w.bd(Math.PI / 2); w.bd(Math.PI / 2);
      w.rc(offsets.length);
      for (const off of offsets) {
        w.bd(off);
        w.bs(256);
        if (indexForm) w.bs(32767);        /* BYLAYER linetype index */
      }
    };
    /* hand-built records for the containers that keep strings and
       colours inline (the 2004+ CMC and the 2007+ string stream would
       only obscure the field under test) */
    for (const v of ['R13', 'R14', 'R2000'] as const) {
      const raw = decodeObjectBody(
        objectRecord(v, 73, mline(true), () => { }), ctx(v));
      expect(raw?.mlineStyle?.elements.map((e) => e.offset), v).toEqual(offsets);
    }
    /* and the whole path holds end to end in every container we write —
       including R2018, where the same two linetypes travel as handles */
    for (const [make, label] of [
      [writeDwg2000, 'R2000'], [writeDwg2007, 'R2007'], [writeDwg2018, 'R2018']
    ] as const) {
      const back = readDwg(make(emptyDrawing()).data);
      expect(back.mlineStyles?.[0]?.elements.map((e) => e.offset), label)
        .toEqual(offsets);
    }
  });

  it('an XRECORD that overstates its size keeps the values it really has', () => {
    /* One Autodesk sample declares more bytes than its record holds. The
       loop guard was satisfied while the bit reader was not, so the
       overrun threw and every already-parsed value went with it. */
    const rec = objectRecord('R2000', 79, (w) => {
      w.bl(4096);                          /* a wildly overstated size */
      w.rs(1);                             /* group code 1: a string */
      w.rs(2); w.rc(0); w.rc(0x41); w.rc(0x42);   /* len, codepage, "AB" */
    }, () => { });
    const raw = decodeObjectBody(rec, ctx('R2000'));
    expect(raw?.unknownObject).toBeUndefined();
    expect((raw?.xrecord?.values.length ?? 0)).toBeGreaterThan(0);
  });
});

describe('tolerant model guards (campaign 6)', () => {
  it('drops header extents that are not finite in every component', () => {
    /* Three field drawings ship an EXTMAX Z of 7.35e+223 or 7.88e+276
       beside sane X and Y, and pre-R13 files use +-1e20 as the "never
       set" sentinel. The old guard looked at X and Y only, so the poison
       reached drawing.header and any 3-D bounds built on it. */
    const d = emptyDrawing();
    d.header.extMin = { x: 0, y: 0, z: 0 };
    d.header.extMax = { x: 10, y: 10, z: 7.35e+223 };
    const back = readDwg(writeDwg2000(d).data);
    expect(back.header.extMax).toBeUndefined();
    expect(back.header.extMin).toBeUndefined();
    /* a sane pair still survives the same path */
    d.header.extMax = { x: 10, y: 10, z: 3 };
    expect(readDwg(writeDwg2000(d).data).header.extMax?.z).toBe(3);
  });

  it('a block whose entities are reachable still round-trips silently', () => {
    /* Control for the orphan-recovery branch: an entity owned by a block
       header that really exists must go on landing in its block, not in
       model space, and must not raise the new warning. */
    const d = emptyDrawing();
    d.blocks = {
      GONE: {
        name: 'GONE', basePoint: { x: 0, y: 0, z: 0 },
        entities: [line({ start: { x: 1, y: 1, z: 0 } })]
      }
    };
    d.entities.push({
      type: 'insert', layer: '0', color: { kind: 'byLayer' },
      blockName: 'GONE', position: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }, rotation: 0
    } as Entity);
    const back = readDwg(writeDwg2000(d).data);
    expect(back.warnings).toEqual([]);
    expect(back.blocks?.GONE?.entities.length).toBe(1);
  });
});

describe('extra paper-space layouts (campaign 6)', () => {
  /* DWG gives every extra layout its own BLOCK_HEADER, and they are all
     literally named *Paper_Space — only the single paperSpaceHandle feeds
     drawing.paperSpace, so the reader used to drop the rest by name and
     lose their geometry. Measured on the real-world corpus: 392 entities
     across 46 files, including 65 in one Autodesk Sheet Set drawing
     (Site Grading Plan: four layout headers, only 58 of 123 entities
     survived) and 163 in one ACadSharp sample with nine layouts; sixteen
     DesignCenter files each lost the two VIEWPORTs that make their sheet
     render at all. The reader now keeps any such block that carries
     entities — a block is only drawn where something INSERTs it, so
     nothing is invented and nothing is lost.
     The writer refuses to emit a *Paper_Space-named block on purpose
     (writer.ts filters them out of userBlocks), so the recovery half
     cannot be expressed as a round trip; what the suite can hold is the
     other half — that the empty spaces every file carries still stay out
     of drawing.blocks, and the primary paper space still routes to
     drawing.paperSpace. */
  it('still routes the primary paper space and hides the empty spaces', () => {
    const d = emptyDrawing();
    d.paperSpace = [line({ start: { x: 9, y: 9, z: 0 } })];
    d.blocks = {
      REAL: {
        name: 'REAL', basePoint: { x: 0, y: 0, z: 0 },
        entities: [line({ end: { x: 3, y: 4, z: 0 } })]
      }
    };
    const back = readDwg(writeDwg2000(d).data);
    expect(back.paperSpace?.length).toBe(1);
    expect(back.blocks?.REAL?.entities.length).toBe(1);
    for (const name of Object.keys(back.blocks ?? {})) {
      expect(name).not.toMatch(/^\*(model_space|paper_space)/i);
    }
    expect(back.warnings).toEqual([]);
  });
});
