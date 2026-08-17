/* nasjidwg — dynamic-block visibility write-back.
 *
 * The visibility parameter is the one dynamic-block record that changes
 * what a viewer draws, and the reader has long decoded it. The claim
 * under test: a block whose model carries visibility states leaves
 * through every R2000+ writer as a real BLOCKVISIBILITYPARAMETER —
 * named, prompted, member list and per-state entity lists remapped onto
 * the written file's handles — and comes back through the reader as the
 * same dynamic block. R13/R14 cannot name application classes, and the
 * writer says so instead of writing a record no reader would resolve.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018, writeDwgR13
} from '../src/dwg/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity } from '../src/core/model.js';

const WRITERS = {
  R2000: writeDwg2000, R2004: writeDwg2004,
  R2007: writeDwg2007, R2018: writeDwg2018
} as const;
const VERSIONS = Object.keys(WRITERS) as (keyof typeof WRITERS)[];

const doorDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.layers = [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
  d.blocks = {
    DOOR: {
      name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
      entities: [
        {
          type: 'line', handle: 'A1', layer: '0', color: { kind: 'byLayer' },
          start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
        },
        {
          type: 'circle', handle: 'A2', layer: '0', color: { kind: 'byLayer' },
          center: { x: 0.5, y: 0.5, z: 0 }, radius: 0.5
        }
      ] as Entity[],
      visibilityName: 'Door State',
      visibilityPrompt: 'Pick a state',
      visibilityStates: [
        { name: 'Open', visible: ['A1'] },
        { name: 'Closed', visible: ['A1', 'A2'] }
      ]
    }
  };
  d.entities = [{
    type: 'insert', layer: '0', color: { kind: 'byLayer' },
    blockName: 'DOOR', position: { x: 5, y: 5, z: 0 },
    scale: { x: 1, y: 1, z: 1 }, rotation: 0
  } as Entity];
  return d;
};

describe.each(VERSIONS)('dynamic-block visibility %s', (version) => {
  const { data, skipped } = WRITERS[version](doorDrawing());
  const back = readDwg(data);
  const door = back.blocks.DOOR;

  it('writes cleanly and reads without warnings', () => {
    expect(skipped).toEqual([]);
    expect(back.warnings).toEqual([]);
  });

  it('comes back flagged dynamic, with its name and prompt', () => {
    expect(door?.isDynamic).toBe(true);
    expect(door?.visibilityName).toBe('Door State');
    expect(door?.visibilityPrompt).toBe('Pick a state');
  });

  it('keeps every state, in order, pointing at the right entities', () => {
    expect(door?.visibilityStates?.map((s) => s.name))
      .toEqual(['Open', 'Closed']);
    const line = door?.entities.find((e) => e.type === 'line');
    const circle = door?.entities.find((e) => e.type === 'circle');
    expect(door?.visibilityStates?.[0].visible).toEqual([line?.handle]);
    expect(door?.visibilityStates?.[1].visible.sort())
      .toEqual([line?.handle, circle?.handle].sort());
  });

  it('survives a second generation, remapped through the read handles', () => {
    const again = readDwg(WRITERS[version](back).data);
    const door2 = again.blocks.DOOR;
    expect(door2?.isDynamic).toBe(true);
    expect(door2?.visibilityStates?.map((s) => s.name))
      .toEqual(['Open', 'Closed']);
    expect(door2?.visibilityStates?.[0].visible.length).toBe(1);
    expect(door2?.visibilityStates?.[1].visible.length).toBe(2);
  });
});

describe('R13 is honest about visibility states', () => {
  it('reports the downgrade instead of writing an unresolvable record', () => {
    const { skipped } = writeDwgR13(doorDrawing());
    expect(skipped)
      .toContain('dynamic-block visibility of DOOR (needs R2000 or later)');
  });
});
