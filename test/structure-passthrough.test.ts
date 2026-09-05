/* nasjidwg — the ownership-preserving passthrough, second round: the
 * owners the writer used to rebuild with fresh numbers.
 *
 * A layout, a view, the active viewport, a dimension style, a group, a
 * table or multileader style, the symbol-table controls, the root
 * dictionary and its sub-dictionaries all keep their source numbers
 * under preserveHandles now, so a sealed extension dictionary hanging
 * off any of them goes out under it — the layer table's ACAD_LAYERSTATES
 * / ACAD_LAYERFILTERS chain, a layout's thumbnail record, a view's.
 *
 * A dictionary of the named-objects tree is re-encoded from its entries
 * in every generation, and an XRECORD it lists from its typed values
 * (the grammar is fixed; only the string spelling moves), so both travel
 * across generations natively; a foreign class object the dictionary
 * listed is re-homed flat under the root instead of riding inside one of
 * the reference's own dictionaries as a proxy.
 *
 * The plot style name dictionary (ACDBDICTIONARYWDFLT) travels with its
 * default, the empty-bodied ACDBPLACEHOLDER, and the header names it.
 *
 * One CLASSES record per class name: a library-authored visibility
 * block beside a genuine graph's sealed nodes shares the numbers.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2007, writeDwg2018 } from '../src/dwg/writer.js';
import { readSections2004 } from '../src/dwg/sections2004.js';
import { readClasses } from '../src/dwg/classes.js';
import { BitWriter } from '../src/dwg/bitwriter.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, UnknownObject, XdataValue } from '../src/core/model.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const kindOf = (u: UnknownObject): string =>
  (u.appClass?.dxfName ?? u.sourceType).toUpperCase();

/** An XRECORD body in the given generation's spelling: the byte-counted
 *  run of (RS group, value), then the R2000+ cloning flag. */
const xrecordBits = (values: XdataValue[], gen: number): { data: string; dataBits: number } => {
  const run = new BitWriter();
  for (const v of values) {
    if ('point' in v) continue;
    run.rs(v.code);
    if (typeof v.value === 'string' && v.code < 10) {
      if (gen >= 2007) {
        run.rs(v.value.length);
        for (let i = 0; i < v.value.length; i++) run.rs(v.value.charCodeAt(i));
      } else {
        run.rs(v.value.length); run.rc(30);
        for (let i = 0; i < v.value.length; i++) run.rc(v.value.charCodeAt(i) & 0xff);
      }
    } else if (v.code === 70) run.rs(Number(v.value));
    else if (v.code === 330) run.rll(parseInt(String(v.value), 16));
  }
  const bytes = run.bytes();
  const w = new BitWriter();
  w.bl(bytes.length);
  w.raw(bytes);
  if (gen >= 2000) w.bs(1);
  return { data: b64(w.bytes()), dataBits: w.pos };
};

const base = (): Drawing => {
  const d = emptyDrawing();
  d.layers = [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }];
  d.entities = [
    {
      type: 'line', handle: 'A0', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 }
    },
    {
      type: 'line', handle: 'A1', layer: '0', color: { kind: 'byLayer' },
      start: { x: 0, y: 1, z: 0 }, end: { x: 1, y: 0, z: 0 }
    }
  ] as Entity[];
  return d;
};

const WRITERS = [
  ['R2018', writeDwg2018, 2018],
  ['R2007', writeDwg2007, 2007]
] as const;

describe.each(WRITERS)('owners that keep their numbers (%s)', (_v, writer, encoding) => {
  it('a layout, its extension dictionary and the record it lists', () => {
    const d = base();
    d.layouts = [
      { name: 'Model', tabOrder: 0, blockName: '*Model_Space', handle: '30' },
      { name: 'Layout1', tabOrder: 1, blockName: '*Paper_Space', handle: '31', xdict: 'B0' }
    ];
    d.unknownObjects = [
      {
        handle: 'B0', ownerHandle: '31', sourceType: 'DICTIONARY', typeCode: 42,
        encoding, hardOwner: false, cloning: 1,
        entries: [{ name: 'ADSK_XREC_LAYOUTTHUMBNAIL', handle: 'C0', code: 2 }]
      },
      {
        handle: 'C0', ownerHandle: 'B0', sourceType: 'XRECORD', typeCode: 79,
        encoding, ...xrecordBits([{ code: 1, value: 'AB' }], encoding)
      }
    ];
    const res = writer(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    const layout = back.layouts?.find((l) => l.name === 'Layout1');
    expect(layout?.handle).toBe('31');
    expect(layout?.xdict).toBe('B0');
    expect(back.layouts?.find((l) => l.name === 'Model')?.handle).toBe('30');
    const dict = back.unknownObjects?.find((u) => u.handle === 'B0');
    expect(dict?.ownerHandle).toBe('31');
    expect(dict?.entries).toEqual([{ name: 'ADSK_XREC_LAYOUTTHUMBNAIL', handle: 'C0', code: 2 }]);
    expect(back.unknownObjects?.find((u) => u.handle === 'C0')?.ownerHandle).toBe('B0');
    expect(back.xrecords?.find((x) => x.handle === 'C0')?.values).toEqual([{ code: 1, value: 'AB' }]);
  });

  it('the layer table (a control object) and the chain under it', () => {
    const d = base();
    d.structureHandles = { NOD: 'C', LAYER_CONTROL: '2' };
    d.unknownObjects = [
      {
        handle: 'D0', ownerHandle: '2', sourceType: 'DICTIONARY', typeCode: 42,
        encoding, hardOwner: true, cloning: 1,
        entries: [{ name: 'ACAD_LAYERSTATES', handle: 'D1', code: 3 }]
      },
      {
        handle: 'D1', ownerHandle: 'D0', name: 'ACAD_LAYERSTATES', sourceType: 'DICTIONARY',
        typeCode: 42, encoding, hardOwner: false, cloning: 1,
        entries: [{ name: 'State1', handle: 'D2', code: 2 }]
      },
      {
        handle: 'D2', ownerHandle: 'D1', name: 'State1', sourceType: 'XRECORD', typeCode: 79,
        encoding, ...xrecordBits([{ code: 1, value: 'State1' }, { code: 70, value: 2 }], encoding)
      }
    ];
    const res = writer(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.structureHandles?.LAYER_CONTROL).toBe('2');
    expect(back.structureHandles?.NOD).toBe('C');
    const xd = back.unknownObjects?.find((u) => u.handle === 'D0');
    expect(xd?.ownerHandle).toBe('2');
    expect(xd?.dictPath).toBeUndefined();
    expect(back.unknownObjects?.find((u) => u.handle === 'D1')?.ownerHandle).toBe('D0');
    expect(back.xrecords?.find((x) => x.handle === 'D2')?.values)
      .toEqual([{ code: 1, value: 'State1' }, { code: 70, value: 2 }]);
    /* and again: the numbers are the file's own now */
    const twice = readDwg(writer(back, { preserveHandles: true }).data);
    expect(twice.unknownObjects?.find((u) => u.handle === 'D0')?.ownerHandle).toBe('2');
    expect(twice.structureHandles?.LAYER_CONTROL).toBe('2');
  });

  it('a named view with its extension dictionary, and a group', () => {
    const d = base();
    d.views = [{
      name: 'Plan 1', center: { x: 1, y: 2 }, height: 3, width: 4,
      direction: { x: 0, y: 0, z: 1 }, target: { x: 5, y: 6, z: 0 },
      lensLength: 50, twist: 0.5, frontClip: 1, backClip: 2, viewMode: 2,
      renderMode: 0, ucsOrigin: { x: 1, y: 1, z: 0 }, ucsXAxis: { x: 1, y: 0, z: 0 },
      ucsYAxis: { x: 0, y: 1, z: 0 }, ucsElevation: 7, ucsOrthoType: 0,
      handle: '40', xdict: 'B1'
    }];
    d.groups = [{ name: 'G1', description: 'both lines', selectable: true, entityHandles: ['A0', 'A1'], handle: '50' }];
    d.unknownObjects = [
      {
        handle: 'B1', ownerHandle: '40', sourceType: 'DICTIONARY', typeCode: 42,
        encoding, hardOwner: false, cloning: 1,
        entries: [{ name: 'ADSK_XREC_VTRVIEWINFO', handle: 'C1', code: 2 }]
      },
      {
        handle: 'C1', ownerHandle: 'B1', sourceType: 'XRECORD', typeCode: 79,
        encoding, ...xrecordBits([{ code: 1, value: 'Plans' }], encoding)
      }
    ];
    const res = writer(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const vw = back.views?.[0];
    expect(vw?.name).toBe('Plan 1');
    expect(vw?.handle).toBe('40');
    expect(vw?.xdict).toBe('B1');
    expect(vw?.height).toBeCloseTo(3); expect(vw?.width).toBeCloseTo(4);
    expect(vw?.center).toEqual({ x: 1, y: 2 });
    expect(vw?.target).toEqual({ x: 5, y: 6, z: 0 });
    expect(vw?.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(vw?.twist).toBeCloseTo(0.5);
    expect(vw?.lensLength).toBeCloseTo(50);
    expect(vw?.frontClip).toBeCloseTo(1); expect(vw?.backClip).toBeCloseTo(2);
    expect(vw?.viewMode).toBe(2);
    expect(vw?.ucsOrigin).toEqual({ x: 1, y: 1, z: 0 });
    expect(vw?.ucsElevation).toBeCloseTo(7);
    expect(back.unknownObjects?.find((u) => u.handle === 'B1')?.ownerHandle).toBe('40');
    expect(back.xrecords?.find((x) => x.handle === 'C1')?.values).toEqual([{ code: 1, value: 'Plans' }]);
    const g = back.groups?.[0];
    expect(g?.name).toBe('G1');
    expect(g?.handle).toBe('50');
    expect(g?.description).toBe('both lines');
    expect(g?.entityHandles).toEqual(['A0', 'A1']);
  });

  it('the plot style name dictionary with its default placeholder', () => {
    const d = base();
    d.structureHandles = { NOD: 'C' };
    d.unknownObjects = [
      {
        handle: 'E', ownerHandle: 'C', name: 'ACAD_PLOTSTYLENAME',
        sourceType: 'ACDBDICTIONARYWDFLT',
        appClass: { dxfName: 'ACDBDICTIONARYWDFLT', cppName: 'AcDbDictionaryWithDefault', appName: 'ObjectDBX Classes' },
        encoding, dictPath: [], hardOwner: false, cloning: 1,
        entries: [{ name: 'Normal', handle: 'F', code: 2 }], defaultHandle: 'F'
      },
      {
        handle: 'F', ownerHandle: 'E', name: 'Normal', sourceType: 'ACDBPLACEHOLDER',
        typeCode: 80, encoding, dictPath: ['ACAD_PLOTSTYLENAME']
      }
    ];
    const res = writer(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    const wd = back.unknownObjects?.find((u) => u.handle === 'E');
    expect(wd && kindOf(wd)).toBe('ACDBDICTIONARYWDFLT');
    expect(wd?.name).toBe('ACAD_PLOTSTYLENAME');
    expect(wd?.dictPath).toEqual([]);
    expect(wd?.entries).toEqual([{ name: 'Normal', handle: 'F', code: 2 }]);
    expect(wd?.defaultHandle).toBe('F');
    const ph = back.unknownObjects?.find((u) => u.handle === 'F');
    expect(ph && kindOf(ph)).toBe('ACDBPLACEHOLDER');
    expect(ph?.ownerHandle).toBe('E');
  });
});

describe('a tree dictionary of another generation', () => {
  const tree = (gen: number): Drawing => {
    const d = base();
    d.structureHandles = { NOD: 'C' };
    const values: XdataValue[] = [{ code: 1, value: 'AB' }, { code: 70, value: 5 }, { code: 330, value: 'A0' }];
    d.unknownObjects = [
      {
        handle: 'E0', ownerHandle: 'C', name: 'AcadDim', sourceType: 'DICTIONARY', typeCode: 42,
        encoding: gen, dictPath: [], hardOwner: false, cloning: 1,
        entries: [{ name: 'X1', handle: 'E1', code: 2 }, { name: 'S1', handle: 'E2', code: 2 }]
      },
      {
        handle: 'E1', ownerHandle: 'E0', name: 'X1', sourceType: 'XRECORD', typeCode: 79,
        encoding: gen, dictPath: ['AcadDim'], ...xrecordBits(values, gen)
      },
      {
        /* a class object of that generation — one of the reference's own
           classes, so it leaves as a proxy under the filer that wrote
           its bits (which the reference unwraps on open) and stays
           listed by the dictionary like a native record */
        handle: 'E2', ownerHandle: 'E0', name: 'S1', sourceType: 'SCALE',
        appClass: { dxfName: 'SCALE', cppName: 'AcDbScale', appName: 'ObjectDBX Classes' },
        encoding: gen, dictPath: ['AcadDim'], data: 'gA==', dataBits: 2
      }
    ];
    d.xrecords = [{ handle: 'E1', name: 'X1', values }];
    return d;
  };

  it.each([
    ['R2007 into R2018', 2007, writeDwg2018],
    ['R2018 into R2007', 2018, writeDwg2007],
    ['R2018 into R2000', 2018, writeDwg2000]
  ] as const)('%s: re-encoded from its entries, the XRECORD from its values', (_n, gen, writer) => {
    const res = writer(tree(gen), { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    expect(back.warnings).toEqual([]);
    const dict = back.unknownObjects?.find((u) => u.handle === 'E0');
    expect(dict?.name).toBe('AcadDim');
    expect(dict?.dictPath).toEqual([]);
    expect(dict?.entries).toEqual([
      { name: 'X1', handle: 'E1', code: 2 }, { name: 'S1', handle: 'E2', code: 2 }
    ]);
    const rec = back.unknownObjects?.find((u) => u.handle === 'E1');
    expect(rec && kindOf(rec)).toBe('XRECORD');
    expect(rec?.ownerHandle).toBe('E0');
    expect(rec?.dictPath).toEqual(['AcadDim']);
    expect(back.xrecords?.find((x) => x.handle === 'E1')?.values)
      .toEqual([{ code: 1, value: 'AB' }, { code: 70, value: 5 }, { code: 330, value: 'A0' }]);
    /* the scale is in the file, listed where it was, in its own
       generation: a filer-tagged proxy re-sealed by the reader */
    const scale = back.unknownObjects?.find((u) => u.handle === 'E2');
    expect(scale && kindOf(scale)).toBe('SCALE');
    expect(scale?.dictPath).toEqual(['AcadDim']);
    expect(scale?.ownerHandle).toBe('E0');
    expect(scale?.encoding).toBe(gen);
    expect(scale?.data).toBe('gA==');
    expect(scale?.dataBits).toBe(2);
  });

  it('a decode that stopped short keeps its bits, and a wrapped XRECORD stays home rather than ride a tree dictionary', () => {
    const d = tree(2007);
    /* the model's values do not account for every byte the record declares */
    d.xrecords = [{ handle: 'E1', name: 'X1', values: [{ code: 1, value: 'AB' }] }];
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual(["XRECORD (of another generation, listed by one of the reference's own dictionaries)"]);
    const back = readDwg(res.data);
    expect(back.unknownObjects?.some((u) => u.handle === 'E1')).toBe(false);
    /* the dictionary still lists the scale — a filer-tagged proxy of one
       of the reference's own classes counts as native — so it stays */
    expect(back.unknownObjects?.find((u) => u.handle === 'E0')?.entries)
      .toEqual([{ name: 'S1', handle: 'E2', code: 2 }]);
    expect(back.unknownObjects?.find((u) => u.handle === 'E2')?.dictPath).toEqual(['AcadDim']);
  });

  it("the reference's standard visual styles are dropped as a set; another name is reported", () => {
    const d = base();
    d.structureHandles = { NOD: 'C' };
    const vs = (h: string, name: string): UnknownObject => ({
      handle: h, ownerHandle: 'F0', name, sourceType: 'VISUALSTYLE',
      appClass: { dxfName: 'VISUALSTYLE', cppName: 'AcDbVisualStyle', appName: 'ObjectDBX Classes' },
      encoding: 2007, dictPath: ['ACAD_VISUALSTYLE'], data: 'gA==', dataBits: 2
    });
    d.unknownObjects = [
      {
        handle: 'F0', ownerHandle: 'C', name: 'ACAD_VISUALSTYLE', sourceType: 'DICTIONARY',
        typeCode: 42, encoding: 2007, dictPath: [], hardOwner: true, cloning: 1,
        entries: [{ name: 'Conceptual', handle: 'F1', code: 3 }, { name: 'MyStyle', handle: 'F2', code: 3 }]
      },
      vs('F1', 'Conceptual'), vs('F2', 'MyStyle')
    ];
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual([
      "1 VISUALSTYLE records (the reference's standard set, in another generation's spelling; recreated on open)"
    ]);
    /* the other name travels: a filer-tagged proxy of the reference's own
       class, listed by its dictionary, re-sealed in its generation */
    const back = readDwg(res.data);
    const styles = (back.unknownObjects ?? []).filter((u) => kindOf(u) === 'VISUALSTYLE');
    expect(styles.map((u) => u.handle)).toEqual(['F2']);
    expect(styles[0].dictPath).toEqual(['ACAD_VISUALSTYLE']);
    expect(styles[0].encoding).toBe(2007);
  });
});

describe('one CLASSES record per class name', () => {
  it('a library-authored visibility block beside a genuine graph node shares the numbers', () => {
    const d = base();
    d.blocks = {
      DOOR: {
        name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
        entities: [
          {
            type: 'line', handle: 'A2', layer: '0', color: { kind: 'byLayer' },
            start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
          },
          {
            type: 'circle', handle: 'A3', layer: '0', color: { kind: 'byLayer' },
            center: { x: 0.5, y: 0.5, z: 0 }, radius: 0.5
          }
        ] as Entity[],
        visibilityName: 'Door State', visibilityPrompt: 'Pick a state',
        visibilityStates: [{ name: 'Open', visible: ['A2'] }, { name: 'Closed', visible: ['A2', 'A3'] }]
      }
    };
    (d.entities[0] as Entity & { xdict?: string }).xdict = 'B0';
    /* a genuine node of that class, sealed under an entity's dictionary */
    d.unknownObjects = [
      {
        handle: 'B0', ownerHandle: 'A0', sourceType: 'DICTIONARY', typeCode: 42,
        encoding: 2018, hardOwner: true, cloning: 1,
        entries: [{ name: 'ACAD_ENHANCEDBLOCK', handle: 'B2', code: 3 }]
      },
      {
        handle: 'B2', ownerHandle: 'B0', sourceType: 'BLOCKVISIBILITYPARAMETER',
        appClass: { dxfName: 'BLOCKVISIBILITYPARAMETER', cppName: 'AcDbBlockVisibilityParameter', appName: 'ObjectDBX Classes' },
        encoding: 2018, data: 'gA==', dataBits: 2
      }
    ];
    const res = writeDwg2018(d, { preserveHandles: true });
    expect(res.skipped).toEqual([]);
    const classes = readClasses(readSections2004(res.data).get('AcDb:Classes')!, 'R2018');
    const names = [...classes.values()].map((c) => c.dxfName);
    expect(names.filter((n) => n === 'BLOCKVISIBILITYPARAMETER')).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    /* numbered densely from 500, in file order */
    expect([...classes.keys()].sort((a, b) => a - b)).toEqual(names.map((_, i) => 500 + i));
    const back = readDwg(res.data);
    expect(back.blocks.DOOR.visibilityStates?.map((s) => s.name)).toEqual(['Open', 'Closed']);
    const node = back.unknownObjects?.find((u) => u.handle === 'B2');
    expect(node && kindOf(node)).toBe('BLOCKVISIBILITYPARAMETER');
  });
});
