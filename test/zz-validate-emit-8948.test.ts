
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { DWG_VERSIONS, dwgOf, dxfOf } from './corpus.js';
import { emptyDrawing, writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018 } from '../src/index.js';
const door = () => {
  const d = emptyDrawing();
  d.blocks = { DOOR: {
    name: 'DOOR', basePoint: { x: 0, y: 0, z: 0 },
    entities: [
      { type: 'line', handle: 'A1', layer: '0', color: { kind: 'byLayer' }, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } },
      { type: 'circle', handle: 'A2', layer: '0', color: { kind: 'byLayer' }, center: { x: 0.5, y: 0.5, z: 0 }, radius: 0.5 }
    ],
    visibilityName: 'Door State', visibilityPrompt: 'Pick a state',
    visibilityStates: [{ name: 'Open', visible: ['A1'] }, { name: 'Closed', visible: ['A1', 'A2'] }]
  } };
  d.entities = [{ type: 'insert', layer: '0', color: { kind: 'byLayer' }, blockName: 'DOOR', position: { x: 5, y: 5, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0 }];
  return d;
};
const DOOR_WRITERS = { R2000: writeDwg2000, R2004: writeDwg2004, R2007: writeDwg2007, R2018: writeDwg2018 };
it('emit', () => {
  for (const v of DWG_VERSIONS) {
    writeFileSync("C:\\Users\\AHMED\\AppData\\Local\\Temp\\nasjidwg-acad-8948" + '/corpus_' + v + '.dwg', dwgOf(v));
  }
  writeFileSync("C:\\Users\\AHMED\\AppData\\Local\\Temp\\nasjidwg-acad-8948" + '/corpus_DXF.dxf', dxfOf());
  for (const [v, w] of Object.entries(DOOR_WRITERS)) {
    writeFileSync("C:\\Users\\AHMED\\AppData\\Local\\Temp\\nasjidwg-acad-8948" + '/door_' + v + '.dwg', w(door()).data);
  }
});
