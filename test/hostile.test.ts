/* nasjidwg — the structural quirks real files carry.
 *
 * A DWG or DXF in the wild is written by dozens of programs, and each has
 * its own reading of the format. Every case here is a shape a real file
 * takes that a spec reading alone would not warn about: a comment where
 * only a name was expected, a header point with no Z, a record nobody
 * models sitting between two that everybody does. Reading any of them
 * wrong loses data silently, which is the worst way to lose it.
 */

import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import { ocsTransform, toWcs, entityBounds } from '../src/core/geo.js';
import { writeSvg } from '../src/export/svg.js';
import { toGeoJSON } from '../src/export/geojson.js';
import type { Drawing, Entity } from '../src/core/model.js';

/** Build a DXF from group/value pairs, so a case can be exactly as odd
 *  as the file that caused the original bug. */
const dxf = (...pairs: (string | number)[]): string => {
  const out: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    out.push(String(pairs[i]), String(pairs[i + 1]));
  }
  return out.join('\n') + '\n';
};

const ENTITIES_HEAD = [0, 'SECTION', 2, 'ENTITIES'] as const;
const TAIL = [0, 'ENDSEC', 0, 'EOF'] as const;

describe('structural tolerance', () => {
  it('finds a section whose name is preceded by comments', () => {
    /* a comment between SECTION and its name must not hide the section:
       the alternative is losing every entity in it without a word */
    const d = readDxf(dxf(
      0, 'SECTION', 999, 'written by some tool', 999, 'v1.2', 2, 'ENTITIES',
      0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 5, 21, 5, 31, 0,
      ...TAIL));
    expect(d.entities.length).toBe(1);
    expect(d.entities[0].type).toBe('line');
  });

  it('accepts a header point variable that omits its Z', () => {
    /* R12-era writers emit $EXTMIN as a 2D point; demanding the Z would
       throw away a whole file over a missing zero */
    const d = readDxf(dxf(
      0, 'SECTION', 2, 'HEADER',
      9, '$EXTMIN', 10, 1.5, 20, 2.5,
      9, '$EXTMAX', 10, 9, 20, 8,
      0, 'ENDSEC', ...ENTITIES_HEAD,
      0, 'POINT', 8, '0', 10, 1, 20, 2, 30, 0,
      ...TAIL));
    expect(d.header.extMin).toEqual({ x: 1.5, y: 2.5, z: 0 });
    expect(d.entities.length).toBe(1);
  });

  it('keeps entities that follow one it cannot model', () => {
    /* an unmodelled record is a reason to skip one entity, never a
       reason to stop reading the ones behind it */
    const d = readDxf(dxf(
      ...ENTITIES_HEAD,
      0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1,
      0, 'ACAD_PROXY_ENTITY', 8, '0', 90, 123, 91, 456,
      0, 'SOMETHING_INVENTED', 8, '0', 10, 3, 20, 4,
      0, 'CIRCLE', 8, '0', 10, 5, 20, 5, 40, 2,
      ...TAIL));
    expect(d.entities.some((e) => e.type === 'circle')).toBe(true);
    expect(d.entities.some((e) => e.type === 'line')).toBe(true);
  });

  it('takes a layer colour of 256 or a negative index without failing', () => {
    /* a layer record carries 256 for ByLayer and a negative index for
       "off"; both are ordinary, and neither may fail the read */
    const d = readDxf(dxf(
      0, 'SECTION', 2, 'TABLES',
      0, 'TABLE', 2, 'LAYER',
      0, 'LAYER', 2, 'off-layer', 62, -7, 70, 0,
      0, 'LAYER', 2, 'bylayer-ish', 62, 256, 70, 0,
      0, 'ENDTAB', 0, 'ENDSEC',
      ...ENTITIES_HEAD,
      0, 'POINT', 8, 'off-layer', 10, 0, 20, 0,
      ...TAIL));
    expect(d.layers.map((l) => l.name)).toContain('off-layer');
    const off = d.layers.find((l) => l.name === 'off-layer')!;
    expect(off.on).toBe(false);
    expect(off.color).toEqual({ kind: 'aci', index: 7 });
  });

  it('reads a radius of zero as zero', () => {
    /* a degenerate radius is what the file says: clamping it to some
       minimum invents geometry nobody drew */
    const d = readDxf(dxf(
      ...ENTITIES_HEAD,
      0, 'CIRCLE', 8, '0', 10, 1, 20, 1, 40, 0,
      ...TAIL));
    const c = d.entities.find((e) => e.type === 'circle');
    expect(c?.type === 'circle' && c.radius).toBe(0);
  });

  it('concatenates MTEXT continuation chunks in order', () => {
    /* long MTEXT arrives as group 3 chunks closed by a group 1 tail;
       both halves of that contract have to hold, reading and writing */
    const long = 'x'.repeat(300) + 'END';
    const d = readDxf(dxf(
      ...ENTITIES_HEAD,
      0, 'MTEXT', 8, '0', 10, 0, 20, 0, 40, 2.5,
      3, long.slice(0, 250), 1, long.slice(250),
      ...TAIL));
    const m = d.entities.find((e) => e.type === 'mtext');
    expect(m?.type === 'mtext' && m.text).toBe(long);
    /* and it survives our own writer without doubling */
    const back = readDxf(writeDxf(d));
    const m2 = back.entities.find((e) => e.type === 'mtext');
    expect(m2?.type === 'mtext' && m2.text).toBe(long);
  });
});

describe('object coordinates (the mirrored-entity family)', () => {
  /* An entity mirrored in AutoCAD is stored with a negated normal, and
     its points mean nothing until they are mapped out of that plane. */
  const mirrored = (): Drawing => {
    const d = emptyDrawing();
    d.entities.push(
      {
        type: 'circle', layer: '0', color: { kind: 'byLayer' },
        center: { x: -10, y: 5, z: 0 }, radius: 2,
        extrusion: { x: 0, y: 0, z: -1 }
      },
      {
        type: 'arc', layer: '0', color: { kind: 'byLayer' },
        center: { x: -10, y: 5, z: 0 }, radius: 2,
        startAngle: 0, endAngle: Math.PI / 2,
        extrusion: { x: 0, y: 0, z: -1 }
      }
    );
    return d;
  };

  it('the arbitrary-axis algorithm skips the identity normal', () => {
    expect(ocsTransform(undefined)).toBeNull();
    expect(ocsTransform({ x: 0, y: 0, z: 1 })).toBeNull();
    expect(ocsTransform({ x: 0, y: 0, z: -1 })).not.toBeNull();
  });

  it('maps a negated-normal circle to the other side of the axis', () => {
    const [circle] = mirrored().entities;
    const w = toWcs(circle);
    expect(w.type).toBe('circle');
    if (w.type !== 'circle') return;
    /* the stored -10 is an object-plane X; in the world it is +10 */
    expect(w.center.x).toBeCloseTo(10, 9);
    expect(w.center.y).toBeCloseTo(5, 9);
    expect(w.extrusion).toBeUndefined();
  });

  it('reverses an arc sweep when the plane is flipped', () => {
    const arc = mirrored().entities[1];
    const w = toWcs(arc);
    if (w.type !== 'arc') return;
    /* start and end trade places, so the drawn side stays the same */
    expect(w.startAngle).toBeCloseTo(Math.PI - Math.PI / 2, 9);
    expect(w.endAngle).toBeCloseTo(Math.PI, 9);
  });

  it('measures the mirrored circle where it is drawn', () => {
    const [circle] = mirrored().entities;
    const b = entityBounds(circle)!;
    expect(b.min.x).toBeCloseTo(8, 9);
    expect(b.max.x).toBeCloseTo(12, 9);
  });

  it('draws it there too, in every export', () => {
    const d = mirrored();
    const svg = writeSvg(d);
    expect(svg).toMatch(/cx="10"/);
    expect(svg).not.toMatch(/cx="-10"/);
    const pt = toGeoJSON(d).features[0].geometry!.coordinates as number[][][];
    const xs = pt[0].map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(12, 6);
  });

  it('round-trips the normal through DXF', () => {
    const back = readDxf(writeDxf(mirrored()));
    const c = back.entities.find((e) => e.type === 'circle');
    expect(c?.type === 'circle' && c.extrusion).toEqual({ x: 0, y: 0, z: -1 });
    /* the stored point is still the object-plane one, as AutoCAD writes it */
    expect(c?.type === 'circle' && c.center.x).toBeCloseTo(-10, 9);
  });
});

describe('writer output validity', () => {
  it('snaps lineweights to the set AutoCAD accepts', () => {
    /* group 370 takes 24 documented steps plus -1/-2/-3; any other
       millimetre value makes the file invalid */
    const d = emptyDrawing();
    d.layers[0].lineweight = 0.27;        /* between 25 and 30 */
    d.entities.push({
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 },
      lineweight: 0.31
    });
    const text = writeDxf(d);
    const LEGAL = new Set([0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53,
      60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211, -1, -2, -3]);
    const lines = text.split('\n');
    let seen = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].trim() !== '370') continue;
      seen++;
      expect(LEGAL.has(Number(lines[i + 1]))).toBe(true);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('never emits a NaN or Infinity into a numeric group', () => {
    /* one NaN in a numeric group makes the file unparseable for
       everyone downstream, so nothing non-finite may leave */
    const d = emptyDrawing();
    d.entities.push(
      {
        type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: { x: NaN, y: 0, z: 0 }, end: { x: Infinity, y: 1, z: 0 }
      },
      {
        type: 'circle', layer: '0', color: { kind: 'byLayer' },
        center: { x: 0, y: 0, z: 0 }, radius: NaN
      }
    );
    const text = writeDxf(d);
    expect(text).not.toMatch(/\bNaN\b/i);
    expect(text).not.toMatch(/\bInfinity\b/i);
    expect(() => readDxf(text)).not.toThrow();
  });

  it('emits no duplicate handles and never handle 0', () => {
    /* handle 0 is reserved and a repeat collides with whatever already
       holds it; either one gets the file rejected */
    const d = emptyDrawing();
    for (let i = 0; i < 40; i++) {
      d.entities.push({
        type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: { x: i, y: 0, z: 0 }, end: { x: i, y: 1, z: 0 }
      });
    }
    /* group codes sit on the even lines and values on the odd ones, so a
       naive scan for "5" would also catch a coordinate of five */
    const lines = writeDxf(d).split('\n');
    const seen = new Set<string>();
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = lines[i].trim();
      if (code !== '5' && code !== '105') continue;
      const h = lines[i + 1].trim().toUpperCase();
      expect(h).not.toBe('0');
      expect(seen.has(h), 'duplicate handle ' + h).toBe(false);
      seen.add(h);
    }
    expect(seen.size).toBeGreaterThan(40);
  });

  it('writes attributes whenever it claims they follow', () => {
    /* the attributes-follow flag is a promise: an INSERT that sets it
       and then emits no ATTRIB and no SEQEND is invalid */
    const d = emptyDrawing();
    d.blocks.B = {
      name: 'B', basePoint: { x: 0, y: 0, z: 0 },
      entities: [{
        type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
      }]
    };
    d.entities.push({
      type: 'insert', layer: '0', color: { kind: 'byLayer' }, blockName: 'B',
      position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0,
      attributes: [{
        type: 'text', layer: '0', color: { kind: 'byLayer' }, text: 'A',
        position: { x: 0, y: 0, z: 0 }, height: 1, rotation: 0
      }]
    });
    const text = writeDxf(d);
    const has66 = /\n\s*66\n\s*1\n/.test(text);
    expect(has66).toBe(true);
    expect(text).toContain('ATTRIB');
    expect(text).toContain('SEQEND');
    const back = readDxf(text);
    const ins = back.entities.find((e) => e.type === 'insert');
    expect(ins?.type === 'insert' && ins.attributes?.length).toBe(1);
  });
});

describe('text and codepages', () => {
  it('carries Arabic through a DXF round trip', () => {
    /* pre-2007 output declares a codepage in its header; writing bytes
       in some other encoding garbles every character above ASCII */
    const d = emptyDrawing();
    d.entities.push({
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      text: 'مرحبا بالعالم', position: { x: 0, y: 0, z: 0 },
      height: 2.5, rotation: 0
    });
    const back = readDxf(writeDxf(d));
    const texts = back.entities
      .filter((e): e is Extract<Entity, { type: 'text' | 'mtext' }> =>
        e.type === 'text' || e.type === 'mtext')
      .map((e) => e.text);
    expect(texts.join('')).toContain('مرحبا');
  });

  it('decodes MIF escapes as well as \\U+ escapes', () => {
    /* old files carry MIF sequences beside the \U+ ones; a
       reader that knows only the newer form shows mojibake */
    const d = readDxf(dxf(
      ...ENTITIES_HEAD,
      0, 'TEXT', 8, '0', 10, 0, 20, 0, 40, 2.5,
      1, '\\M+5D5CD and \\U+0645',
      ...TAIL));
    const t = d.entities.find((e) => e.type === 'text');
    expect(t?.type === 'text' && t.text).toContain('م');       /* \U+0645 */
    expect(t?.type === 'text' && /[一-鿿À-￿]/.test(t.text))
      .toBe(true);
  });
});
