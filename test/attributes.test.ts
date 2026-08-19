/* nasjidwg — attribute visibility, image clip wrinkles, MTEXT truecolor.
 *
 * An ATTDEF with flags 9 (invisible + preset) used to come back as a
 * plain visible text — in a viewer that means giant glyphs the source
 * drawing never shows. The claims under test: ATTDEF/ATTRIB decode with
 * their flags (bit 1 → invisible, bit 2 → constant) and a marker that
 * tells them apart from plain TEXT, both codecs round-trip those fields,
 * the R2010+ inverted-clip bit on IMAGE/WIPEOUT survives instead of
 * being discarded, the DXF reader hands back the same open clip ring the
 * DWG reader does, and stripMtextCodes strips the lowercase \c truecolor
 * code it used to leave in the output.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { writeDwg2000, writeDwg2018 } from '../src/dwg/writer.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import { stripMtextCodes } from '../src/text/escapes.js';
import { emptyDrawing } from '../src/core/model.js';
import type {
  Drawing, Entity, ImageEntity, InsertEntity, TextEntity
} from '../src/core/model.js';

const attributeDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.blocks.TAG = {
    name: 'TAG', basePoint: { x: 0, y: 0, z: 0 },
    entities: [
      {
        type: 'line', layer: '0', color: { kind: 'byLayer' },
        start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }
      },
      {
        type: 'text', layer: '0', color: { kind: 'byLayer' },
        position: { x: 0, y: 0, z: 0 }, text: '0.125000000000000',
        height: 150, rotation: 0,
        attribute: 'attdef', invisible: true, constant: true
      }
    ] as Entity[]
  };
  d.entities = [{
    type: 'insert', layer: '0', color: { kind: 'byLayer' },
    blockName: 'TAG', position: { x: 5, y: 5, z: 0 },
    scale: { x: 1, y: 1, z: 1 }, rotation: 0,
    attributes: [{
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 5, y: 5, z: 0 }, text: '600.0',
      height: 150, rotation: 0,
      attribute: 'attrib', invisible: true
    }]
  } as Entity];
  return d;
};

const checkAttributes = (back: Drawing): void => {
  const def = back.blocks.TAG?.entities
    .find((e) => e.type === 'text') as TextEntity;
  expect(def?.attribute).toBe('attdef');
  expect(def?.invisible).toBe(true);
  expect(def?.constant).toBe(true);
  expect(def?.text).toBe('0.125000000000000');
  const ins = back.entities.find((e) => e.type === 'insert') as InsertEntity;
  const attr = ins?.attributes?.[0];
  expect(attr?.attribute).toBe('attrib');
  expect(attr?.invisible).toBe(true);
  expect(attr?.text).toBe('600.0');
};

describe('invisible attributes', () => {
  it.each([['R2000', writeDwg2000], ['R2018', writeDwg2018]] as const)(
    '%s: ATTDEF and ATTRIB flags round-trip through DWG', (_v, writer) => {
      const { data, skipped } = writer(attributeDrawing());
      expect(skipped).toEqual([]);
      checkAttributes(readDwg(data));
    });

  it('the same fields round-trip through DXF', () => {
    checkAttributes(readDxf(writeDxf(attributeDrawing())));
  });

  it('a plain TEXT stays unmarked', () => {
    const d = emptyDrawing();
    d.entities = [{
      type: 'text', layer: '0', color: { kind: 'byLayer' },
      position: { x: 0, y: 0, z: 0 }, text: 'plain',
      height: 2.5, rotation: 0
    } as Entity];
    const back = readDwg(writeDwg2018(d).data);
    const tx = back.entities.find((e) => e.type === 'text') as TextEntity;
    expect(tx?.attribute).toBeUndefined();
    expect(tx?.invisible).toBeUndefined();
  });
});

describe('image clip wrinkles', () => {
  const clipped = (): Drawing => {
    const d = emptyDrawing();
    d.entities = [{
      type: 'image', layer: '0', color: { kind: 'byLayer' }, wipeout: true,
      position: { x: 0, y: 0, z: 0 },
      uVector: { x: 1, y: 0, z: 0 }, vVector: { x: 0, y: 1, z: 0 },
      widthPx: 1, heightPx: 1,
      clip: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }],
      clipInverted: true
    } as Entity];
    return d;
  };

  it('R2018 DWG keeps the inverted-clip bit and the open ring', () => {
    const back = readDwg(writeDwg2018(clipped()).data);
    const img = back.entities.find((e) => e.type === 'image') as ImageEntity;
    expect(img?.clipInverted).toBe(true);
    expect(img?.clip?.length).toBe(3);
  });

  it('DXF closes the ring on write and reopens it on read', () => {
    const dxf = writeDxf(clipped());
    /* the file itself carries the closed ring (4 vertices) ... */
    expect(dxf).toContain('\n91\n4\n');
    const back = readDxf(dxf);
    const img = back.entities.find((e) => e.type === 'image') as ImageEntity;
    /* ... but the model gets the same open ring the DWG reader yields */
    expect(img?.clip?.length).toBe(3);
    expect(img?.clipInverted).toBe(true);
  });
});

describe('stripMtextCodes', () => {
  it('strips the lowercase \\c truecolor code', () => {
    expect(stripMtextCodes('{\\C255;\\c16777215;Doors, Windows, & Curtains}'))
      .toBe('Doors, Windows, & Curtains');
  });
});
