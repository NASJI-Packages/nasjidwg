/* nasjidwg — exporter fidelity: MTEXT paragraph layout and linetype
 * dashes in the SVG and PDF outputs.
 *
 * No SHX font is registered in this file, so every MTEXT here exercises
 * the <text>/Tj fallback path — the layout maths, not the stroke fonts.
 */

import { describe, expect, it } from 'vitest';
import { writeSvg } from '../src/export/svg.js';
import { writePdf } from '../src/export/pdf.js';
import { emptyDrawing } from '../src/core/model.js';
import { shapeArabic } from '../src/text/arabic.js';
import type { Drawing, Entity } from '../src/core/model.js';

const byLayer = { kind: 'byLayer' } as const;

const mtextDrawing = (extra: Record<string, unknown>): Drawing => {
  const d = emptyDrawing();
  d.entities.push({
    type: 'mtext', layer: '0', color: byLayer,
    position: { x: 0, y: 0, z: 0 }, text: '', height: 2, rotation: 0,
    ...extra
  } as Entity);
  return d;
};

/** Every <text> row of an SVG, in document order. */
const textRows = (svg: string): { x: number; y: number; text: string }[] =>
  [...svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: +m[1], y: +m[2], text: m[3] }));

describe('MTEXT paragraph layout in SVG', () => {
  const sentence = 'the quick brown fox jumps over the lazy dog again';

  it('wraps to the reference width into rows 5/3 heights apart', () => {
    const svg = writeSvg(mtextDrawing({ text: sentence, width: 12 }));
    const rows = textRows(svg);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    /* rows march down the page (SVG y grows downward) at 5/3 x height */
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].y - rows[i - 1].y).toBeCloseTo((5 / 3) * 2, 5);
    }
    /* no character was lost or invented by the wrap */
    expect(rows.map((r) => r.text).join(' ')).toBe(sentence);
  });

  it('does not wrap without a width', () => {
    const svg = writeSvg(mtextDrawing({ text: sentence }));
    const rows = textRows(svg);
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe(sentence);
  });

  it('a zero width means unbounded too', () => {
    const rows = textRows(writeSvg(mtextDrawing({ text: sentence, width: 0 })));
    expect(rows.length).toBe(1);
  });

  it('\\P forces a paragraph break', () => {
    const svg = writeSvg(mtextDrawing({ text: 'AAA\nBBB', raw: 'AAA\\PBBB' }));
    const rows = textRows(svg);
    expect(rows.map((r) => r.text)).toEqual(['AAA', 'BBB']);
    expect(rows[1].y - rows[0].y).toBeCloseTo((5 / 3) * 2, 5);
  });

  it('wraps Arabic after shaping, never through a joined form', () => {
    const arabic = 'مرحبا بالعالم العربي الجميل في هذا الرسم الهندسي';
    const svg = writeSvg(mtextDrawing({ text: arabic, width: 10 }));
    const rows = textRows(svg);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    /* every rendered row is a contiguous slice of the shaped string, in
       order — the wrap moved whole shaped words, breaking no joins */
    const shaped = shapeArabic(arabic);
    let cursor = 0;
    for (const row of rows) {
      expect(row.text.length).toBeGreaterThan(0);
      const at = shaped.indexOf(row.text, cursor);
      expect(at, `row "${row.text}" is a slice of the shaped text`)
        .toBeGreaterThanOrEqual(cursor);
      cursor = at + row.text.length;
    }
    /* rows carry shaped forms and stay right-to-left for the browser */
    expect(svg).toContain('direction="rtl"');
  });

  it('lays wrapped rows out in the PDF as separate text runs', () => {
    const pdf = writePdf(mtextDrawing({ text: sentence, width: 12 }));
    const text = new TextDecoder('latin1').decode(pdf.data);
    expect(pdf.skipped).toEqual([]);
    const runs = [...text.matchAll(/\(([^)]*)\) Tj/g)].map((m) => m[1]);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.join(' ')).toBe(sentence);
  });
});

describe('linetype dashes', () => {
  const dashedDrawing = (): Drawing => {
    const d = emptyDrawing();
    d.header.linetypeScale = 2;
    d.linetypes.push(
      { name: 'DASHED', description: 'Dashed __ __', pattern: [0.5, -0.25] },
      { name: 'DOTTED', description: 'Dotted . . .', pattern: [0, -0.25] });
    d.layers.push({
      name: 'hidden', color: { kind: 'aci', index: 3 },
      on: true, frozen: false, locked: false, linetype: 'DASHED'
    });
    d.entities.push({
      /* named linetype, resolved case-insensitively */
      type: 'line', layer: '0', color: byLayer, linetype: 'dashed',
      start: { x: 0, y: 0, z: 0 }, end: { x: 50, y: 0, z: 0 }
    } as Entity, {
      /* ByLayer resolves through the layer's linetype */
      type: 'line', layer: 'hidden', color: byLayer,
      start: { x: 0, y: 5, z: 0 }, end: { x: 50, y: 5, z: 0 }
    } as Entity, {
      /* the entity's own linetype scale compounds with the header's */
      type: 'circle', layer: '0', color: byLayer, linetype: 'DASHED',
      linetypeScale: 0.5, center: { x: 25, y: 15, z: 0 }, radius: 4
    } as Entity, {
      /* dots render as short 0.1-unit dashes */
      type: 'arc', layer: '0', color: byLayer, linetype: 'DOTTED',
      center: { x: 25, y: 25, z: 0 }, radius: 4,
      startAngle: 0, endAngle: Math.PI
    } as Entity, {
      /* CONTINUOUS stays solid */
      type: 'line', layer: '0', color: byLayer, linetype: 'Continuous',
      start: { x: 0, y: 35, z: 0 }, end: { x: 50, y: 35, z: 0 }
    } as Entity, {
      /* no linetype anywhere: solid */
      type: 'line', layer: '0', color: byLayer,
      start: { x: 0, y: 40, z: 0 }, end: { x: 50, y: 40, z: 0 }
    } as Entity);
    return d;
  };

  it('SVG carries stroke-dasharray scaled by both linetype scales', () => {
    const svg = writeSvg(dashedDrawing());
    /* DASHED [0.5, -0.25] x ltscale 2 */
    expect(svg).toContain('stroke-dasharray="1 0.5"');
    /* the same pattern at entity scale 0.5 lands back on the raw lengths */
    expect(svg).toContain('stroke-dasharray="0.5 0.25"');
    /* a dot is a 0.1-unit dash before scaling */
    expect(svg).toContain('stroke-dasharray="0.2 0.5"');
    /* two dashed lines, one dashed circle, one dotted arc — nothing else */
    expect((svg.match(/stroke-dasharray/g) ?? []).length).toBe(4);
  });

  it('solid lines carry no dash attribute', () => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'line', layer: '0', color: byLayer,
      start: { x: 0, y: 0, z: 0 }, end: { x: 50, y: 0, z: 0 }
    } as Entity);
    expect(writeSvg(d)).not.toContain('stroke-dasharray');
  });

  it('PDF sets the d operator before the stroke and resets after', () => {
    /* scale 1: page points equal drawing units, so the array is exact */
    const text = new TextDecoder('latin1').decode(
      writePdf(dashedDrawing(), { scale: 1 }).data);
    expect(text).toContain('[1 0.5] 0 d');
    expect(text).toContain('[0.5 0.25] 0 d');
    expect(text).toContain('[0.2 0.5] 0 d');
    /* every dash set is paired with a reset to solid */
    const sets = (text.match(/\[[\d. ]+\] 0 d/g) ?? []).length;
    const resets = (text.match(/\[\] 0 d/g) ?? []).length;
    expect(sets).toBe(4);
    expect(resets).toBe(4);
    expect(text.indexOf('[1 0.5] 0 d')).toBeLessThan(text.indexOf('[] 0 d'));
  });

  it('PDF stays free of dash operators when everything is solid', () => {
    const d = emptyDrawing();
    d.entities.push({
      type: 'line', layer: '0', color: byLayer,
      start: { x: 0, y: 0, z: 0 }, end: { x: 50, y: 0, z: 0 }
    } as Entity);
    const text = new TextDecoder('latin1').decode(writePdf(d).data);
    expect(text).not.toMatch(/ 0 d\b/);
  });
});
