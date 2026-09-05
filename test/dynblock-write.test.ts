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
import type { UnknownObject } from '../src/core/model.js';
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

/* The parameter alone was never enough: a BLOCKVISIBILITYPARAMETER owned
   by the block header, with no graph around it, is refused outright by
   the reference (ErrorStatus 53) in every release — for a drawing
   authored through the model just as for one of the reference's own.
   What it accepts, measured on its re-save of a visibility-only block, is
   the chain below; the reader seals every record of it but the
   parameter, so the chain can be asserted on read-back. */
const kindOf = (u: UnknownObject): string =>
  (u.appClass?.dxfName ?? u.sourceType).toUpperCase();

describe.each(VERSIONS)('the graph around the parameter %s', (version) => {
  const back = readDwg(WRITERS[version](doorDrawing()).data);
  const sealed = back.unknownObjects ?? [];
  const byKind = (k: string): UnknownObject[] =>
    sealed.filter((u) => kindOf(u) === k);

  it('is the reference\'s chain: graph, grip, two components, preventer', () => {
    expect(byKind('ACAD_EVALUATION_GRAPH')).toHaveLength(1);
    expect(byKind('BLOCKVISIBILITYGRIP')).toHaveLength(1);
    expect(byKind('BLOCKGRIPLOCATIONCOMPONENT')).toHaveLength(2);
    expect(byKind('ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION')).toHaveLength(1);
  });

  it('wires the chain the way the reference does', () => {
    const graph = byKind('ACAD_EVALUATION_GRAPH')[0];
    const grip = byKind('BLOCKVISIBILITYGRIP')[0];
    const comps = byKind('BLOCKGRIPLOCATIONCOMPONENT');
    const purge = byKind('ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION')[0];
    /* the grip and its components are nodes of the graph, hard-owned */
    for (const node of [grip, ...comps]) {
      expect(node.ownerHandle).toBe(graph.handle);
      expect(graph.refs).toContainEqual({ code: 3, value: node.handle });
    }
    /* four nodes: those three and the parameter */
    expect(graph.refs?.filter((r) => r.code === 3)).toHaveLength(4);
    /* graph and preventer hang off the block's extension dictionary,
       and the preventer names the block */
    expect(purge.ownerHandle).toBe(graph.ownerHandle);
    expect(purge.refs)
      .toContainEqual({ code: 5, value: back.blocks.DOOR.handle });
  });

  it('is rebuilt on the next write, not doubled, and not reported lost', () => {
    const again = WRITERS[version](back);
    expect(again.downgraded).toEqual([]);
    expect(again.skipped).toEqual([]);
    const third = readDwg(again.data);
    expect((third.unknownObjects ?? [])
      .filter((u) => kindOf(u) === 'ACAD_EVALUATION_GRAPH')).toHaveLength(1);
    expect(third.blocks.DOOR.visibilityStates?.map((s) => s.name))
      .toEqual(['Open', 'Closed']);
  });
});

/* A drawing in the shape the reference's own files take: the block's
   entities tagged AcDbBlockRepETag, an anonymous "*U" representation
   block beside the definition with an insert pointing at it, the
   evaluation graph and its nodes sealed among the unknown objects (here
   the ones this writer's own file came back with), a sealed
   representation record naming the block, and the block's other
   parameters and actions decoded beside its states. */
const genuineShape = (version: keyof typeof WRITERS): Drawing => {
  const d = readDwg(WRITERS[version](doorDrawing()).data);
  const door = d.blocks.DOOR;
  door.entities = door.entities.map((e, i): Entity => ({
    ...e,
    xdata: [{ appName: 'AcDbBlockRepETag', values: [
      { code: 1070, value: 1 }, { code: 1071, value: i },
      { code: 1005, value: e.handle ?? '0' }
    ] }]
  }));
  door.parameters = [{ kind: 'point', name: 'Position' } as never];
  door.actions = ['move'];
  d.blocks['*U1'] = {
    name: '*U1', basePoint: { x: 0, y: 0, z: 0 },
    entities: door.entities.map((e): Entity => ({ ...e, handle: undefined }))
  };
  d.entities.push({
    type: 'insert', layer: '0', color: { kind: 'byLayer' },
    blockName: '*U1', position: { x: 9, y: 9, z: 0 },
    scale: { x: 1, y: 1, z: 1 }, rotation: 0
  } as Entity);
  (d.unknownObjects ??= []).push({
    handle: 'F01', ownerHandle: 'F00',
    sourceType: 'ACDB_BLOCKREPRESENTATION_DATA',
    appClass: {
      dxfName: 'ACDB_BLOCKREPRESENTATION_DATA',
      cppName: 'AcDbBlockRepresentationData', appName: 'ObjectDBX Classes'
    },
    encoding: Number(version.slice(1)), data: 'gA==', dataBits: 2,
    refs: [{ code: 5, value: door.handle! }]
  });
  return d;
};

describe.each(VERSIONS)('a genuine dynamic block %s', (version) => {
  const src = genuineShape(version);
  const res = WRITERS[version](src);
  const back = readDwg(res.data);

  it('keeps its visibility states through the rewrite', () => {
    expect(back.blocks.DOOR.isDynamic).toBe(true);
    expect(back.blocks.DOOR.visibilityStates?.map((s) => [s.name, s.visible.length]))
      .toEqual([['Open', 1], ['Closed', 2]]);
    expect((back.unknownObjects ?? [])
      .filter((u) => kindOf(u) === 'ACAD_EVALUATION_GRAPH')).toHaveLength(1);
  });

  it('leaves the representation block a plain anonymous block', () => {
    expect(back.blocks['*U1']?.isDynamic).toBeFalsy();
    expect(back.blocks['*U1']?.entities).toHaveLength(2);
    expect(back.entities.filter((e) => e.type === 'insert')).toHaveLength(2);
  });

  it('reports the representation record and the static rest, not the graph', () => {
    expect(res.skipped).toEqual(['ACDB_BLOCKREPRESENTATION_DATA']);
    expect(res.downgraded).toEqual([
      'dynamic block DOOR: visibility states kept, 1 parameter(s) and 1 action(s) written static'
    ]);
  });
});
