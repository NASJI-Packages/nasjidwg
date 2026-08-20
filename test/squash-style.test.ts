/* nasjidwg — a squashed placement, and the style a text names.
 *
 * Two claims, both about information the reader used to throw away.
 *
 * 1. A round curve carried through a transform that is NOT a similarity is
 *    an ELLIPSE. transformEntity scaled a radius by the magnitude of the
 *    matrix's first column, which is all a single scale factor can say, and
 *    then moved the centre through both scales — so under sx != sy the
 *    curve ended up nowhere near its own centre. explodeInsert and both
 *    exporters route every block child through that function, so the whole
 *    of PDF and SVG export inherited it.
 *
 * 2. Every TEXT, ATTRIB, ATTDEF and MTEXT in a DWG points at a STYLE
 *    record. The reader consumed that pointer and dropped it, so no
 *    consumer could know which font, width factor or slant the file asked
 *    for — `style` came back undefined on all 1,652 text objects of a real
 *    field drawing whose 59 styles mix TTF and SHX.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2018 } from '../src/dwg/writer.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import { explodeInsert, insertTransform, applyPt } from '../src/core/geo.js';
import type { Drawing, Entity, Point2 } from '../src/core/model.js';

const TAU = Math.PI * 2;

/** The implicit form of an ellipse: exactly 1 on the curve. */
const onEllipse = (e: Extract<Entity, { type: 'ellipse' }>, p: Point2): number => {
  const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
  const ry = rx * e.ratio;
  const co = e.majorAxis.x / rx, si = e.majorAxis.y / rx;
  const dx = p.x - e.center.x, dy = p.y - e.center.y;
  const a = (dx * co + dy * si) / rx, b = (dy * co - dx * si) / ry;
  return a * a + b * b;
};
const ellipsePoint = (e: Extract<Entity, { type: 'ellipse' }>, t: number): Point2 => {
  const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
  const ry = rx * e.ratio;
  const co = e.majorAxis.x / rx, si = e.majorAxis.y / rx;
  const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
  return { x: e.center.x + ex * co - ey * si, y: e.center.y + ex * si + ey * co };
};

const withBlock = (child: Entity, scale: Point3ish, rotation: number): Drawing => {
  const d = emptyDrawing();
  d.blocks.SQ = { name: 'SQ', basePoint: { x: 0, y: 0, z: 0 }, entities: [child] };
  d.entities = [{
    type: 'insert', layer: '0', color: { kind: 'byLayer' }, blockName: 'SQ',
    position: { x: 5, y: -3, z: 0 },
    scale: { x: scale.x, y: scale.y, z: 1 }, rotation
  }];
  return d;
};
type Point3ish = { x: number; y: number };

/** Where the placement really sends a definition point. */
const image = (p: Point2, s: Point3ish, rot: number): Point2 => {
  const x = p.x * s.x, y = p.y * s.y;
  const co = Math.cos(rot), si = Math.sin(rot);
  return { x: 5 + x * co - y * si, y: -3 + x * si + y * co };
};

describe('a squashed placement makes an ellipse of every round curve', () => {
  const PLACEMENTS: { s: Point3ish; rot: number }[] = [
    { s: { x: 2, y: 1 }, rot: 0 },
    { s: { x: 2, y: 1 }, rot: Math.PI / 3 },
    { s: { x: -2, y: 1 }, rot: 0.7 },
    { s: { x: 0.5, y: -3 }, rot: 2.2 },
    { s: { x: 600, y: 800 }, rot: 0 }
  ];

  it('a circle lands on the ellipse the transform really makes of it', () => {
    const circle: Entity = {
      type: 'circle', layer: '0', color: { kind: 'byLayer' },
      center: { x: 11, y: -4, z: 0 }, radius: 3
    };
    for (const { s, rot } of PLACEMENTS) {
      const d = withBlock(circle, s, rot);
      const [out] = explodeInsert(
        d.entities[0] as Extract<Entity, { type: 'insert' }>, d.blocks);
      expect(out.type).toBe('ellipse');
      const el = out as Extract<Entity, { type: 'ellipse' }>;
      expect(el.ratio).toBeGreaterThan(0);
      expect(el.ratio).toBeLessThanOrEqual(1 + 1e-12);
      for (let i = 0; i < 12; i++) {
        const t = (TAU * i) / 12;
        const want = image(
          { x: 11 + 3 * Math.cos(t), y: -4 + 3 * Math.sin(t) }, s, rot);
        expect(onEllipse(el, want)).toBeCloseTo(1, 9);
      }
    }
  });

  it('an arc keeps its own sweep, ends included', () => {
    const a0 = 0.3, a1 = 2.1;
    const arc: Entity = {
      type: 'arc', layer: '0', color: { kind: 'byLayer' },
      center: { x: 11, y: -4, z: 0 }, radius: 3, startAngle: a0, endAngle: a1
    };
    for (const { s, rot } of PLACEMENTS) {
      const d = withBlock(arc, s, rot);
      const [out] = explodeInsert(
        d.entities[0] as Extract<Entity, { type: 'insert' }>, d.blocks);
      expect(out.type).toBe('ellipse');
      const el = out as Extract<Entity, { type: 'ellipse' }>;
      const R = Math.hypot(el.majorAxis.x, el.majorAxis.y);
      const sweep = ((el.endParam - el.startParam) % TAU + TAU) % TAU;
      for (let i = 0; i <= 8; i++) {
        const t = a0 + (a1 - a0) * (i / 8);
        const want = image(
          { x: 11 + 3 * Math.cos(t), y: -4 + 3 * Math.sin(t) }, s, rot);
        expect(onEllipse(el, want)).toBeCloseTo(1, 9);
        /* and inside the run the ellipse actually draws */
        let best = Infinity;
        for (let j = 0; j <= 2000; j++) {
          const q = ellipsePoint(el, el.startParam + sweep * (j / 2000));
          best = Math.min(best, Math.hypot(q.x - want.x, q.y - want.y));
        }
        expect(best / R).toBeLessThan(1e-3);
      }
    }
  });

  it('an ellipse child squashes too, and a similarity leaves both alone', () => {
    const ell: Entity = {
      type: 'ellipse', layer: '0', color: { kind: 'byLayer' },
      center: { x: -2, y: 6, z: 0 },
      majorAxis: { x: 5 * Math.cos(0.9), y: 5 * Math.sin(0.9), z: 0 },
      ratio: 0.4, startParam: 0, endParam: TAU
    };
    for (const { s, rot } of PLACEMENTS) {
      const d = withBlock(ell, s, rot);
      const [out] = explodeInsert(
        d.entities[0] as Extract<Entity, { type: 'insert' }>, d.blocks);
      const el = out as Extract<Entity, { type: 'ellipse' }>;
      for (let i = 0; i < 12; i++) {
        const t = (TAU * i) / 12;
        const p = ellipsePoint(ell as Extract<Entity, { type: 'ellipse' }>, t);
        expect(onEllipse(el, image(p, s, rot))).toBeCloseTo(1, 9);
      }
    }
    /* a uniform scale, a mirror and a rotation are all similarities */
    for (const s of [{ x: 3, y: 3 }, { x: -1, y: 1 }, { x: 1, y: 1 }]) {
      const arc: Entity = {
        type: 'arc', layer: '0', color: { kind: 'byLayer' },
        center: { x: 11, y: -4, z: 0 }, radius: 3, startAngle: 0.3, endAngle: 2.1
      };
      const d = withBlock(arc, s, 0.4);
      const [out] = explodeInsert(
        d.entities[0] as Extract<Entity, { type: 'insert' }>, d.blocks);
      expect(out.type).toBe('arc');
    }
  });

  it('the definition point maps the same way the placement does', () => {
    /* the guard against a squash that "fixes" the curve but moves it */
    const s = { x: 4, y: 1.5 }, rot = 1.1;
    const d = withBlock({
      type: 'circle', layer: '0', color: { kind: 'byLayer' },
      center: { x: 7, y: 2, z: 0 }, radius: 1
    }, s, rot);
    const m = insertTransform({ x: 5, y: -3, z: 0 }, { x: s.x, y: s.y, z: 1 }, rot);
    const [out] = explodeInsert(
      d.entities[0] as Extract<Entity, { type: 'insert' }>, d.blocks);
    const el = out as Extract<Entity, { type: 'ellipse' }>;
    const want = applyPt(m, { x: 7, y: 2 });
    expect(el.center.x).toBeCloseTo(want.x, 9);
    expect(el.center.y).toBeCloseTo(want.y, 9);
  });
});

describe('a text says which style it is drawn with', () => {
  const drawingWithStyles = (): Drawing => {
    const d = emptyDrawing();
    d.textStyles = [
      { name: 'Standard', font: 'arial.ttf' },
      { name: 'NARROW', font: 'romans.shx', widthFactor: 0.65 }
    ];
    d.entities = [
      {
        type: 'text', layer: '0', color: { kind: 'byLayer' },
        position: { x: 0, y: 0, z: 0 }, text: 'WIDE', height: 2.5,
        rotation: 0, style: 'Standard'
      },
      {
        type: 'text', layer: '0', color: { kind: 'byLayer' },
        position: { x: 0, y: 10, z: 0 }, text: 'THIN', height: 2.5,
        rotation: 0, style: 'NARROW'
      },
      {
        type: 'mtext', layer: '0', color: { kind: 'byLayer' },
        position: { x: 0, y: 20, z: 0 }, text: 'BANNER', height: 4.4,
        rotation: 0, attachment: 1, style: 'NARROW'
      }
    ];
    return d;
  };
  const styles = (d: Drawing): (string | undefined)[] =>
    d.entities.map((e) => (e.type === 'text' || e.type === 'mtext') ? e.style : '?');

  it('survives a DWG round trip on every writable release', () => {
    for (const write of [writeDwg2000, writeDwg2018]) {
      const back = readDwg(write(drawingWithStyles()).data);
      expect(styles(back)).toEqual(['Standard', 'NARROW', 'NARROW']);
      const narrow = back.textStyles.find((s) => s.name === 'NARROW');
      expect(narrow?.font?.toLowerCase()).toBe('romans.shx');
      expect(narrow?.widthFactor).toBeCloseTo(0.65, 9);
    }
  });

  it('survives a DXF round trip, which is what the DWG one is judged against', () => {
    const back = readDxf(writeDxf(drawingWithStyles()));
    expect(styles(back)).toEqual(['Standard', 'NARROW', 'NARROW']);
  });
});

describe('a TrueType style says its typeface, not just its file', () => {
  /* AutoCAD keeps a TTF style's FILE in the font field and its FAMILY in
     the record's ACAD xdata — 1000 is the family, and the top two bits of
     the 1071 flag word are italic and bold. A style may leave the file
     empty and say all of it there, which 18 of one field drawing's 59
     styles do; read from the file name alone they had no font at all. */
  const dxfWithTypeface = (typeface: string, flags: number): string =>
    `0
SECTION
2
TABLES
0
TABLE
2
STYLE
0
STYLE
2
TTF
70
0
40
0.0
41
0.8
50
15.0
3

1001
ACAD
1000
${typeface}
1071
${flags}
0
ENDTAB
0
ENDSEC
0
EOF
`;

  it('reads the family, the slant and the bold/italic bits from DXF', () => {
    const d = readDxf(dxfWithTypeface('Swis721 LtCn BT', 16777258));
    const st = d.textStyles.find((s) => s.name === 'TTF');
    expect(st?.typeface).toBe('Swis721 LtCn BT');
    expect(st?.italic).toBe(true);
    expect(st?.bold).toBeUndefined();
    expect(st?.oblique).toBeCloseTo(15, 9);
    expect(st?.widthFactor).toBeCloseTo(0.8, 9);
    expect(st?.font).toBeUndefined();      /* the file field really is empty */

    const bold = readDxf(dxfWithTypeface('Arial', 33554466));
    expect(bold.textStyles.find((s) => s.name === 'TTF')?.bold).toBe(true);
  });

  it('carries the slant through every writer', () => {
    const d = emptyDrawing();
    d.textStyles = [{ name: 'Standard' }, { name: 'SLANT', font: 'romans.shx', oblique: 15 }];
    for (const write of [writeDwg2000, writeDwg2018]) {
      const back = readDwg(write(d).data);
      expect(back.textStyles.find((s) => s.name === 'SLANT')?.oblique).toBeCloseTo(15, 6);
    }
    expect(readDxf(writeDxf(d)).textStyles.find((s) => s.name === 'SLANT')?.oblique)
      .toBeCloseTo(15, 6);
  });
});
