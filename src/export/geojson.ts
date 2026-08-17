/* nasjidwg — GeoJSON export.
 *
 * Model space as a FeatureCollection. Covers every geometric entity type
 * in the model, including SPLINE, MLINE and mesh entities.
 */

import type { Drawing, Entity, Point2 } from '../core/model.js';
import {
  boundaryPoints, explodeInsert, flattenPolyline, toWcs
} from '../core/geo.js';

interface GeoFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

const TAU = Math.PI * 2;

const ring = (pts: Point2[]): number[][] => {
  const out = pts.map((p) => [p.x, p.y]);
  const first = out[0], last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push(first);
  return out;
};

const arcPts = (
  cx: number, cy: number, r: number, a0: number, a1: number, n = 48
): Point2[] => {
  let sweep = (a1 - a0) % TAU;
  if (sweep <= 0) sweep += TAU;
  const pts: Point2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * (i / n);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
};

export interface GeoJSONOptions {
  /** Transform drawing coordinates to WGS84 lon/lat through the drawing's
   *  GEODATA anchor. Defaults to on whenever the drawing carries one. */
  georeference?: boolean;
}

export const toGeoJSON = (drawing: Drawing, opts: GeoJSONOptions = {}): {
  type: 'FeatureCollection'; features: GeoFeature[];
} => {
  /* An equirectangular mapping around the GEODATA anchor: design offsets
     scale to meters, rotate so drawing "up" points at geographic north,
     and land as degrees off the anchor's latitude/longitude. */
  const geo = drawing.geoData;
  let toLonLat: ((x: number, y: number) => [number, number]) | null = null;
  if (opts.georeference !== false
      && geo && geo.latitude !== undefined && geo.longitude !== undefined) {
    const scale = geo.horizontalUnitScale ?? 1;
    const nd = geo.northDirection ?? { x: 0, y: 1 };
    const nl = Math.hypot(nd.x, nd.y) || 1;
    const n = { x: nd.x / nl, y: nd.y / nl };
    const east = { x: n.y, y: -n.x };
    const mPerDegLat = 111319.49079327358;
    const mPerDegLon = mPerDegLat * Math.cos(geo.latitude * Math.PI / 180) || 1e-9;
    const lat0 = geo.latitude, lon0 = geo.longitude;
    const anchor = geo.designPoint;
    toLonLat = (x, y) => {
      const dx = (x - anchor.x) * scale, dy = (y - anchor.y) * scale;
      return [
        lon0 + (dx * east.x + dy * east.y) / mPerDegLon,
        lat0 + (dx * n.x + dy * n.y) / mPerDegLat
      ];
    };
  }
  const mapCoords = (c: unknown): unknown => {
    if (!toLonLat || !Array.isArray(c)) return c;
    if (typeof c[0] === 'number') {
      return toLonLat(c[0] as number, c[1] as number);
    }
    return c.map(mapCoords);
  };

  const features: GeoFeature[] = [];
  const push = (e: Entity, type: string, coordinates: unknown): void => {
    features.push({
      type: 'Feature',
      properties: {
        entityType: e.type, layer: e.layer,
        ...(e.handle ? { handle: e.handle } : {})
      },
      geometry: { type, coordinates: mapCoords(coordinates) }
    });
  };

  const emit = (raw: Entity): void => {
    const e = raw.extrusion ? toWcs(raw) : raw;
    switch (e.type) {
      case 'point':
        push(e, 'Point', [e.position.x, e.position.y]);
        return;
      case 'line':
        push(e, 'LineString', [[e.start.x, e.start.y], [e.end.x, e.end.y]]);
        return;
      case 'ray':
      case 'xline':
        push(e, 'LineString', [
          [e.basePoint.x, e.basePoint.y],
          [e.basePoint.x + e.direction.x, e.basePoint.y + e.direction.y]
        ]);
        return;
      case 'circle':
        push(e, 'Polygon', [ring(arcPts(e.center.x, e.center.y, e.radius, 0, TAU - 1e-12))]);
        return;
      case 'arc':
        push(e, 'LineString',
          arcPts(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle)
            .map((p) => [p.x, p.y]));
        return;
      case 'ellipse': {
        const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
        const ry = rx * e.ratio;
        const co = rx ? e.majorAxis.x / rx : 1, si = rx ? e.majorAxis.y / rx : 0;
        let sweep = (e.endParam - e.startParam) % TAU;
        if (sweep <= 0) sweep += TAU;
        const pts: number[][] = [];
        for (let i = 0; i <= 64; i++) {
          const t = e.startParam + sweep * (i / 64);
          const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
          pts.push([e.center.x + ex * co - ey * si, e.center.y + ex * si + ey * co]);
        }
        if (Math.abs(sweep - TAU) < 1e-9) push(e, 'Polygon', [pts]);
        else push(e, 'LineString', pts);
        return;
      }
      case 'polyline': {
        const pts = flattenPolyline(e.vertices, e.closed);
        if (pts.length < 2) return;
        if (e.closed) push(e, 'Polygon', [ring(pts)]);
        else push(e, 'LineString', pts.map((p) => [p.x, p.y]));
        return;
      }
      case 'spline': {
        const src = e.controlPoints.length >= 2 ? e.controlPoints : (e.fitPoints ?? []);
        if (src.length >= 2) {
          push(e, 'LineString', src.map((p) => [p.x, p.y]));
        }
        return;
      }
      case 'text':
      case 'mtext':
        features.push({
          type: 'Feature',
          properties: {
            entityType: e.type, layer: e.layer, text: e.text,
            height: e.height
          },
          geometry: { type: 'Point', coordinates: [e.position.x, e.position.y] }
        });
        return;
      case 'insert':
        for (const child of explodeInsert(e, drawing.blocks)) emit(child);
        return;
      case 'hatch':
        for (const loop of e.loops) {
          const pts = boundaryPoints(loop);
          if (pts.length > 2) push(e, 'Polygon', [ring(pts)]);
        }
        return;
      case 'solid':
      case 'face3d': {
        const c = e.corners;
        const seq = e.type === 'solid' ? [c[0], c[1], c[3], c[2]] : [...c];
        push(e, 'Polygon', [ring(seq.map((p) => ({ x: p.x, y: p.y })))]);
        return;
      }
      case 'leader':
        push(e, 'LineString', e.vertices.map((p) => [p.x, p.y]));
        return;
      case 'mline':
        push(e, 'LineString', e.vertices.map((v) => [v.position.x, v.position.y]));
        return;
      case 'mesh':
        if (e.meshKind !== 'grid' && e.faces?.length) {
          const polys: number[][][][] = [];
          for (const f of e.faces) {
            const pts = f.map((i) => e.vertices[Math.abs(i) - 1]).filter(Boolean);
            if (pts.length > 2) polys.push([ring(pts.map((p) => ({ x: p.x, y: p.y })))]);
          }
          if (polys.length) push(e, 'MultiPolygon', polys);
        } else {
          push(e, 'MultiPoint', e.vertices.map((p) => [p.x, p.y]));
        }
        return;
      case 'dimension':
        push(e, 'Point', [e.definitionPoint.x, e.definitionPoint.y]);
        return;
      case 'image': {
        const c1 = e.position;
        const c2 = {
          x: c1.x + e.uVector.x * e.widthPx + e.vVector.x * e.heightPx,
          y: c1.y + e.uVector.y * e.widthPx + e.vVector.y * e.heightPx
        };
        push(e, 'Polygon', [ring([
          { x: c1.x, y: c1.y }, { x: c2.x, y: c1.y },
          { x: c2.x, y: c2.y }, { x: c1.x, y: c2.y }
        ])]);
        return;
      }
      case 'shape':
      case 'tolerance':
        push(e, 'Point', [e.position.x, e.position.y]);
        return;
      case 'light':
        push(e, 'Point', [e.position.x, e.position.y]);
        return;
      case 'mleader':
        for (const leader of e.leaders) {
          for (const line of leader.lines) {
            if (line.length > 1) push(e, 'LineString', line.map((p) => [p.x, p.y]));
          }
        }
        if (e.textPosition) {
          features.push({
            type: 'Feature',
            properties: { entityType: 'mleader', layer: e.layer, text: e.text },
            geometry: { type: 'Point', coordinates: [e.textPosition.x, e.textPosition.y] }
          });
        }
        return;
      case 'table': {
        const w = e.columnWidths.reduce((s2, v) => s2 + v, 0);
        const h = e.rowHeights.reduce((s2, v) => s2 + v, 0);
        push(e, 'Polygon', [ring([
          { x: e.position.x, y: e.position.y },
          { x: e.position.x + w, y: e.position.y },
          { x: e.position.x + w, y: e.position.y - h },
          { x: e.position.x, y: e.position.y - h }
        ])]);
        return;
      }
      case 'ole':
        push(e, 'Polygon', [ring(e.corners)]);
        return;
      case 'pointcloud':
        push(e, 'Polygon', [ring([
          { x: e.extentsMin.x, y: e.extentsMin.y },
          { x: e.extentsMax.x, y: e.extentsMin.y },
          { x: e.extentsMax.x, y: e.extentsMax.y },
          { x: e.extentsMin.x, y: e.extentsMax.y }
        ])]);
        return;
      case 'proxy':
        for (const g of e.graphics) emit(g);
        return;
      case 'unknown':
        for (const g of e.graphics ?? []) emit(g);
        return;
      case 'viewport':
      case 'acis':
        return;
    }
  };

  for (const e of drawing.entities) emit(e);
  return { type: 'FeatureCollection', features };
};
