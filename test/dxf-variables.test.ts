/* nasjidwg — two named-object families through the DXF codec, mirroring
 * the DWG side:
 *   - the drawing's variable dictionary: `drawing.variables` (the
 *     DICTIONARYVARs of the root's AcDbVariableDictionary — CANNOSCALE,
 *     CTABLESTYLE, DIMASSOC, LIGHTINGUNITS …) written in the reference's
 *     R2000 spelling and read back by name, one record per variable,
 *     the dictionary and its class the writer's own;
 *   - multiline styles: every `drawing.mlineStyles` record written under
 *     ACAD_MLINESTYLE with its elements (49 offset, 62 colour, 6
 *     linetype), fill colour, flags and angles, each MLINE's 2 and 340
 *     naming its style, and read back the same way.
 */
import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, Entity, MLineStyle } from '../src/core/model.js';

const recordsOf = (text: string): { type: string; groups: [number, string][] }[] => {
  const lines = text.split('\n');
  const recs: { type: string; groups: [number, string][] }[] = [];
  let cur: { type: string; groups: [number, string][] } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i], 10);
    if (c === 0) { cur = { type: lines[i + 1], groups: [] }; recs.push(cur); }
    else if (cur) cur.groups.push([c, lines[i + 1]]);
  }
  return recs;
};
const groupOf = (r: { groups: [number, string][] }, code: number): string | undefined =>
  r.groups.find(([c]) => c === code)?.[1];
const groupsOf = (r: { groups: [number, string][] }, code: number): string[] =>
  r.groups.filter(([c]) => c === code).map(([, v]) => v);
const ownHandle = (r: { groups: [number, string][] }): string | undefined => {
  const at = r.groups.findIndex(([c]) => c === 100);
  return r.groups.slice(0, at < 0 ? undefined : at).find(([c]) => c === 5)?.[1];
};
const entriesOf = (r: { groups: [number, string][] }): [string, string][] => {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < r.groups.length; i++) {
    if (r.groups[i][0] === 3) out.push([r.groups[i][1], r.groups[i + 1][1]]);
  }
  return out;
};
const rootOf = (recs: ReturnType<typeof recordsOf>) =>
  recs.find((r) => r.type === 'DICTIONARY' && groupOf(r, 330) === '0')!;

/* ------------------------------------------------------------------ */

describe('the variable dictionary through DXF', () => {
  const base = (): Drawing => {
    const d = emptyDrawing();
    d.variables = [
      { name: 'CANNOSCALE', value: '1:1', handle: 'B1' },
      { name: 'CTABLESTYLE', value: 'Standard' },
      { name: 'DIMASSOC', value: '2', schema: 0 },
      { name: 'LIGHTINGUNITS', value: '2', handle: 'B4', xdict: 'B5' }
    ];
    d.structureHandles = { NOD: 'C', ACDBVARIABLEDICTIONARY: 'B0' };
    /* an extension dictionary on one variable, listing an XRECORD */
    d.unknownObjects = [
      { handle: 'B5', ownerHandle: 'B4', sourceType: 'DICTIONARY', typeCode: 42, hardOwner: true,
        entries: [{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'B6', code: 3 }] },
      { handle: 'B6', ownerHandle: 'B5', sourceType: 'XRECORD', typeCode: 79 }
    ];
    d.xrecords = [{ handle: 'B6', name: 'ACAD_XREC_ROUNDTRIP', values: [{ code: 1, value: 'kept' }] }];
    return d;
  };

  it('writes each variable in the reference\'s R2000 spelling under AcDbVariableDictionary', () => {
    const d = base();
    const text = writeDxf(d);
    const recs = recordsOf(text);
    const root = rootOf(recs);
    const [, dictH] = entriesOf(root).find(([k]) => k === 'AcDbVariableDictionary')!;
    const dict = recs.find((r) => r.type === 'DICTIONARY' && ownHandle(r) === dictH)!;
    expect(groupOf(dict, 330)).toBe(ownHandle(root));
    expect(entriesOf(dict).map(([k]) => k)).toEqual(['CANNOSCALE', 'CTABLESTYLE', 'DIMASSOC', 'LIGHTINGUNITS']);
    const vars = recs.filter((r) => r.type === 'DICTIONARYVAR');
    expect(vars.length).toBe(4);
    for (const v of vars) {
      expect(groupOf(v, 330)).toBe(dictH);
      const r = v.groups.findIndex(([c, x]) => c === 102 && x === '{ACAD_REACTORS');
      expect(v.groups[r + 1]).toEqual([330, dictH]);
      expect(groupOf(v, 100)).toBe('DictionaryVariables');
      expect(groupOf(v, 280)).toBe('0');
    }
    expect(entriesOf(dict).map(([, h]) => h)).toEqual(vars.map(ownHandle));
    expect(vars.map((v) => groupOf(v, 1))).toEqual(['1:1', 'Standard', '2', '2']);
    expect(recs.some((r) => r.type === 'CLASS' && groupOf(r, 1) === 'DICTIONARYVAR'
      && groupOf(r, 2) === 'AcDbDictionaryVar')).toBe(true);
    expect(d.warnings).toEqual([]);
  });

  it('keeps the source numbers under preserveHandles and re-attaches a variable\'s extension dictionary', () => {
    const d = base();
    const text = writeDxf(d, { preserveHandles: true });
    const recs = recordsOf(text);
    const dict = recs.find((r) => r.type === 'DICTIONARY' && ownHandle(r) === 'B0')!;
    expect(entriesOf(dict)).toContainEqual(['CANNOSCALE', 'B1']);
    expect(entriesOf(dict)).toContainEqual(['LIGHTINGUNITS', 'B4']);
    const lu = recs.find((r) => r.type === 'DICTIONARYVAR' && ownHandle(r) === 'B4')!;
    const at = lu.groups.findIndex(([c, x]) => c === 102 && x === '{ACAD_XDICTIONARY');
    expect(lu.groups[at + 1]).toEqual([360, 'B5']);
    const xd = recs.find((r) => r.type === 'DICTIONARY' && ownHandle(r) === 'B5')!;
    expect(groupOf(xd, 330)).toBe('B4');
    expect(entriesOf(xd)).toEqual([['ACAD_XREC_ROUNDTRIP', 'B6']]);
    expect(recs.find((r) => r.type === 'XRECORD' && ownHandle(r) === 'B6')).toBeTruthy();
  });

  it('reads them back as the drawing\'s own, nothing of it sealed', () => {
    const d = base();
    for (const preserveHandles of [true, false]) {
      const back = readDxf(writeDxf(d, { preserveHandles }));
      expect((back.variables ?? []).map((v) => [v.name, v.value]))
        .toEqual([['CANNOSCALE', '1:1'], ['CTABLESTYLE', 'Standard'], ['DIMASSOC', '2'], ['LIGHTINGUNITS', '2']]);
      expect((back.unknownObjects ?? []).filter((u) => /DICTIONARYVAR/i.test(u.sourceType))).toEqual([]);
      expect((back.unknownObjects ?? []).some((u) => /variabledictionary/i.test(u.name ?? ''))).toBe(false);
      expect(back.structureHandles?.ACDBVARIABLEDICTIONARY).toBeDefined();
      expect(back.structureHandles?.NOD).toBeDefined();
      if (preserveHandles) {
        expect(back.variables?.find((v) => v.name === 'CANNOSCALE')?.handle).toBe('B1');
        expect(back.variables?.find((v) => v.name === 'LIGHTINGUNITS')?.xdict).toBe('B5');
        expect(back.structureHandles?.ACDBVARIABLEDICTIONARY).toBe('B0');
      } else {
        expect(back.variables?.find((v) => v.name === 'LIGHTINGUNITS')?.xdict).toBeDefined();
      }
      /* the extension dictionary rides with its variable */
      const lu = back.variables?.find((v) => v.name === 'LIGHTINGUNITS');
      const xd = back.unknownObjects?.find((u) => u.handle === lu?.xdict);
      expect(xd?.ownerHandle).toBe(lu?.handle);
      expect(xd?.entries?.[0].name).toBe('ACAD_XREC_ROUNDTRIP');
    }
  });

  it('a DICTIONARYVAR sealed as tags under that dictionary is written natively, once', () => {
    const rows = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'CLASSES',
      '0', 'CLASS', '1', 'DICTIONARYVAR', '2', 'AcDbDictionaryVar', '3', 'ObjectDBX Classes', '90', '0', '280', '0', '281', '0',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'OBJECTS',
      '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1',
      '3', 'AcDbVariableDictionary', '350', '70', '3', 'ACME_VARS', '350', '80',
      '0', 'DICTIONARY', '5', '70', '330', 'C', '100', 'AcDbDictionary', '281', '1',
      '3', 'CANNOSCALE', '350', '71', '3', 'PSOLHEIGHT', '350', '72',
      '0', 'DICTIONARY', '5', '80', '330', 'C', '100', 'AcDbDictionary', '281', '1',
      '3', 'ACME_ONE', '350', '81',
      '0', 'DICTIONARYVAR', '5', '71', '330', '70', '100', 'DictionaryVariables', '280', '0', '1', '1:2',
      '0', 'DICTIONARYVAR', '5', '72', '330', '70', '100', 'DictionaryVariables', '280', '0', '1', '80',
      '0', 'DICTIONARYVAR', '5', '81', '330', '80', '100', 'DictionaryVariables', '280', '0', '1', 'x',
      '0', 'ENDSEC', '0', 'EOF', ''];
    const d = readDxf(rows.join('\n'));
    /* the root's are the drawing's variables; the one under another
       dictionary stays sealed as tags at its place on the tree */
    expect((d.variables ?? []).map((v) => [v.name, v.value, v.handle]))
      .toEqual([['CANNOSCALE', '1:2', '71'], ['PSOLHEIGHT', '80', '72']]);
    const other = d.unknownObjects?.find((u) => u.sourceType === 'DICTIONARYVAR');
    expect(other).toMatchObject({ handle: '81', name: 'ACME_ONE', dictPath: ['ACME_VARS'] });
    const recs = recordsOf(writeDxf(d, { preserveHandles: true }));
    const vars = recs.filter((r) => r.type === 'DICTIONARYVAR');
    expect(vars.map((v) => [ownHandle(v), groupOf(v, 1)]).sort()).toEqual([['71', '1:2'], ['72', '80'], ['81', 'x']]);
    const dict = recs.find((r) => r.type === 'DICTIONARY' && ownHandle(r) === '70')!;
    expect(entriesOf(dict)).toEqual([['CANNOSCALE', '71'], ['PSOLHEIGHT', '72']]);
    expect(recs.filter((r) => r.type === 'CLASS' && groupOf(r, 1) === 'DICTIONARYVAR').length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe('multiline styles through DXF', () => {
  const wall: MLineStyle = {
    name: 'WALL', description: 'two skins and a core', flags: 0x410,
    fillColor: { kind: 'aci', index: 8 },
    startAngle: Math.PI / 3, endAngle: Math.PI / 2, handle: 'D1', xdict: 'D2',
    elements: [
      { offset: 1, color: { kind: 'aci', index: 1 }, linetype: 'DASHED' },
      { offset: 0, color: { kind: 'rgb', rgb: 0xff0000 }, linetype: 'HIDDEN' },
      { offset: -1, color: { kind: 'aci', index: 3 } },
      { offset: -1.5, color: { kind: 'byLayer' } }
    ]
  };
  const mline = (style: string | undefined, y: number, lines: number): Entity => ({
    type: 'mline', layer: '0', color: { kind: 'byLayer' }, styleName: style,
    scale: 1, justification: 0, basePoint: { x: 0, y, z: 0 },
    vertices: [0, 50].map((x) => ({
      position: { x, y, z: 0 }, direction: { x: 1, y: 0, z: 0 },
      miterDirection: { x: 0, y: 1, z: 0 },
      lines: Array.from({ length: lines }, () => ({ segparms: [0] }))
    }))
  });
  const base = (): Drawing => {
    const d = emptyDrawing();
    d.linetypes.push({ name: 'DASHED', description: 'Dashed', pattern: [0.5, -0.25] });
    d.linetypes.push({ name: 'HIDDEN', description: 'Hidden', pattern: [0.25, -0.125] });
    d.mlineStyles = [{ name: 'Standard', elements: [
      { offset: 0.5, color: { kind: 'byLayer' } }, { offset: -0.5, color: { kind: 'byLayer' } }] }, wall];
    d.entities.push(mline('WALL', 0, 4), mline('Standard', 10, 2), mline(undefined, 20, 2));
    d.unknownObjects = [{
      handle: 'D2', ownerHandle: 'D1', sourceType: 'DICTIONARY', typeCode: 42, hardOwner: true,
      entries: [{ name: 'ACAD_XREC_ROUNDTRIP', handle: 'D3', code: 3 }]
    }, { handle: 'D3', ownerHandle: 'D2', sourceType: 'XRECORD', typeCode: 79 }];
    d.xrecords = [{ handle: 'D3', name: 'ACAD_XREC_ROUNDTRIP', values: [{ code: 1, value: 'kept' }] }];
    return d;
  };

  it('writes every style under ACAD_MLINESTYLE with its elements, and each MLINE names its own', () => {
    const d = base();
    const text = writeDxf(d, { preserveHandles: true });
    const recs = recordsOf(text);
    const [, dictH] = entriesOf(rootOf(recs)).find(([k]) => k === 'ACAD_MLINESTYLE')!;
    const dict = recs.find((r) => r.type === 'DICTIONARY' && ownHandle(r) === dictH)!;
    expect(entriesOf(dict)).toEqual([['Standard', ownHandle(recs.find((r) => r.type === 'MLINESTYLE')!)!], ['WALL', 'D1']]);
    const w = recs.find((r) => r.type === 'MLINESTYLE' && ownHandle(r) === 'D1')!;
    expect(groupOf(w, 330)).toBe(dictH);
    expect(groupOf(w, 2)).toBe('WALL');
    expect(groupOf(w, 70)).toBe(String(0x410));
    expect(groupOf(w, 3)).toBe('two skins and a core');
    expect(groupsOf(w, 62)[0]).toBe('8');                   /* the fill, ahead of the elements */
    expect(parseFloat(groupOf(w, 51)!)).toBeCloseTo(60);
    expect(groupOf(w, 71)).toBe('4');
    expect(groupsOf(w, 49).map(Number)).toEqual([1, 0, -1, -1.5]);
    expect(groupsOf(w, 62).slice(1)).toEqual(['1', '1', '3', '256']);  /* red as its nearest ACI */
    expect(groupsOf(w, 6)).toEqual(['DASHED', 'HIDDEN', 'BYLAYER', 'BYLAYER']);
    const at = w.groups.findIndex(([c, x]) => c === 102 && x === '{ACAD_XDICTIONARY');
    expect(w.groups[at + 1]).toEqual([360, 'D2']);
    const mls = recs.filter((r) => r.type === 'MLINE');
    expect(mls.map((m) => [groupOf(m, 2), groupOf(m, 340)])).toEqual([
      ['WALL', 'D1'], ['Standard', entriesOf(dict)[0][1]], ['Standard', entriesOf(dict)[0][1]]]);
    expect(d.warnings).toEqual([]);
  });

  it('reads the styles and each MLINE\'s style back, by name and by pointer', () => {
    const back = readDxf(writeDxf(base(), { preserveHandles: true }));
    expect(back.mlineStyles?.map((m) => m.name)).toEqual(['Standard', 'WALL']);
    const w = back.mlineStyles!.find((m) => m.name === 'WALL')!;
    expect(w).toMatchObject({
      description: 'two skins and a core', flags: 0x410, fillColor: { kind: 'aci', index: 8 },
      handle: 'D1', xdict: 'D2'
    });
    expect(w.startAngle).toBeCloseTo(Math.PI / 3);
    expect(w.endAngle).toBeCloseTo(Math.PI / 2);
    expect(w.elements.map((e) => [e.offset, e.color, e.linetype])).toEqual([
      [1, { kind: 'aci', index: 1 }, 'DASHED'], [0, { kind: 'aci', index: 1 }, 'HIDDEN'],
      [-1, { kind: 'aci', index: 3 }, undefined], [-1.5, { kind: 'byBlock' }, undefined]]);
    expect(back.entities.map((e) => e.type === 'mline' ? e.styleName : '?')).toEqual(['WALL', 'Standard', 'Standard']);
    /* its extension dictionary came along */
    expect(back.unknownObjects?.find((u) => u.handle === 'D2')?.ownerHandle).toBe('D1');
  });

  it('an MLINE naming no style, or one that is not here, follows its pointer', () => {
    const rows = ['0', 'SECTION', '2', 'ENTITIES',
      '0', 'MLINE', '5', 'E1', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbMline',
      '2', 'GONE', '340', 'M1', '40', '1', '70', '0', '71', '1', '72', '2', '73', '2', '10', '0', '20', '0', '30', '0', '210', '0', '220', '0', '230', '1',
      '11', '0', '21', '0', '31', '0', '12', '1', '22', '0', '32', '0', '13', '0', '23', '1', '33', '0', '74', '1', '41', '0', '75', '0', '74', '1', '41', '0', '75', '0',
      '11', '5', '21', '0', '31', '0', '12', '1', '22', '0', '32', '0', '13', '0', '23', '1', '33', '0', '74', '1', '41', '0', '75', '0', '74', '1', '41', '0', '75', '0',
      '0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS',
      '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_MLINESTYLE', '350', 'M0',
      '0', 'DICTIONARY', '5', 'M0', '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'WALL', '350', 'M1',
      '0', 'MLINESTYLE', '5', 'M1', '330', 'M0', '100', 'AcDbMlineStyle', '2', 'WALL', '70', '0', '3', '', '62', '256', '51', '90', '52', '90',
      '71', '2', '49', '0.5', '62', '256', '6', 'BYLAYER', '49', '-0.5', '62', '256', '6', 'BYLAYER',
      '0', 'ENDSEC', '0', 'EOF', ''];
    const d = readDxf(rows.join('\n'));
    expect(d.entities[0].type === 'mline' && d.entities[0].styleName).toBe('WALL');
    expect(d.mlineStyles?.[0]).toMatchObject({ name: 'WALL', handle: 'M1' });
    expect(d.mlineStyles?.[0].fillColor).toBeUndefined();
  });
});
