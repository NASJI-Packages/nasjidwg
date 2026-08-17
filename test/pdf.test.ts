/* nasjidwg — PDF export: a real vector page, no external dependencies. */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { readDxf } from '../src/dxf/reader.js';
import { writePdf } from '../src/export/pdf.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing } from '../src/core/model.js';

const text = (r: { data: Uint8Array }): string =>
  Array.from(r.data, (b) => String.fromCharCode(b)).join('');

describe('point clouds', () => {
  /* No drawing in the corpus carries a scan, so the decoder is written
     from the format description; what is verified here is that a cloud
     behaves like every other entity once it is in the model. */
  const cloud = (): Drawing => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'pointcloud', layer: '0', color: { kind: 'byLayer' },
      fileName: 'site-scan.rcp',
      extentsMin: { x: 10, y: 20, z: 0 },
      extentsMax: { x: 40, y: 60, z: 5 },
      pointCount: 1250000
    });
    return d;
  };

  it('bounds the drawing by its extents', async () => {
    const { drawingBounds } = await import('../src/core/geo.js');
    const b = drawingBounds(cloud())!;
    expect(b.min).toEqual({ x: 10, y: 20 });
    expect(b.max).toEqual({ x: 40, y: 60 });
  });

  it('moves with a transform like anything else', async () => {
    const { transformEntity, translation } = await import('../src/core/geo.js');
    const moved = transformEntity(cloud().entities[0], translation(5, -5));
    expect(moved.type === 'pointcloud' && moved.extentsMin).toEqual(
      { x: 15, y: 15, z: 0 });
  });

  it('keeps its place in every export', async () => {
    const d = cloud();
    const { writeSvg } = await import('../src/export/svg.js');
    expect(writeSvg(d)).toContain('stroke-dasharray');
    const { toGeoJSON } = await import('../src/export/geojson.js');
    expect(toGeoJSON(d).features[0].geometry.type).toBe('Polygon');
    const pdf = writePdf(d);
    expect(pdf.skipped[0].reason).toMatch(/external scan/);
    const { writeDxf } = await import('../src/dxf/writer.js');
    const { readDxf: rd } = await import('../src/dxf/reader.js');
    const back = rd(writeDxf(d));
    expect(back.entities[0].type).toBe('polyline');
  });
});

/* Sheet control: a plot needs the page it was set up for, at the scale it
 * was set up at — not a page cut to the drawing. */
describe('page and plot control', () => {
  const d = emptyDrawing();
  d.layers.push({ name: 'walls', color: { kind: 'aci', index: 1 }, on: true, frozen: false, locked: false });
  d.entities.push(
    { type: 'line', layer: 'walls', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 50, z: 0 } },
    { type: 'circle', layer: '0', color: { kind: 'aci', index: 3 },
      center: { x: 500, y: 500, z: 0 }, radius: 10 }
  );

  const pageBox = (data: Uint8Array): [number, number] => {
    const s = new TextDecoder('latin1').decode(data);
    const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(s);
    if (!m) throw new Error('no MediaBox');
    return [parseFloat(m[1]), parseFloat(m[2])];
  };

  it('an explicit height makes the page that sheet', () => {
    /* A3 landscape in points */
    const { data } = writePdf(d, { width: 1191, height: 842 });
    expect(pageBox(data)).toEqual([1191, 842]);
  });

  it('a given scale plots at that scale, not fitted', () => {
    const s = 0.5;                     /* half a point per drawing unit */
    const text = new TextDecoder('latin1').decode(
      writePdf(d, { width: 1191, height: 842, scale: s }).data);
    /* the 100-unit line spans 50 points; find its two endpoints */
    const pts = [...text.matchAll(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l/g)]
      .map((m) => [+m[1], +m[2], +m[3], +m[4]]);
    const line = pts.find((p) => Math.abs(Math.abs(p[2] - p[0]) - 100 * s) < 0.5);
    expect(line).toBeTruthy();
  });

  it('monochrome makes every stroke black', () => {
    const text = new TextDecoder('latin1').decode(
      writePdf(d, { monochrome: true }).data);
    const colors = [...text.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) RG/g)];
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect([c[1], c[2], c[3]]).toEqual(['0', '0', '0']);
  });

  it('a clip window scopes the page to that rectangle', () => {
    const text = new TextDecoder('latin1').decode(writePdf(d, {
      width: 400, height: 400,
      clip: { min: { x: 0, y: 0 }, max: { x: 100, y: 50 } }
    }).data);
    /* the clip rectangle is the window, not the whole page */
    const m = /([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re W n/.exec(text);
    expect(m).toBeTruthy();
    expect(parseFloat(m![3])).toBeLessThan(400);
  });
});
