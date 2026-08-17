/* nasjidwg — the auditor.
 *
 * Every check is proved from both sides: a drawing that trips it and the
 * repaired twin that must not. The corpus drawing anchors the negative
 * direction — a drawing this library considers healthy audits clean of
 * errors — and a set of deliberately hollow inputs proves the auditor
 * survives the drawings that need it most.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditDrawing } from '../src/core/audit.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';
import { writeDwg2018 } from '../src/dwg/writer.js';
import { runCli } from '../src/cli.js';
import { sampleDrawing } from './corpus.js';

const byLayer = { kind: 'byLayer' } as const;

/** A plain line, with overrides for the property under test. */
const line = (over: Partial<Extract<Entity, { type: 'line' }>> = {}): Entity => ({
  type: 'line', layer: '0', color: byLayer,
  start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }, ...over
});

const insert = (blockName: string): Entity => ({
  type: 'insert', layer: '0', color: byLayer, blockName,
  position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0
});

const proxy = (refs: { code: number; value: string }[]): Entity => ({
  type: 'proxy', layer: '0', color: byLayer,
  sourceType: 'ACAD_PROXY_ENTITY', graphics: [], refs
});

const codesOf = (d: Drawing): string[] => auditDrawing(d).map((f) => f.code);

/* ------------------------------------------------------------------ */

describe('auditDrawing basics', () => {
  it('the corpus drawing audits clean of errors', () => {
    const findings = auditDrawing(sampleDrawing());
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('a fresh empty drawing yields no findings at all', () => {
    expect(auditDrawing(emptyDrawing())).toEqual([]);
  });

  it('never throws on hollow or truncated input', () => {
    expect(() => auditDrawing(undefined as unknown as Drawing)).not.toThrow();
    expect(() => auditDrawing({} as Drawing)).not.toThrow();
    const gutted = {
      ...emptyDrawing(),
      layers: undefined, linetypes: undefined, textStyles: undefined,
      blocks: undefined, entities: undefined, warnings: undefined
    } as unknown as Drawing;
    expect(() => auditDrawing(gutted)).not.toThrow();
    /* optional arrays present but wrong-shaped must not crash either */
    const weird = {
      ...emptyDrawing(),
      groups: [null], proxyObjects: [null], entities: [null, line()]
    } as unknown as Drawing;
    expect(() => auditDrawing(weird)).not.toThrow();
  });

  it('orders errors before warnings before info', () => {
    const d = emptyDrawing();
    d.entities = [
      line({ handle: 'A1' }), line({ handle: 'A1' }),   /* error */
      line({ layer: 'GHOST' })                          /* warning */
    ];
    d.blocks = {
      HOLLOW: { name: 'HOLLOW', basePoint: { x: 0, y: 0, z: 0 }, entities: [] }
    };
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const ranks = auditDrawing(d).map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks).toContain(0);
    expect(ranks).toContain(1);
    expect(ranks).toContain(2);
  });
});

/* ------------------------------------------------------------------ */

describe('duplicate-handle', () => {
  it('flags a shared handle across containers, case-insensitively', () => {
    const d = emptyDrawing();
    d.entities = [line({ handle: '1F' })];
    d.blocks = {
      DOOR: {
        name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
        entities: [line({ handle: '1f' })]
      }
    };
    const hit = auditDrawing(d).find((f) => f.code === 'duplicate-handle');
    expect(hit?.severity).toBe('error');
    expect(hit?.handle).toBe('1F');
  });

  it('stays quiet when every handle is unique', () => {
    const d = emptyDrawing();
    d.entities = [line({ handle: '1F' }), line({ handle: '20' })];
    expect(codesOf(d)).not.toContain('duplicate-handle');
  });
});

describe('dangling-layer / dangling-linetype', () => {
  it('flags a layer no table defines, and accepts a case-mismatched one', () => {
    const d = emptyDrawing();
    d.entities = [line({ layer: 'GHOST' })];
    expect(codesOf(d)).toContain('dangling-layer');
    d.layers.push({
      name: 'Ghost', color: { kind: 'aci', index: 7 },
      on: true, frozen: false, locked: false
    });
    expect(codesOf(d)).not.toContain('dangling-layer');
  });

  it('flags a missing linetype but never the inherited names', () => {
    const d = emptyDrawing();
    d.entities = [line({ linetype: 'PHANTOM2' })];
    expect(codesOf(d)).toContain('dangling-linetype');
    /* ByBlock is not in any table, yet it is not a dangler */
    const d2 = emptyDrawing();
    d2.entities = [line({ linetype: 'ByBlock' }), line({ linetype: 'CONTINUOUS' })];
    expect(codesOf(d2)).not.toContain('dangling-linetype');
    /* and defining the linetype repairs the first drawing */
    d.linetypes.push({ name: 'Phantom2', pattern: [1, -0.5] });
    expect(codesOf(d)).not.toContain('dangling-linetype');
  });
});

describe('dangling-block', () => {
  it('an insert without a definition is an error; defining it repairs', () => {
    const d = emptyDrawing();
    d.entities = [insert('DOOR')];
    const hit = auditDrawing(d).find((f) => f.code === 'dangling-block');
    expect(hit?.severity).toBe('error');
    d.blocks = {
      Door: { name: 'Door', basePoint: { x: 0, y: 0, z: 0 }, entities: [line()] }
    };
    expect(codesOf(d)).not.toContain('dangling-block');
  });
});

describe('dangling-style', () => {
  it('flags a text style absent from the style table', () => {
    const d = emptyDrawing();
    d.entities = [{
      type: 'text', layer: '0', color: byLayer, text: 'hi',
      position: { x: 0, y: 0, z: 0 }, height: 1, rotation: 0, style: 'Fancy'
    }];
    expect(codesOf(d)).toContain('dangling-style');
    d.textStyles.push({ name: 'FANCY' });
    expect(codesOf(d)).not.toContain('dangling-style');
  });

  it('flags a dimension style absent from the dimension style table', () => {
    const d = emptyDrawing();
    d.entities = [{
      type: 'dimension', layer: '0', color: byLayer, dimensionType: 0,
      definitionPoint: { x: 0, y: 0, z: 0 }, style: 'S9'
    }];
    expect(codesOf(d)).toContain('dangling-style');
    d.dimStyles = [{ name: 's9' }];
    expect(codesOf(d)).not.toContain('dangling-style');
  });
});

describe('dangling-ref', () => {
  it('an unresolved proxy reference is info, never an error', () => {
    const d = emptyDrawing();
    d.entities = [proxy([{ code: 4, value: 'ABCD' }])];
    const hits = auditDrawing(d).filter((f) => f.code === 'dangling-ref');
    expect(hits.length).toBe(1);
    expect(hits.every((f) => f.severity === 'info')).toBe(true);
  });

  it('resolves references against handles anywhere in the drawing', () => {
    const d = emptyDrawing();
    /* leading zeros do not count: 00AB is the same handle as AB */
    d.entities = [proxy([{ code: 4, value: '00AB' }]), line({ handle: 'AB' })];
    expect(codesOf(d)).not.toContain('dangling-ref');
  });

  it('checks dictionary proxy objects the same way', () => {
    const d = emptyDrawing();
    d.proxyObjects = [{ handle: 'E0', refs: [{ code: 3, value: 'FFFF' }] }];
    expect(codesOf(d)).toContain('dangling-ref');
  });
});

describe('group-member-missing', () => {
  it('names exactly the member handle that resolves to nothing', () => {
    const d = emptyDrawing();
    d.entities = [line({ handle: '30' })];
    d.groups = [{ name: 'WALL', entityHandles: ['30', '99'] }];
    const hits = auditDrawing(d).filter((f) => f.code === 'group-member-missing');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('warning');
    expect(hits[0].handle).toBe('99');
    d.entities.push(line({ handle: '99' }));
    expect(codesOf(d)).not.toContain('group-member-missing');
  });
});

describe('non-finite-geometry', () => {
  it('flags NaN and Infinity wherever they hide in an entity', () => {
    const d = emptyDrawing();
    d.entities = [line({ start: { x: NaN, y: 0, z: 0 } })];
    const hit = auditDrawing(d).find((f) => f.code === 'non-finite-geometry');
    expect(hit?.severity).toBe('error');

    const d2 = emptyDrawing();
    d2.entities = [{
      type: 'polyline', layer: '0', color: byLayer, closed: false,
      vertices: [{ x: 0, y: 0, bulge: Infinity }, { x: 1, y: 0 }]
    }];
    expect(codesOf(d2)).toContain('non-finite-geometry');
  });

  it('accepts a drawing whose numbers are all finite', () => {
    const d = emptyDrawing();
    d.entities = [line()];
    expect(codesOf(d)).not.toContain('non-finite-geometry');
  });
});

describe('empty-block / zero-extent / header-extents-mismatch', () => {
  it('reports an empty block as info, but not an empty layout block', () => {
    const d = emptyDrawing();
    d.blocks = {
      HOLLOW: { name: 'HOLLOW', basePoint: { x: 0, y: 0, z: 0 }, entities: [] },
      '*Paper_Space': {
        name: '*Paper_Space', basePoint: { x: 0, y: 0, z: 0 },
        entities: [], isLayout: true
      }
    };
    const hits = auditDrawing(d).filter((f) => f.code === 'empty-block');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('info');
    expect(hits[0].message).toContain('HOLLOW');
  });

  it('reports header extents that collapse to a point', () => {
    const d = emptyDrawing();
    d.header.extMin = { x: 5, y: 5, z: 0 };
    d.header.extMax = { x: 5, y: 5, z: 0 };
    expect(codesOf(d)).toContain('zero-extent');
    d.header.extMax = { x: 6, y: 5, z: 0 };
    expect(codesOf(d)).not.toContain('zero-extent');
  });

  it('notices geometry outside the header extents, and only then', () => {
    const d = emptyDrawing();
    d.entities = [line({ end: { x: 50, y: 0, z: 0 } })];
    d.header.extMin = { x: 0, y: 0, z: 0 };
    d.header.extMax = { x: 10, y: 10, z: 0 };
    expect(codesOf(d)).toContain('header-extents-mismatch');
    d.header.extMax = { x: 50, y: 10, z: 0 };
    expect(codesOf(d)).not.toContain('header-extents-mismatch');
    /* without both extents the comparison is not computed at all */
    delete d.header.extMin;
    expect(codesOf(d)).not.toContain('header-extents-mismatch');
  });
});

describe('duplicate-table-entry', () => {
  it('flags one name held by two records, case-insensitively', () => {
    const d = emptyDrawing();
    d.layers.push(
      { name: 'Walls', color: byLayer, on: true, frozen: false, locked: false },
      { name: 'WALLS', color: byLayer, on: true, frozen: false, locked: false }
    );
    const hit = auditDrawing(d).find((f) => f.code === 'duplicate-table-entry');
    expect(hit?.severity).toBe('warning');
    expect(hit?.message.toLowerCase()).toContain('walls');
    d.layers.pop();
    expect(codesOf(d)).not.toContain('duplicate-table-entry');
  });

  it('covers the linetype and text style tables too', () => {
    const d = emptyDrawing();
    d.linetypes.push({ name: 'continuous', pattern: [] });
    d.textStyles.push({ name: 'STANDARD' });
    const hits = auditDrawing(d).filter((f) => f.code === 'duplicate-table-entry');
    expect(hits.length).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe('nasjidwg audit', () => {
  const OUT = mkdtempSync(join(tmpdir(), 'nasjidwg-audit-'));
  afterAll(() => rmSync(OUT, { recursive: true, force: true }));

  /** Run the CLI, capturing what it wrote to stdout/stderr. */
  const run = (...args: string[]) => {
    let out = '', err = '';
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out += String(c);
      return true;
    });
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      err += String(c);
      return true;
    });
    try {
      const code = runCli(args);
      return { code, out, err };
    } finally {
      so.mockRestore();
      se.mockRestore();
    }
  };

  it('a clean DWG exits 0, with and without --crc', () => {
    const path = join(OUT, 'clean.dwg');
    writeFileSync(path, writeDwg2018(sampleDrawing()).data);
    const plain = run('audit', path);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('audit: 0 errors');
    expect(run('audit', path, '--crc').code).toBe(0);
  });

  it('a DXF carrying a duplicated handle exits 1 and says why', () => {
    const path = join(OUT, 'dupe.dxf');
    const pairs: [number, string][] = [
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'LINE'], [5, 'AB'], [8, '0'],
      [10, '0'], [20, '0'], [30, '0'], [11, '1'], [21, '1'], [31, '0'],
      [0, 'LINE'], [5, 'AB'], [8, '0'],
      [10, '2'], [20, '2'], [30, '0'], [11, '3'], [21, '3'], [31, '0'],
      [0, 'ENDSEC'], [0, 'EOF']
    ];
    writeFileSync(path, pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n');
    const r = run('audit', path);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR duplicate-handle');
  });

  it('audit without a file is a usage error', () => {
    expect(run('audit').code).toBe(2);
  });
});
