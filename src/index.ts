/* nasjidwg — public API.
 *
 * A pure-TypeScript DWG/DXF library with first-class Arabic/RTL support.
 * Zero native dependencies: the same build runs in the browser, Node,
 * Electron, and workers.
 */

export * from './core/model.js';
export { ACI_RGB, aciToRgb, nearestAci, colorToRgb } from './core/color.js';

export { readDwg } from './dwg/reader.js';
export type { DwgReadOptions } from './dwg/reader.js';
export {
  writeDwgR13, writeDwgR14,
  writeDwg2000, writeDwg2004, writeDwg2018
} from './dwg/writer.js';
/** AC1021. The container, its Reed-Solomon coding, its compression and
 *  all three header checksums are accepted by AutoCAD, and the output
 *  round-trips through this library's own reader — but AutoCAD still
 *  refuses the file over one unsolved 64-bit header field, so **treat
 *  R2007 output as experimental**. Every other release this library
 *  writes opens in AutoCAD with zero AUDIT errors. See PARITY.md. */
export { writeDwg2007 } from './dwg/writer.js';
export { writeDwgR12 } from './dwg/writer12.js';
export {
  writeDwgR10, writeDwgR9, writeDwgR2_10, writeDwgR2_6
} from './dwg/writer-pre13.js';
export type { DwgWriteResult, DwgWriteOptions } from './dwg/writer.js';
export { readDxf } from './dxf/reader.js';
export { writeDxf, writeDxfBinary } from './dxf/writer.js';
export { isBinaryDxf, isNarrowCodeBinaryDxf } from './dxf/binary.js';

/* exports beyond CAD formats */
export { writeSvg } from './export/svg.js';
export { writePdf } from './export/pdf.js';
export type { PdfOptions, PdfResult } from './export/pdf.js';
export { toGeoJSON } from './export/geojson.js';
export type { GeoJSONOptions } from './export/geojson.js';
export { writeJson, readJson } from './export/json.js';

/* ACIS kernel payloads */
export { sabToSat } from './acis/sab.js';

/* hatch patterns */
export { readPatternFile, writePatternFile, explodeHatch } from './hatch/pattern.js';
export type { HatchPattern } from './hatch/pattern.js';

/* text codepages */
export { decodeMif, encodeMif } from './text/mif.js';

/* self-validation: the library's own AUDIT pass */
export { auditDrawing } from './core/audit.js';
export type { AuditFinding } from './core/audit.js';

/* geometry utilities */
export {
  entityBounds, drawingBounds, contentBounds, transformEntity, explodeInsert,
  explodePolyline, flattenPolyline, sampleBulge, clone,
  identity, compose, translation, rotationT, scaling, insertTransform, applyPt
} from './core/geo.js';
export { explodeDimension } from './core/dim.js';
export { ocsTransform, ocsToWcs, toWcs, ucsTransform, viewTwistTransform } from './core/geo.js';
export type { Transform2, Transform3 } from './core/geo.js';

export {
  shapeArabic, unshapeArabic, mirrorBrackets,
  normalizeIncomingText, hasComplexScript
} from './text/arabic.js';
export {
  decodeCadText, encodeCadSymbols, escapeUnicode, stripMtextCodes
} from './text/escapes.js';
export { parseMtext, mtextPlainText } from './text/mtext.js';
export type { MTextFragment, MTextStackedText } from './text/mtext.js';

/* SHX shape fonts: register once, and the SVG/PDF exporters render text
 * as the font's real vector strokes. */
export {
  parseShx, registerShxFont, findShxFont, renderShxText, shxTextStrokes
} from './text/shx.js';
export type { ShxFont, ShxGlyph, ShxTextOptions } from './text/shx.js';

/* Lower-level building blocks, exported for tooling and tests. */
export { BitReader, resolveHandle, decodeCodepage } from './dwg/bitstream.js';
export { detectVersion } from './dwg/fileheader.js';
export { readThumbnail, readSummaryInfo, readAcDsSabBlobs } from './dwg/meta.js';
export { decodeProxyGraphics } from './dwg/proxy.js';
export type { Thumbnail, SummaryInfo } from './dwg/meta.js';
export { readSections2004 } from './dwg/sections2004.js';
export { readSections2007 } from './dwg/sections2007.js';
export { decompressR2004, compressR2004 } from './dwg/compress.js';
export { compressR2007 } from './dwg/sections2007.js';
