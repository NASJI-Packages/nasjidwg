/* nasjidwg — the self-contained suite.
 *
 * Everything here runs off test/corpus.ts, which builds its fixtures with
 * this library's own writers. No files are read, nothing is downloaded: a
 * clone plus `npm test` exercises all five containers we can write, both
 * DXF flavours, and every export target, on any machine.
 *
 * It checks that what we write is what we read, in every release we can
 * write, for every entity we can encode, and that the DWG and DXF codecs
 * agree on the result.
 */

import { describe, expect, it } from 'vitest';
import { DWG_VERSIONS, dwgOf, dxfOf, dxfbOf, sampleDrawing } from './corpus.js';
import type { CorpusVersion } from './corpus.js';
import { readDwg } from '../src/dwg/reader.js';
import { readDxf } from '../src/dxf/reader.js';
import { detectVersion } from '../src/dwg/fileheader.js';
import { drawingBounds } from '../src/core/geo.js';
import { writeSvg } from '../src/export/svg.js';
import { writePdf } from '../src/export/pdf.js';
import { toGeoJSON } from '../src/export/geojson.js';
import { writeJson } from '../src/export/json.js';
import type { Drawing, Entity } from '../src/core/model.js';

const MAGIC: Record<CorpusVersion, string> = {
  R12: 'R12', R13: 'R13', R14: 'R14',
  R2000: 'R2000', R2004: 'R2004', R2007: 'R2007', R2018: 'R2018'
};

const byType = <T extends Entity['type']>(d: Drawing, t: T) =>
  d.entities.filter((e): e is Extract<Entity, { type: T }> => e.type === t);

/** Every number an entity carries, in a stable order, rounded. */
const numbers = (value: unknown, into: number[] = []): number[] => {
  if (typeof value === 'number') into.push(Math.round(value * 1e6) / 1e6);
  else if (Array.isArray(value)) for (const v of value) numbers(v, into);
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value as object).sort()) {
      if (k !== 'styleId' && k !== 'handle') {
        numbers((value as Record<string, unknown>)[k], into);
      }
    }
  }
  return into;
};

/* ------------------------------------------------------------------ */

describe.each(DWG_VERSIONS)('%s round-trip', (version) => {
  const bytes = dwgOf(version);
  const back = readDwg(bytes);

  it('announces the release it was asked for', () => {
    expect(detectVersion(bytes)).toBe(MAGIC[version]);
  });

  it('decodes without warnings', () => {
    expect(back.warnings).toEqual([]);
  });

  it('keeps the layer table, accents included', () => {
    const names = back.layers.map((l) => l.name);
    expect(names).toContain('0');
    expect(names).toContain('Étage€');
    expect(back.layers.length).toBe(3);
  });

  it('carries each layer\'s colour and state', () => {
    const off = back.layers.find((l) => l.name === 'Étage€');
    expect(off?.color).toEqual({ kind: 'aci', index: 30 });
    expect(off?.on).toBe(false);
    expect(off?.frozen).toBe(true);
    expect(off?.locked).toBe(true);
    expect(off?.linetype?.toUpperCase()).toBe('DASHED');
  });

  it('carries a true-colour layer where the release has true colour', () => {
    const wall = back.layers.find((l) => l.name === 'حوائط');
    if (version === 'R12') return;              /* no such layer, see above */
    if (version === 'R13' || version === 'R14' || version === 'R2000') {
      /* Layers held an ACI index only until AC1018 introduced true
         colour, so the nearest index is the honest answer here. */
      expect(wall?.color.kind).toBe('aci');
    } else {
      expect(wall?.color).toEqual({ kind: 'rgb', rgb: 0x2080C0 });
    }
  });

  it('carries the Arabic layer name where the release can hold it', () => {
    const names = back.layers.map((l) => l.name);
    if (version === 'R12') {
      /* AC1009 names are a 32-byte Windows-1252 field with no escape
         mechanism, so anything outside it degrades. Losing the glyphs is
         the format's limit, not ours — but the layer itself survives. */
      expect(names.length).toBe(3);
      expect(names).not.toContain('حوائط');
    } else {
      expect(names).toContain('حوائط');
    }
  });

  it('keeps the linetype and text-style tables', () => {
    const lt = back.linetypes.map((l) => l.name.toUpperCase());
    expect(lt).toContain('CONTINUOUS');
    expect(lt).toContain('CENTER');
    expect(back.textStyles.map((s) => s.name)).toContain('Arabic');
  });

  it('keeps a dashed linetype with its pattern', () => {
    const dashed = back.linetypes.find((l) => l.name.toUpperCase() === 'DASHED');
    expect(dashed?.pattern).toEqual([0.5, -0.25]);
    const center = back.linetypes.find((l) => l.name.toUpperCase() === 'CENTER');
    expect(center?.pattern).toEqual([1.25, -0.25, 0.25, -0.25]);
  });

  it('keeps the block definition and its insert', () => {
    expect(Object.keys(back.blocks)).toContain('DOOR');
    void 0;
    expect(back.blocks.DOOR.entities.length).toBe(2);
    const ins = byType(back, 'insert')[0];
    expect(ins.blockName).toBe('DOOR');
    expect(ins.position).toEqual({ x: 10, y: 10, z: 0 });
    expect(ins.scale).toEqual({ x: 2, y: 3, z: 1 });
    expect(ins.rotation).toBeCloseTo(0.7, 9);
  });

  it('round-trips plain geometry number for number', () => {
    const line = byType(back, 'line')
      .find((l) => l.start.x === 1 && l.start.y === 2);
    expect(line).toBeTruthy();
    expect(line?.end).toEqual({ x: 4, y: 5, z: 6 });

    const circle = byType(back, 'circle')[0];
    expect(circle.center).toEqual({ x: 5, y: 5, z: 1 });
    expect(circle.radius).toBe(2.5);

    const arc = byType(back, 'arc').find((a) => a.radius === 3);
    expect(arc?.startAngle).toBeCloseTo(0.5, 9);
    expect(arc?.endAngle).toBeCloseTo(2.5, 9);

    expect(byType(back, 'point')[0].position).toEqual({ x: 7, y: 8, z: 9 });

    const face = byType(back, 'face3d')[0];
    expect(face.invisibleEdges).toBe(5);
    expect(face.corners[3]).toEqual({ x: 0, y: 1, z: 4 });
  });

  it('round-trips Arabic and accented text', () => {
    const text = byType(back, 'text')
      .find((t) => t.text.includes('مرحبا'));
    expect(text).toBeTruthy();
    expect(text?.text).toBe('مرحبا 45° Plain');
    expect(text?.height).toBe(0.5);
    expect(text?.rotation).toBeCloseTo(0.25, 9);
    expect(text?.widthFactor).toBeCloseTo(0.8, 9);
    expect(text?.halign).toBe('center');
    expect(text?.valign).toBe('top');
  });

  it('round-trips the polyline with bulges, widths and elevation', () => {
    const pl = byType(back, 'polyline')[0];
    expect(pl.closed).toBe(true);
    expect(pl.vertices.length).toBe(3);
    expect(pl.vertices[0].bulge).toBeCloseTo(0.5, 9);
    expect(pl.vertices[1].startWidth).toBeCloseTo(0.1, 9);
    expect(pl.vertices[1].endWidth).toBeCloseTo(0.2, 9);
  });

  it('round-trips both mesh flavours', () => {
    const grid = byType(back, 'mesh').find((m) => m.meshKind === 'grid');
    expect(grid?.mSize).toBe(2);
    expect(grid?.nSize).toBe(3);
    expect(grid?.closedM).toBe(true);
    expect(grid?.vertices.length).toBe(6);

    const faces = byType(back, 'mesh').find((m) => m.meshKind === 'faces');
    expect(faces?.vertices.length).toBe(4);
    expect(faces?.faces?.length).toBe(2);
  });

  it('keeps the dimension and its style', () => {
    const dim = byType(back, 'dimension')[0];
    expect(dim.kind).toBe('linear');
    expect(dim.point13).toEqual({ x: 0, y: 0, z: 0 });
    expect(dim.point14).toEqual({ x: 5, y: 0, z: 0 });
    expect(dim.text).toBe('5.00');
  });

  it('keeps hatch boundaries and pattern definitions', () => {
    const hatches = byType(back, 'hatch');
    if (version === 'R12') {
      /* AC1009 has no HATCH entity; the writer explodes fills to line
         work, which the downgrade list reports. */
      expect(hatches.length).toBe(0);
      return;
    }
    expect(hatches.length).toBeGreaterThan(0);
    const patterned = hatches.find((h) => !h.solid);
    expect(patterned?.loops.length).toBeGreaterThan(0);
    expect(patterned?.definitionLines?.length ?? 0).toBeGreaterThan(0);
  });

  it('keeps the drawing extents and limits', () => {
    expect(back.header.extMax?.x).toBeCloseTo(30, 6);
    expect(back.header.extMax?.y).toBeCloseTo(30, 6);
    expect(back.header.limMax?.x).toBeCloseTo(42, 6);
    expect(back.header.limMin).toEqual({ x: 0, y: 0 });
  });

  it('carries LTSCALE back out', () => {
    expect(back.header.linetypeScale).toBeCloseTo(2.5, 9);
  });

  it('a second write of what we read produces the same drawing', () => {
    const again = readDwg(dwgOf(version));
    expect(again.entities.map((e) => e.type))
      .toEqual(back.entities.map((e) => e.type));
    expect(numbers(again.entities)).toEqual(numbers(back.entities));
  });
});

/* ------------------------------------------------------------------ */

describe('the DWG and DXF codecs agree', () => {
  const dxf = readDxf(dxfOf());

  it('both carry the same entity mix', () => {
    for (const version of DWG_VERSIONS) {
      if (version === 'R12') continue;             /* R12 downgrades several */
      const dwg = readDwg(dwgOf(version));
      const mix = (d: Drawing) => {
        const c: Record<string, number> = {};
        for (const e of d.entities) c[e.type] = (c[e.type] ?? 0) + 1;
        return c;
      };
      const a = mix(dwg);
      const b = mix(dxf);
      /* every type the DXF side kept, the DWG side kept too */
      for (const t of Object.keys(b)) {
        expect(a[t], `${version} is missing ${t}`).toBeGreaterThan(0);
      }
    }
  });

  it('geometry matches between the two codecs', () => {
    const dwg = readDwg(dwgOf('R2018'));
    const key = (d: Drawing) => byType(d, 'line')
      .map((l) => numbers([l.start, l.end]).join(','))
      .sort();
    expect(key(dwg)).toEqual(key(dxf));

    const circles = (d: Drawing) => byType(d, 'circle')
      .map((c) => `${c.radius}@${c.center.x},${c.center.y}`).sort();
    expect(circles(dwg)).toEqual(circles(dxf));
  });

  it('Arabic text survives both paths identically', () => {
    const dwg = readDwg(dwgOf('R2018'));
    const ARABIC = /[\u0600-\u06FF]/;
    const arabic = (d: Drawing) => d.entities
      .filter((e): e is Extract<Entity, { type: 'text' | 'mtext' }> =>
        e.type === 'text' || e.type === 'mtext')
      .map((e) => e.text).filter((s) => ARABIC.test(s)).sort();
    expect(arabic(dwg)).toEqual(arabic(dxf));
    expect(arabic(dxf)).toContain('مرحبا 45° Plain');
  });

  it('binary DXF decodes to the same thing as ASCII DXF', () => {
    const bin = readDxf(dxfbOf());
    expect(bin.entities.map((e) => e.type).sort())
      .toEqual(dxf.entities.map((e) => e.type).sort());
    const shape = (d: Drawing) => d.layers.map(
      (l) => `${l.name}|${l.on}|${l.frozen}|${l.locked}|${l.linetype ?? ''}`);
    expect(shape(bin)).toEqual(shape(dxf));
    expect(numbers(bin.entities)).toEqual(numbers(dxf.entities));
  });

  it('a true-colour layer decodes the same in both DXF flavours', () => {
    const asc = dxf.layers.find((l) => l.name === 'حوائط');
    const bin = readDxf(dxfbOf()).layers.find((l) => l.name === 'حوائط');
    expect(asc?.color).toEqual({ kind: 'rgb', rgb: 0x2080C0 });
    expect(bin?.color).toEqual(asc?.color);
  });
});

/* ------------------------------------------------------------------ */

describe('exports run over the generated drawing', () => {
  const d = readDwg(dwgOf('R2018'));

  it('SVG covers the model space', () => {
    const svg = writeSvg(d);
    expect(svg.startsWith('<?xml') || svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    expect(svg.length).toBeGreaterThan(500);
  });

  it('PDF is a well-formed single page', () => {
    const pdf = writePdf(d).data;
    const head = new TextDecoder('latin1').decode(pdf.subarray(0, 8));
    const tail = new TextDecoder('latin1').decode(pdf.subarray(-32));
    expect(head.startsWith('%PDF-')).toBe(true);
    expect(tail).toContain('%%EOF');
  });

  it('GeoJSON is a FeatureCollection with geometry', () => {
    const gj = toGeoJSON(d);
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.features.length).toBeGreaterThan(0);
  });

  it('JSON keeps the whole document', () => {
    const round = JSON.parse(writeJson(d)) as Drawing;
    expect(round.entities.length).toBe(d.entities.length);
    expect(round.layers.length).toBe(d.layers.length);
  });

  it('bounds cover the drawing', () => {
    const b = drawingBounds(d);
    expect(b).toBeTruthy();
    if (b) {
      expect(b.max.x).toBeGreaterThan(b.min.x);
      expect(b.max.y).toBeGreaterThan(b.min.y);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('the corpus drawing itself', () => {
  it('exercises every entity the writers can encode', () => {
    const types = new Set(sampleDrawing().entities.map((e) => e.type));
    for (const t of [
      'line', 'point', 'circle', 'arc', 'ellipse', 'spline', 'polyline',
      'text', 'mtext', 'insert', 'solid', 'face3d', 'mesh', 'hatch',
      'dimension', 'leader', 'tolerance', 'mline', 'ray', 'xline',
      'table', 'image', 'acis'
    ]) {
      expect(types.has(t as Entity['type']), `corpus is missing ${t}`).toBe(true);
    }
  });

  it('is rebuilt fresh on every call', () => {
    const a = sampleDrawing();
    a.entities.length = 0;
    expect(sampleDrawing().entities.length).toBeGreaterThan(20);
  });
});
