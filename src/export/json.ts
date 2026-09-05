/* nasjidwg — JSON round-trip.
 *
 * The document model IS plain JSON, so this is a stable, lossless dump
 * format for pipelines (no separate schema needed).
 */

import type { Drawing } from '../core/model.js';
import { emptyDrawing } from '../core/model.js';

export const writeJson = (drawing: Drawing, pretty = false): string =>
  JSON.stringify(drawing, null, pretty ? 2 : 0);

/** Parse a drawing dump; missing collections are defaulted, never fatal. */
export const readJson = (text: string): Drawing => {
  const base = emptyDrawing();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    base.warnings.push('JSON parse error: ' +
      (err instanceof Error ? err.message : String(err)));
    return base;
  }
  if (typeof raw !== 'object' || raw === null) {
    base.warnings.push('JSON drawing must be an object.');
    return base;
  }
  const d = raw as Partial<Drawing>;
  const list = <T>(v: unknown): T[] | undefined =>
    Array.isArray(v) ? (v as T[]) : undefined;
  return {
    header: typeof d.header === 'object' && d.header ? d.header : {},
    layers: Array.isArray(d.layers) && d.layers.length ? d.layers : base.layers,
    linetypes: Array.isArray(d.linetypes) && d.linetypes.length
      ? d.linetypes : base.linetypes,
    textStyles: Array.isArray(d.textStyles) && d.textStyles.length
      ? d.textStyles : base.textStyles,
    blocks: typeof d.blocks === 'object' && d.blocks ? d.blocks : {},
    entities: Array.isArray(d.entities) ? d.entities : [],
    paperSpace: list(d.paperSpace),
    layouts: list(d.layouts),
    groups: list(d.groups),
    mlineStyles: list(d.mlineStyles),
    variables: list(d.variables),
    tableStyles: list(d.tableStyles),
    mleaderStyles: list(d.mleaderStyles),
    ucs: list(d.ucs),
    views: list(d.views),
    vports: list(d.vports),
    dimStyles: list(d.dimStyles),
    appIds: list(d.appIds),
    xrecords: list(d.xrecords),
    proxyObjects: list(d.proxyObjects),
    unknownObjects: list(d.unknownObjects),
    structureHandles: typeof d.structureHandles === 'object' && d.structureHandles
      ? d.structureHandles : undefined,
    geoData: typeof d.geoData === 'object' && d.geoData ? d.geoData : undefined,
    warnings: Array.isArray(d.warnings) ? d.warnings : []
  };
};
