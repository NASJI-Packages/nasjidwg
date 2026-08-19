/* nasjidwg — the test corpus, generated rather than shipped.
 *
 * Every fixture the suite reads is produced here, at test time, by this
 * library's own writers. Nothing is checked in and nothing is downloaded:
 * a clone plus `npm test` reproduces the whole corpus byte for byte, on
 * any machine, forever.
 *
 * The drawing below is deliberately awkward. It carries at least one of
 * every entity the writers can emit, an accented layer name, Arabic text
 * that has to survive an escape round-trip, a block with an attribute, a
 * hatch with its own pattern definition, a spline with explicit knots, and
 * both flavours of mesh — so a version that mangles any one of them fails
 * loudly instead of quietly writing a smaller file.
 *
 * What this cannot cover is the read path for the one release nasjidwg
 * does not write (the R1.x line) and objects its writers do not emit.
 * Those are exercised by whatever files you point it at. The pre-R12
 * writers have their own suite in dwg-write-pre13.test.ts, and proxy,
 * OLE and dynamic-block write-back have theirs.
 */

import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018,
  writeDwgR13, writeDwgR14
} from '../src/dwg/writer.js';
import { writeDwgR12 } from '../src/dwg/writer12.js';
import { writeDxf, writeDxfBinary } from '../src/dxf/writer.js';

const byLayer = { kind: 'byLayer' } as const;

/** A hand-built ASM binary body: the smallest modeler stream AutoCAD's
 *  kernel accepts (proven externally: a 2018 singleton carrying exactly
 *  this blob opens in AutoCAD 2027 with AUDIT 0/0, both as 3DSOLID and
 *  as BODY). Written out token by token in the tagged grammar
 *  src/acis/sab.ts documents, so the SAB reader is checked against a
 *  stream whose every token we chose. The ASM dialect (2010+ kernels)
 *  differs from the pre-ASM "ACIS BinaryFile" form in four ways this
 *  stream exercises: a raw (untagged) 15-byte magic padded with a
 *  literal '4' followed by four raw little-endian ints, tagged
 *  product/version/date header strings before the records, one extra
 *  null pointer slot in each topology record after the id int, and a
 *  subclass-spelled End-of-ASM-data trailer that closes the stream
 *  without a record terminator. Returned base64, the way the model
 *  carries it. */
const sampleSab = (): string => {
  const out: number[] = [];
  const raw = (s: string): void => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  };
  const raw32 = (v: number): void => {
    out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const str = (s: string): void => { out.push(0x07, s.length); raw(s); };
  const ident = (s: string): void => { out.push(0x0d, s.length); raw(s); };
  const sub = (s: string): void => { out.push(0x0e, s.length); raw(s); };
  const i32 = (v: number): void => { out.push(0x04); raw32(v); };
  const f64s = (...vs: number[]): void => {
    for (const v of vs) {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v, true);
      out.push(...b);
    }
  };
  const f64 = (v: number): void => { out.push(0x06); f64s(v); };
  const vec = (x: number, y: number, z: number): void => {
    out.push(0x14); f64s(x, y, z);
  };
  const ptr = (v: number): void => { out.push(0x0c); raw32(v); };
  const no = (): void => { out.push(0x0b); };
  const end = (): void => { out.push(0x11); };

  /* header: raw magic, then kernel version, 0, entity count, history
     flags — raw ints, exactly as modern AutoCAD saves write them */
  raw('ASM BinaryFile4');
  raw32(22300); raw32(0); raw32(2); raw32(4);
  /* three product strings, then units (mm per unit) and the kernel's
     absolute/normal resolution epsilons */
  str('Autodesk AutoCAD');
  str('ASM 232.0.1.65535 NT');
  str('Sun Aug 16 19:00:01 2026');
  f64(25.4); f64(1e-6); f64(1e-10);

  /* 0: the kernel-version record every ASM stream opens with */
  ident('asmheader'); ptr(-1); i32(-1); str('232.0.1.65535'); end();
  /* 1: one body → lump 2, no wire, transform 4 */
  ident('body'); ptr(-1); i32(-1); ptr(-1); ptr(2); ptr(-1); ptr(4); end();
  /* 2: one lump → shell 3, back-pointer to body 1 */
  ident('lump'); ptr(-1); i32(-1); ptr(-1); ptr(-1); ptr(3); ptr(1); end();
  /* 3: an empty shell (no subshells, faces or wires), back to lump 2 */
  ident('shell'); ptr(-1); i32(-1);
  ptr(-1); ptr(-1); ptr(-1); ptr(-1); ptr(-1); ptr(2); end();
  /* 4: identity transform — three axis vectors, origin, scale 1, then
     no-rotate / no-reflect / no-shear */
  ident('transform'); ptr(-1); i32(-1);
  vec(1, 0, 0); vec(0, 1, 0); vec(0, 0, 1); vec(0, 0, 0);
  f64(1); no(); no(); no(); end();

  /* the trailer: End-of-ASM-data in its subclass-joined spelling, with
     no record terminator after it — that is how real streams close.
     One zero byte of the slot padding that always follows it in a file
     (the AcDs blob slot is zero-filled past the trailer) is kept as
     part of the sample: every reader bounds the stream by the trailer,
     so the pad is invisible to them, and it pins the frozen contract
     that a binary ASM payload has no pre-2007/DXF text form — the SAT
     converter refuses the stream at the pad rather than minting an
     asmheader-dialect SAT no pre-ASM consumer ever shipped with. */
  sub('End'); sub('of'); sub('ASM'); ident('data');
  out.push(0x00);
  return Buffer.from(Uint8Array.from(out)).toString('base64');
};

/** The corpus drawing. A fresh copy each call, so a test that mutates it
 *  cannot leak into the next one. */
export const sampleDrawing = (): Drawing => {
  const d = emptyDrawing();

  d.layers = [
    { name: '0', color: { kind: 'aci', index: 7 }, on: true, frozen: false, locked: false },
    { name: 'Étage€', color: { kind: 'aci', index: 30 }, on: false, frozen: true, locked: true, linetype: 'DASHED' },
    { name: 'حوائط', color: { kind: 'rgb', rgb: 0x2080C0 }, on: true, frozen: false, locked: false }
  ];
  d.linetypes = [
    { name: 'CONTINUOUS', description: 'Solid line', pattern: [] },
    { name: 'DASHED', description: 'Dashed __ __', pattern: [0.5, -0.25] },
    { name: 'CENTER', description: 'Center ____ _ ____', pattern: [1.25, -0.25, 0.25, -0.25] }
  ];
  d.textStyles = [
    { name: 'Standard' },
    { name: 'Arabic', font: 'arial.ttf' }
  ];
  d.dimStyles = [{ name: 'S1', vars: { DIMSCALE: 2, DIMTXT: 0.25, DIMTOL: 1 } }];

  d.blocks = {
    DOOR: {
      name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
      entities: [
        { type: 'line', layer: '0', color: byLayer, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } },
        { type: 'arc', layer: '0', color: { kind: 'aci', index: 3 }, center: { x: 0, y: 0, z: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2 }
      ]
    }
  };

  d.entities = [
    { type: 'line', layer: '0', color: byLayer, start: { x: 1, y: 2, z: 3 }, end: { x: 4, y: 5, z: 6 } },
    { type: 'line', layer: 'Étage€', color: { kind: 'aci', index: 1 }, linetype: 'DASHED', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } },
    { type: 'point', layer: '0', color: byLayer, position: { x: 7, y: 8, z: 9 } },
    { type: 'circle', layer: '0', color: byLayer, center: { x: 5, y: 5, z: 1 }, radius: 2.5 },
    { type: 'arc', layer: '0', color: byLayer, center: { x: 0, y: 0, z: 0 }, radius: 3, startAngle: 0.5, endAngle: 2.5 },
    { type: 'solid', layer: '0', color: byLayer, corners: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }] },
    {
      type: 'face3d', layer: '0', color: byLayer, invisibleEdges: 5,
      corners: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }, { x: 1, y: 1, z: 3 }, { x: 0, y: 1, z: 4 }]
    },
    {
      type: 'text', layer: '0', color: byLayer, text: 'مرحبا 45° Plain',
      position: { x: 1, y: 1, z: 0 }, alignmentPoint: { x: 2, y: 1, z: 0 },
      height: 0.5, rotation: 0.25, widthFactor: 0.8, oblique: 0.1,
      style: 'Arabic', halign: 'center', valign: 'top'
    },
    {
      type: 'mtext', layer: 'حوائط', color: byLayer, position: { x: 0, y: 20, z: 0 },
      text: 'first line\nسطر عربي', height: 0.4, rotation: 0, width: 12
    },
    {
      type: 'polyline', layer: '0', color: byLayer, closed: true,
      vertices: [{ x: 0, y: 0, bulge: 0.5 }, { x: 4, y: 0, startWidth: 0.1, endWidth: 0.2 }, { x: 4, y: 4 }],
      elevation: 2
    },
    {
      type: 'insert', layer: '0', color: byLayer, blockName: 'DOOR',
      position: { x: 10, y: 10, z: 0 }, scale: { x: 2, y: 3, z: 1 }, rotation: 0.7,
      columnCount: 2, rowCount: 3, columnSpacing: 5, rowSpacing: 6,
      attributes: [{
        type: 'text', layer: '0', color: byLayer, text: 'A-101',
        position: { x: 10.5, y: 10.5, z: 0 }, height: 0.2, rotation: 0
      }]
    },
    {
      type: 'mesh', layer: '0', color: byLayer, meshKind: 'grid',
      mSize: 2, nSize: 3, closedM: true,
      vertices: [
        { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 2 }, { x: 2, y: 1, z: 0 }
      ]
    },
    {
      type: 'mesh', layer: '0', color: byLayer, meshKind: 'faces',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 0 }],
      faces: [[1, 2, 3], [1, -3, 4]]
    },
    {
      type: 'dimension', layer: '0', color: byLayer, kind: 'linear',
      dimensionType: 0, definitionPoint: { x: 5, y: 1, z: 0 },
      textMidpoint: { x: 2.5, y: 1.2, z: 0 }, insertionPoint: { x: 2.5, y: 1, z: 0 },
      point13: { x: 0, y: 0, z: 0 }, point14: { x: 5, y: 0, z: 0 },
      rotation: 0, text: '5.00', style: 'S1'
    },
    {
      type: 'ellipse', layer: '0', color: byLayer, center: { x: 0, y: 0, z: 0 },
      majorAxis: { x: 4, y: 0, z: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI * 2
    },
    {
      type: 'spline', layer: '0', color: byLayer, degree: 3, closed: false,
      controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 2, y: -1, z: 0 }, { x: 3, y: 0, z: 0 }],
      knots: [0, 0, 0, 0, 1, 1, 1, 1]
    },
    {
      type: 'hatch', layer: '0', color: byLayer, patternName: 'LINES',
      solid: false, angle: 0, scale: 1,
      loops: [{ kind: 'polyline', vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], closed: true }],
      definitionLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.5 }, dashes: [] }]
    },
    {
      type: 'hatch', layer: '0', color: { kind: 'aci', index: 5 }, patternName: 'SOLID',
      solid: true, angle: 0, scale: 1,
      loops: [{ kind: 'polyline', vertices: [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 7, y: 8 }], closed: true }],
      definitionLines: []
    },
    {
      type: 'table', layer: '0', color: byLayer, position: { x: 30, y: 30, z: 0 },
      numRows: 2, numColumns: 2, rowHeights: [1, 1], columnWidths: [3, 3],
      cells: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]
    },
    { type: 'ray', layer: '0', color: byLayer, basePoint: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    { type: 'xline', layer: '0', color: byLayer, basePoint: { x: 0, y: 3, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
    {
      type: 'mline', layer: '0', color: byLayer, scale: 1, justification: 0,
      closed: false, basePoint: { x: 0, y: 0, z: 0 },
      vertices: [
        {
          position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
          miterDirection: { x: 0, y: 1, z: 0 },
          lines: [{ segparms: [0.5] }, { segparms: [-0.5] }]
        },
        {
          position: { x: 5, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
          miterDirection: { x: 0, y: 1, z: 0 },
          lines: [{ segparms: [0.5] }, { segparms: [-0.5] }]
        }
      ]
    },
    {
      type: 'leader', layer: '0', color: byLayer, hasArrowhead: true, pathType: 0,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }]
    },
    {
      type: 'tolerance', layer: '0', color: byLayer, position: { x: 12, y: 2, z: 0 },
      text: '{\\Fgdt;j}%%v0.5', xDirection: { x: 1, y: 0, z: 0 }
    },
    {
      type: 'acis', layer: '0', color: byLayer, kind: 'body', sab: sampleSab()
    },
    {
      type: 'image', layer: '0', color: byLayer, position: { x: 20, y: 0, z: 0 },
      uVector: { x: 0.01, y: 0, z: 0 }, vVector: { x: 0, y: 0.01, z: 0 },
      widthPx: 640, heightPx: 480, path: 'site.png'
    }
  ] as Entity[];

  d.paperSpace = [
    { type: 'line', layer: '0', color: byLayer, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } }
  ] as Entity[];

  /* Named objects: the parts of a drawing that live outside the entity
   * list. A writer that quietly drops these still produces a file that
   * opens, which is exactly why they are here. */
  d.layouts = [
    {
      name: 'Model', tabOrder: 0, blockName: '*Model_Space',
      limMin: { x: 0, y: 0 }, limMax: { x: 42, y: 30 }
    },
    {
      name: 'Layout1', tabOrder: 1, blockName: '*Paper_Space',
      limMin: { x: 0, y: 0 }, limMax: { x: 420, y: 297 },
      insBase: { x: 0, y: 0, z: 0 }
    }
  ];
  d.groups = [{
    name: 'FRONT_WALL', description: 'الحائط الأمامي',
    selectable: true, entityHandles: ['30', '31']
  }];
  /* the group's members are real entities: source handles live on them,
     and the DXF writer maps each to the handle the output file assigns
     (a member spelled verbatim would dangle — AUDIT strips those) */
  d.entities[0].handle = '30';
  d.entities[1].handle = '31';
  d.mlineStyles = [{
    name: 'STANDARD', description: 'two parallel lines',
    elements: [
      { offset: 0.5, color: { kind: 'byLayer' } },
      { offset: -0.5, color: { kind: 'aci', index: 1 }, linetype: 'DASHED' }
    ]
  }];

  d.header.extMin = { x: 0, y: 0, z: 0 };
  d.header.extMax = { x: 30, y: 30, z: 9 };
  d.header.limMin = { x: 0, y: 0 };
  d.header.limMax = { x: 42, y: 30 };
  d.header.linetypeScale = 2.5;
  d.header.vars = {
    CLAYER: '0', TEXTSTYLE: 'Standard', LUNITS: 2, LUPREC: 4,
    INSUNITS: 4, PDMODE: 34, PDSIZE: 0.5, DIMSCALE: 1
  };
  return d;
};

export type CorpusVersion =
  | 'R12' | 'R13' | 'R14' | 'R2000' | 'R2004' | 'R2007' | 'R2018';

const WRITERS = {
  R12: writeDwgR12,
  R13: writeDwgR13,
  R14: writeDwgR14,
  R2000: writeDwg2000,
  R2004: writeDwg2004,
  R2007: writeDwg2007,
  R2018: writeDwg2018
} as const;

/** Every container the writers can produce, in release order. */
export const DWG_VERSIONS: readonly CorpusVersion[] =
  ['R12', 'R13', 'R14', 'R2000', 'R2004', 'R2007', 'R2018'];

const dwgCache = new Map<CorpusVersion, Uint8Array>();

/** The corpus drawing as a DWG of the given release. Built once per run. */
export const dwgOf = (version: CorpusVersion): Uint8Array => {
  let hit = dwgCache.get(version);
  if (!hit) {
    hit = WRITERS[version](sampleDrawing()).data;
    dwgCache.set(version, hit);
  }
  return hit;
};

let dxfCache: string | undefined;

/** The same drawing as ASCII DXF — the independent codec the DWG side is
 *  cross-checked against. */
export const dxfOf = (): string => (dxfCache ??= writeDxf(sampleDrawing()));

let dxfbCache: Uint8Array | undefined;

/** …and as binary DXF. */
export const dxfbOf = (): Uint8Array =>
  (dxfbCache ??= writeDxfBinary(sampleDrawing()));
