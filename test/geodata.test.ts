/* nasjidwg — GEODATA (geographic placement).
 *
 * A drawing that has been located on the earth carries an anchor: one
 * point in drawing coordinates, the same point in the coordinate system's
 * own units, the direction of north, and the factor that turns drawing
 * distance into metres. The tests build such a drawing, put it through
 * every container and through DXF, and check that what comes back still
 * says the same thing — and that the GeoJSON export puts the geometry at
 * its real place on the earth.
 */

import { describe, expect, it } from 'vitest';
import { readDwg } from '../src/dwg/reader.js';
import { readDxf } from '../src/dxf/reader.js';
import { writeDxf } from '../src/dxf/writer.js';
import {
  writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018
} from '../src/dwg/writer.js';
import { toGeoJSON } from '../src/export/geojson.js';
import { emptyDrawing } from '../src/core/model.js';
import type { Drawing, GeoData } from '../src/core/model.js';

/** A building placed on a Lambert grid, anchored in Glasgow. */
const PLACED: GeoData = {
  version: 3,
  coordinatesType: 1,                     /* local grid */
  designPoint: { x: 11.24751811939982, y: 17.27339827573371, z: 0 },
  referencePoint: { x: -315551.0219150639, y: 4702004.167534534, z: 50 },
  northDirection: { x: 0, y: 1 },
  horizontalUnitScale: 0.0254,            /* the drawing is in inches */
  verticalUnitScale: 0.0254,
  horizontalUnits: 1,
  verticalUnits: 1,
  upDirection: { x: 0, y: 0, z: 1 },
  scaleEstimation: 1,
  userScaleFactor: 1,
  seaLevelCorrection: false,
  seaLevelElevation: 0,
  projectionRadius: 6362228.650184014,
  coordinateSystem: 'WORLD-LM-CONIC',
  geoRssTag: '<georss:point>55.8440 -4.2310</georss:point>',
  latitude: 55.844,
  longitude: -4.231
};

const placedDrawing = (): Drawing => {
  const d = emptyDrawing();
  d.geoData = { ...PLACED };
  d.entities.push({
    type: 'line', layer: '0', color: { kind: 'byLayer' },
    start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 50, z: 0 }
  });
  return d;
};

const expectSamePlacement = (g: GeoData | undefined, label: string): void => {
  expect(g, label).toBeDefined();
  if (!g) return;
  expect(g.version, label).toBe(3);
  expect(g.coordinatesType, label).toBe(1);
  expect(g.designPoint.x, label).toBeCloseTo(PLACED.designPoint.x, 9);
  expect(g.designPoint.y, label).toBeCloseTo(PLACED.designPoint.y, 9);
  expect(g.referencePoint.x, label).toBeCloseTo(PLACED.referencePoint.x, 6);
  expect(g.referencePoint.y, label).toBeCloseTo(PLACED.referencePoint.y, 6);
  expect(g.referencePoint.z, label).toBeCloseTo(50, 9);
  expect(g.horizontalUnitScale, label).toBeCloseTo(0.0254, 12);
  expect(g.verticalUnitScale, label).toBeCloseTo(0.0254, 12);
  expect(g.northDirection!.y, label).toBeCloseTo(1, 9);
  expect(g.projectionRadius, label).toBeCloseTo(PLACED.projectionRadius!, 6);
  expect(g.coordinateSystem, label).toContain('WORLD-LM-CONIC');
  expect(g.latitude, label).toBeCloseTo(55.844, 6);
  expect(g.longitude, label).toBeCloseTo(-4.231, 6);
};

describe('GEODATA round trip', () => {
  it.each([
    ['R2000', writeDwg2000], ['R2004', writeDwg2004],
    ['R2007', writeDwg2007], ['R2018', writeDwg2018]
  ])('survives the %s container', (name, write) => {
    const { data, skipped } = write(placedDrawing());
    expect(skipped, name).toEqual([]);
    const back = readDwg(data);
    expect(back.warnings, name).toEqual([]);
    expectSamePlacement(back.geoData, name);
  });

  it('survives ASCII DXF', () => {
    const back = readDxf(writeDxf(placedDrawing()));
    expectSamePlacement(back.geoData, 'DXF');
  });

  it('parses the latitude and longitude out of the GeoRSS tag alone', () => {
    /* a drawing may carry the tag without the parsed pair; the reader is
       what turns one into the other */
    const d = placedDrawing();
    delete d.geoData!.latitude;
    delete d.geoData!.longitude;
    const back = readDxf(writeDxf(d));
    expect(back.geoData!.latitude).toBeCloseTo(55.844, 6);
    expect(back.geoData!.longitude).toBeCloseTo(-4.231, 6);
  });

  it('leaves a drawing with no placement alone', () => {
    const plain = emptyDrawing();
    plain.entities.push({
      type: 'point', layer: '0', color: { kind: 'byLayer' },
      position: { x: 1, y: 2, z: 0 }
    });
    expect(readDwg(writeDwg2018(plain).data).geoData).toBeUndefined();
    expect(readDxf(writeDxf(plain)).geoData).toBeUndefined();
  });
});

describe('georeferenced GeoJSON', () => {
  const d = emptyDrawing();
  d.geoData = {
    designPoint: { x: 100, y: 200, z: 0 },
    referencePoint: { x: 0, y: 0, z: 0 },
    northDirection: { x: 0, y: 1 },
    horizontalUnitScale: 1,               /* drawing units are metres */
    latitude: 55.844, longitude: -4.231
  };
  d.entities.push(
    { type: 'point', layer: '0', color: { kind: 'byLayer' }, position: { x: 100, y: 200, z: 0 } },
    {
      type: 'line', layer: '0', color: { kind: 'byLayer' },
      start: { x: 100, y: 200, z: 0 },
      end: { x: 100, y: 200 + 111319.49079327358, z: 0 }   /* one degree north */
    }
  );

  it('lands the anchor at its latitude/longitude', () => {
    const fc = toGeoJSON(d);
    const pt = fc.features[0].geometry!.coordinates as [number, number];
    expect(pt[0]).toBeCloseTo(-4.231, 9);
    expect(pt[1]).toBeCloseTo(55.844, 9);
    const line = fc.features[1].geometry!.coordinates as [number, number][];
    expect(line[1][1]).toBeCloseTo(56.844, 9);   /* one degree north */
    expect(line[1][0]).toBeCloseTo(-4.231, 9);
  });

  it('turns the drawing when north is not up', () => {
    const turned = { ...d, geoData: { ...d.geoData!, northDirection: { x: 1, y: 0 } } };
    const fc = toGeoJSON(turned);
    /* the same run now heads east, so latitude holds and longitude moves */
    const line = fc.features[1].geometry!.coordinates as [number, number][];
    expect(line[1][1]).toBeCloseTo(55.844, 6);
    expect(line[1][0]).toBeLessThan(-4.231);
  });

  it('keeps drawing coordinates when georeferencing is off', () => {
    const fc = toGeoJSON(d, { georeference: false });
    expect(fc.features[0].geometry!.coordinates).toEqual([100, 200]);
  });

  it('leaves un-placed drawings untouched', () => {
    const plain = emptyDrawing();
    plain.entities.push({
      type: 'point', layer: '0', color: { kind: 'byLayer' },
      position: { x: 5, y: 6, z: 0 }
    });
    expect(toGeoJSON(plain).features[0].geometry!.coordinates).toEqual([5, 6]);
  });
});
