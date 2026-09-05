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
  it('R2007 ACAD_TABLE: the cell is a table VALUE, not a bare string', () => {
    /* AC1021 keeps a cell's content as a full table value — the
       additional-data flag, then the format flags, the data type, the text
       inline as byte-counted UTF-16, the unit type, and two string-stream
       entries (the value's format string and its rendered form). Writing a
       single string there is what AutoCAD had been refusing.
       Pinned against AutoCAD-minted AC1021 tables: each 1-character cell
       is 109 bits, the walk lands on the four override bits exactly, and
       AutoCAD reads our output back as 2 rows x 2 columns with the cell
       text intact. */
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
    const res = writeDwg2007(d);
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const t = back.entities.find((e) => e.type === 'table');
    expect(t?.type).toBe('table');
    if (t?.type !== 'table') return;
    expect(t.numRows).toBe(3);
    expect(t.numColumns).toBe(2);
    expect(t.cells[0].spanColumns).toBe(2);
    expect(t.cells[0].text).toBe('Title');
    expect(t.cells[3].text).toBe('B');
    expect(t.cells[4].text).toBe('C1');
    expect(back.warnings).toEqual([]);
  });

  it('the inline ACAD_TABLE grid round-trips in the containers that take it', () => {
    /* The same grid at R2000, where AutoCAD 2027 opens our output at
       AUDIT 0 — so the cell walk, the span pattern and the four
       override-presence tail bits are pinned on both sides. */
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
    const back = readDwg(writeDwg2000(d).data);
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
    expect((raw?.xrecord?.values.length ?? 0)).toBeGreaterThan(0);
    /* decoded, not failed: the seal beside the values is the dual one an
       XRECORD always carries now (the record travels under its owner) */
    expect(raw?.unknownObject?.typeCode).toBe(79);
    expect(raw?.unknownObject?.data).toBeDefined();
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

/* ------------------------------------------------------------------ */

describe('pre-2010 ACAD_TABLE cells in the reference\'s own grammar', () => {
  /* Pinned against the reference's own tables — the 32x12 door schedule,
     the 28x14 room-finish schedule with a block cell and the 7x8 legend of
     the A-03 sheet, plus two block-and-text grids of the mechanical sample
     — each as it saved them to 2000, 2004 and 2007: every record walks to
     its last data bit with every handle and string-stream entry consumed,
     and every cell's text, span and block matches its DXF of the drawing.
     Two misreadings had sealed all of them: a block cell's attribute flag
     was taken for its override flag, and the R2007 value (extended flags,
     format flags, data type, data, unit type, two strings) was expected
     ahead of the overrides instead of after them. The record below is the
     smallest grid that exercises all of it. */
  const TABLE_CLASS = 500;
  const tableCtx = (version: RecVersion) => makeContext(version, new Map([[TABLE_CLASS, {
    classNum: TABLE_CLASS, dxfName: 'ACAD_TABLE', cppName: 'AcDbTable',
    appName: 'ObjectDBX Classes', isEntity: true
  }]]));

  const tableRecord = (version: 'R2000' | 'R2007'): Uint8Array => {
    const v = versionRank(version);
    const w = new BitWriter();
    const sw = v >= 2007 ? new BitWriter() : null;
    const str = (s: string): void => { if (sw) sw.tu(s); else w.t(s); };
    w.bs(TABLE_CLASS);
    const sizeAt = w.pos;
    w.rl(0);                              /* bitsize, patched below */
    w.h(0, 0x40);                         /* handle */
    w.bs(0);                              /* no EED */
    w.b(0);                               /* no graphics */
    w.bb(2);                              /* entmode: model space */
    w.bl(0);                              /* reactors */
    w.b(1);                               /* nolinks (2000) / xdict missing */
    w.bs(256);                            /* colour: bylayer */
    w.bd(1);                              /* ltype scale */
    w.bb(0); w.bb(0);                     /* ltype, plotstyle flags */
    if (v >= 2007) { w.bb(0); w.rc(0); }  /* material, shadow */
    w.bs(0);                              /* invisible */
    w.rc(29);                             /* lineweight: bylayer */
    /* AcDbBlockReference */
    w.bd3(1, 2, 0); w.bb(3); w.bd(0); w.bd3(0, 0, 1); w.b(0);
    /* AcDbTable: 2 rows x 2 columns */
    w.bs(22); w.bd3(1, 0, 0); w.bl(2); w.bl(2);
    w.bd(3); w.bd(4); w.bd(0.5); w.bd(0.6);
    const head = (type: number, merged: number, cols: number, rows: number): void => {
      w.bs(type); w.rc(0); w.b(merged); w.b(0); w.bl(cols); w.bl(rows); w.bd(0);
    };
    /* the R2007 value: as a "general" blob (the 2007-era files), as a
       string with the rendered text in the string stream (the re-saves),
       or absent */
    const value = (text: string | null, form: 'blob' | 'string' = 'blob'): void => {
      if (!sw) return;
      w.bl(0);                            /* extended cell flags */
      if (text === null) { w.bl(1); w.bl(4); w.bl(0); str(''); str(''); return; }
      w.bl(6);
      const utf16 = (s: string): void => {
        for (const ch of s) { w.rc(ch.charCodeAt(0) & 0xff); w.rc(ch.charCodeAt(0) >> 8); }
        w.rc(0); w.rc(0);
      };
      if (form === 'blob') { w.bl(512); w.bl((text.length + 1) * 2); utf16(text); }
      else { w.bl(4); w.bs((text.length + 1) * 2); utf16(text); }
      w.bl(0);                            /* unit type */
      str('');                            /* format string */
      str(form === 'blob' ? '' : text);   /* rendered text */
    };
    /* cell 0: the title across both columns, with alignment, text style
       and height overrides */
    head(1, 0, 2, 1); if (!sw) str('Title');
    w.b(1); w.bl(0x31); w.rc(0); w.bs(5); w.bd(0.25);
    value('Title');
    /* cell 1: merged away */
    head(1, 1, 1, 1); if (!sw) str(''); w.b(0); value(null);
    /* cell 2: a block with one attribute value, then a left-edge override
       group (colour, lineweight -1, visibility) */
    head(2, 0, 1, 1); w.bd(1); w.b(1); w.bs(1); w.bs(0); str('A-1');
    w.b(1); w.bl(0x62200); w.rc(0); w.bs(1); w.bl(1); w.rc(0); w.bs(0xffff); w.bs(1);
    value(null);
    /* cell 3: plain text */
    head(1, 0, 1, 1); if (!sw) str('Data'); w.b(0); value('Data', 'string');
    /* the tail: title and header suppressed, no border overrides */
    w.b(1); w.bl(3); w.b(1); w.b(0); w.b(0); w.b(0);
    if (sw) { w.appendBits(sw); w.rs(sw.pos); w.b(1); }
    w.patchRl(sizeAt, w.pos);
    /* handles: the common ones, then block header and table style, then
       per cell — text style (+ override style), or block + attdef */
    if (v < 2004) w.h(3, 0);              /* xdict */
    w.h(5, 0x10);                         /* layer */
    w.h(5, 0x50); w.h(5, 0x51);
    w.h(5, 0x52); w.h(5, 0x53);
    w.h(5, 0x52);
    w.h(5, 0x60); w.h(5, 0x61);
    w.h(5, 0x52);
    w.align();
    return w.bytes();
  };

  it.each(['R2000', 'R2007'] as const)('%s: block cells, overrides and the tail all land', (version) => {
    const raw = decodeObjectBody(tableRecord(version), tableCtx(version));
    const e = raw?.entity;
    expect(e?.type).toBe('table');
    if (e?.type !== 'table') return;
    expect([e.numRows, e.numColumns]).toEqual([2, 2]);
    expect(e.columnWidths).toEqual([3, 4]);
    expect(e.rowHeights).toEqual([0.5, 0.6]);
    expect(e.cells[0]).toMatchObject({
      contentType: 1, text: 'Title', spanColumns: 2, alignment: 5, textHeight: 0.25
    });
    expect(e.cells[1].text).toBeUndefined();
    expect(e.cells[2].contentType).toBe(2);
    expect(e.cells[3].text).toBe('Data');
    expect(raw?.tableBlock).toBe(0x50);
    expect(raw?.tableCellBlocks?.get(2)).toBe(0x60);
  });
});
