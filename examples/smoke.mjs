/* nasjidwg — module-path smoke test for the browser demo.
 *
 * Proves the exact pipeline viewer.html uses (dist ESM import →
 * readDwg → writeSvg) works against the built package. Run:
 *
 *   npm run build
 *   node examples/smoke.mjs
 *
 * examples/sample.dwg is a generated artifact (the test corpus drawing,
 * written by this library's own R2018 writer). Regenerate it with a
 * temporary vitest probe that imports sampleDrawing() from test/corpus.ts
 * and writes writeDwg2018(sampleDrawing()).data to this path.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { readDwg, writeSvg, writePdf, writeDxf, writeJson } =
  await import(new URL('../dist/index.js', import.meta.url));

const bytes = new Uint8Array(readFileSync(join(here, 'sample.dwg')));
const drawing = readDwg(bytes);

const fail = (msg) => { console.error('smoke FAIL:', msg); process.exit(1); };

if (!drawing.header.version) fail('no version detected');
if (drawing.entities.length === 0) fail('no entities read');

const svg = writeSvg(drawing, { stroke: '#e6edf3' });
if (!svg.startsWith('<svg')) fail('writeSvg did not produce an <svg> root');
if (!svg.includes('viewBox')) fail('svg has no viewBox (zoom/pan needs one)');

const pdf = writePdf(drawing);
if (pdf.data[0] !== 0x25) fail('writePdf did not produce %PDF');
const dxf = writeDxf(drawing);
if (!dxf.includes('ENTITIES')) fail('writeDxf has no ENTITIES section');
JSON.parse(writeJson(drawing));

console.log(
  `smoke OK: ${drawing.header.version}, ${drawing.entities.length} entities, ` +
  `${drawing.layers.length} layers, svg ${svg.length} chars, ` +
  `pdf ${pdf.data.length} bytes, warnings ${drawing.warnings.length}`
);
