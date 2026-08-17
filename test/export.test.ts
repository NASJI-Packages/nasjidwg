/* nasjidwg — exports (SVG/GeoJSON/JSON) and geometry utilities. */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeSvg } from '../src/export/svg.js';
import { toGeoJSON } from '../src/export/geojson.js';
import { readJson, writeJson } from '../src/export/json.js';
import {
  contentBounds, drawingBounds, entityBounds, explodeInsert, explodePolyline,
  insertTransform, transformEntity
} from '../src/core/geo.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, PolylineEntity } from '../src/core/model.js';
import { dwgOf, sampleDrawing } from './corpus.js';

const drawing = readDwg(dwgOf('R2018'));

describe('SVG export', () => {
  const svg = writeSvg(drawing, { width: 800 });

  it('renders every major entity family from the real drawing', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox=');
    /* lines/arcs/polylines emit paths, circles/points emit circles */
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(20);
    expect(svg).toContain('<text');           /* TEXT/MTEXT rendered */
    expect(svg).toContain('stroke-dasharray'); /* images/xline rendered */
  });

  it('renders Arabic text logically (no escape soup)', () => {
    const d2 = structuredClone(drawing);
    d2.entities.push({
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, text: 'مرحبا', height: 10, rotation: 0
    } as Entity);
    const s = writeSvg(d2);
    expect(s).toContain('مرحبا');
    expect(s).toContain('direction="rtl"');
  });
});

describe('GeoJSON export', () => {
  const gj = toGeoJSON(drawing);

  it('emits features for all geometric entities incl. spline and mline', () => {
    expect(gj.type).toBe('FeatureCollection');
    const types = new Set(gj.features.map((f) => f.properties.entityType));
    for (const t of ['line', 'polyline', 'arc', 'ellipse', 'spline', 'mline',
      'point', 'text', 'hatch', 'solid', 'face3d', 'dimension']) {
      expect(types.has(t), `entityType ${t} present`).toBe(true);
    }
    /* inserts explode into their block geometry */
    expect(gj.features.length).toBeGreaterThan(drawing.entities.length);
  });

  it('closed polylines become polygons with closed rings', () => {
    const polys = gj.features.filter((f) => f.geometry?.type === 'Polygon');
    expect(polys.length).toBeGreaterThan(0);
    for (const p of polys) {
      const rings = p.geometry!.coordinates as number[][][];
      for (const r of rings) {
        /* the ring must close; trig on a bulged arc can leave the last
           point an ulp off the first, which is closure for our purposes */
        const first = r[0]; const last = r[r.length - 1];
        expect(first[0]).toBeCloseTo(last[0], 9);
        expect(first[1]).toBeCloseTo(last[1], 9);
        expect(r.length).toBeGreaterThan(3);
      }
    }
  });
});

describe('JSON round-trip', () => {
  it('is lossless for the whole drawing', () => {
    /* a preview image, when present, is raw bytes rather than JSON data */
    const { thumbnail, ...header } = drawing.header;
    const jsonable = { ...drawing, header };
    const back = readJson(writeJson(jsonable));
    expect(back).toEqual(jsonable);
  });
  it('tolerates garbage', () => {
    expect(readJson('not json').warnings.length).toBe(1);
    expect(readJson('{"entities": 5}').entities).toEqual([]);
  });
});

describe('geometry utilities', () => {
  it('drawing bounds cover every entity bound', () => {
    const b = drawingBounds(drawing)!;
    expect(b.min.x).toBeLessThan(b.max.x);
    for (const e of drawing.entities) {
      const eb = entityBounds(e, drawing.blocks);
      if (!eb) continue;
      expect(eb.min.x).toBeGreaterThanOrEqual(b.min.x - 1e-6);
      expect(eb.max.x).toBeLessThanOrEqual(b.max.x + 1e-6);
    }
  });

  /* a compact drawing: 20 lines forming a 190 x 100 grid near the origin */
  const compact = (): Drawing => {
    const d = emptyDrawing();
    for (let i = 0; i < 20; i++) {
      d.entities.push({
        type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: { x: i * 10, y: 0, z: 0 }, end: { x: i * 10, y: 100, z: 0 }
      } as Entity);
    }
    return d;
  };

  it('content bounds equal drawing bounds on a compact drawing', () => {
    const d = compact();
    expect(contentBounds(d)).toEqual(drawingBounds(d));
  });

  it('content bounds ignore a stray entity megaunits from the mass', () => {
    const d = compact();
    const mass = drawingBounds(d)!;
    /* georeferenced-junk shape: the drawing lives near the origin, one
       forgotten point sits millions of units away */
    d.entities.push({
      type: 'point', layer: '0', color: { kind: 'byLayer' },
      position: { x: 231000, y: 8188000, z: 0 }
    } as Entity);
    const full = drawingBounds(d)!;
    const c = contentBounds(d)!;
    expect(full.max.y).toBeGreaterThanOrEqual(8188000);
    expect(c).toEqual(mass);              /* exactly the real content */
  });

  it('transform rotates a line exactly', () => {
    const line: Entity = {
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 1, y: 0, z: 0 }, end: { x: 2, y: 0, z: 0 }
    };
    const m = insertTransform({ x: 10, y: 0, z: 0 }, { x: 2, y: 2, z: 1 }, Math.PI / 2);
    const t = transformEntity(line, m);
    if (t.type !== 'line') throw new Error('type changed');
    expect(t.start.x).toBeCloseTo(10, 9);
    expect(t.start.y).toBeCloseTo(2, 9);
    expect(t.end.y).toBeCloseTo(4, 9);
  });

  it('explodeInsert produces world-space geometry', () => {
    const ins = drawing.entities.find((e) => e.type === 'insert');
    expect(ins).toBeTruthy();
    if (ins?.type === 'insert' && drawing.blocks[ins.blockName]) {
      const parts = explodeInsert(ins, drawing.blocks);
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.every((p) => p.type !== 'unknown' || p.layer)).toBe(true);
    }
  });

  it('explodePolyline turns bulges into true arcs', () => {
    const pl: PolylineEntity = {
      type: 'polyline', layer: '0', color: { kind: 'byLayer' },
      closed: false,
      vertices: [{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }]
    };
    const parts = explodePolyline(pl);
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('arc');
    if (parts[0].type === 'arc') {
      /* bulge 1 = semicircle: r = 5, center at (5,0) */
      expect(parts[0].radius).toBeCloseTo(5, 9);
      expect(parts[0].center.x).toBeCloseTo(5, 9);
      expect(Math.abs(parts[0].center.y)).toBeLessThan(1e-9);
    }
  });
});

describe('MTEXT parser', () => {
  it('parses fonts, colors, heights, stacking and paragraphs', async () => {
    const { parseMtext, mtextPlainText } = await import('../src/text/mtext.js');
    const raw = '{\\fArial|b1|i0;\\C1;Hello} \\H2.5x;big\\Pnext \\S1/2;\\P\\L under\\l done';
    const frags = parseMtext(raw);
    expect(frags[0].font).toBe('Arial');
    expect(frags[0].bold).toBe(true);
    expect(frags[0].colorAci).toBe(1);
    expect(frags[0].text).toBe('Hello');
    const big = frags.find((f) => f.heightFactor === 2.5);
    expect(big?.text).toBe('big');
    const stacked = frags.find((f) => f.stacked);
    expect(stacked?.stacked).toEqual({ upper: '1', lower: '2', divider: '/' });
    const under = frags.find((f) => f.underline && f.text.includes('under'));
    expect(under).toBeTruthy();
    expect(mtextPlainText(frags)).toContain('Hello');
    expect(mtextPlainText(frags)).toContain('\n');
    expect(mtextPlainText(frags)).toContain('1/2');
  });

  it('parses the real MTEXT from the DWG fixture without loss', async () => {
    const { parseMtext, mtextPlainText } = await import('../src/text/mtext.js');
    const mt = drawing.entities.find((e) => e.type === 'mtext');
    expect(mt).toBeTruthy();
    if (mt?.type === 'mtext') {
      const frags = parseMtext(mt.raw ?? mt.text);
      expect(mtextPlainText(frags).length).toBeGreaterThan(0);
    }
  });
});

describe('XDATA round-trip', () => {
  it('entity xdata survives DXF write/read with points and typed values', async () => {
    const { emptyDrawing } = await import('../src/core/model.js');
    const { writeDxf } = await import('../src/dxf/writer.js');
    const { readDxf } = await import('../src/dxf/reader.js');
    const d = emptyDrawing();
    d.entities.push({
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 },
      xdata: [{
        appName: 'MYAPP',
        values: [
          { code: 1000, value: 'hello xdata' },
          { code: 1002, value: '{' },
          { code: 1040, value: 3.25 },
          { code: 1070, value: 42 },
          { code: 1010, point: { x: 5, y: 6, z: 7 } },
          { code: 1002, value: '}' }
        ]
      }]
    });
    const d2 = readDxf(writeDxf(d));
    const line = d2.entities.find((e) => e.type === 'line');
    expect(line?.xdata?.length).toBe(1);
    const g = line!.xdata![0];
    expect(g.appName).toBe('MYAPP');
    expect(g.values).toEqual([
      { code: 1000, value: 'hello xdata' },
      { code: 1002, value: '{' },
      { code: 1040, value: 3.25 },
      { code: 1070, value: 42 },
      { code: 1010, point: { x: 5, y: 6, z: 7 } },
      { code: 1002, value: '}' }
    ]);
  });
});

describe('named objects DXF round-trip', () => {
  it('layouts, groups and mline styles survive write/read', async () => {
    const { writeDxf } = await import('../src/dxf/writer.js');
    const { readDxf } = await import('../src/dxf/reader.js');
    /* the named objects are a DXF-side feature, so this checks the DXF
       codec against the source drawing rather than a DWG round-trip */
    const drawing = sampleDrawing();
    const back = readDxf(writeDxf(drawing));

    expect(back.layouts?.map((l) => l.name).sort())
      .toEqual(drawing.layouts!.map((l) => l.name).sort());
    const l1 = back.layouts!.find((l) => l.name === 'Layout1')!;
    const s1 = drawing.layouts!.find((l) => l.name === 'Layout1')!;
    expect(l1.limMax!.x).toBeCloseTo(s1.limMax!.x, 6);
    expect(l1.tabOrder).toBe(s1.tabOrder);

    expect(back.groups?.length).toBe(drawing.groups!.length);
    expect(back.groups![0].entityHandles.length)
      .toBe(drawing.groups![0].entityHandles.length);

    expect(back.mlineStyles?.length).toBe(drawing.mlineStyles!.length);
    const m = back.mlineStyles![0], sm = drawing.mlineStyles![0];
    expect(m.name.toUpperCase()).toBe(sm.name.toUpperCase());
    expect(m.elements.length).toBe(sm.elements.length);
    expect(m.elements[0].offset).toBeCloseTo(sm.elements[0].offset, 9);

    expect(back.appIds).toContain('ACAD');
    expect(back.dimStyles?.map((d) => d.name)).toEqual(
      drawing.dimStyles!.map((d) => d.name));
  });
});

describe('CJK codepages and MIF escapes', () => {
  it('decodes double-byte text for every CJK page', async () => {
    const { decodeCodepage } = await import('../src/dwg/bitstream.js');
    /* Shift-JIS 0x82A0 = HIRAGANA A, GB2312 0xB0A1 = 啊,
       BIG5 0xA440 = 一, CP949 0xB0A1 = 가 */
    expect(decodeCodepage(Uint8Array.from([0x82, 0xA0]), 'ANSI_932')).toBe('あ');
    expect(decodeCodepage(Uint8Array.from([0xB0, 0xA1]), 'ANSI_936')).toBe('啊');
    expect(decodeCodepage(Uint8Array.from([0xA4, 0x40]), 'ANSI_950')).toBe('一');
    expect(decodeCodepage(Uint8Array.from([0xB0, 0xA1]), 'ANSI_949')).toBe('가');
    /* ASCII passes through, and a mixed run stays aligned */
    expect(decodeCodepage(
      Uint8Array.from([0x41, 0x82, 0xA0, 0x42]), 'CP932')).toBe('AあB');
  });

  it('resolves MIF escapes through the same tables', async () => {
    const { decodeCadText } = await import('../src/text/escapes.js');
    const { encodeMif } = await import('../src/text/mif.js');
    expect(decodeCadText('\\M+182A0')).toBe('あ');
    expect(decodeCadText('x\\M+5B0A1y')).toBe('x啊y');
    /* round trip through the encoder */
    const esc = encodeMif('あ', 1);
    expect(esc).toBe('\\M+182A0');
    expect(decodeCadText(esc!)).toBe('あ');
  });

  it('CJK text survives the DXF round trip via \U+ escapes', async () => {
    const { emptyDrawing } = await import('../src/core/model.js');
    const { writeDxf } = await import('../src/dxf/writer.js');
    const { readDxf } = await import('../src/dxf/reader.js');
    const d = emptyDrawing();
    d.entities.push({
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, text: '図面 A-1', height: 5, rotation: 0
    } as Entity);
    const back = readDxf(writeDxf(d));
    const t = back.entities.find((e) => e.type === 'text' || e.type === 'mtext');
    expect(t && 'text' in t ? t.text : '').toBe('図面 A-1');
  });
});

