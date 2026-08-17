#!/usr/bin/env node
/* nasjidwg — the performance yardstick.
 *
 * Times the read and write paths over the real fixtures so any
 * optimization claim is a number rather than an adjective. Run it against
 * the BUILT library, not the sources: a TypeScript loader adds its own
 * compile time to every measurement and hides what changed.
 *
 *   npm run build && node tools/bench.mjs [iterations]
 *
 * Each figure is the mean of `iterations` runs after a warm-up. Machine
 * noise is a few percent, so compare the minimum across several runs
 * before believing a small difference.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
let mod;
try {
  mod = {
    readDwg: (await import(new URL('dwg/reader.js', dist))).readDwg,
    writer: await import(new URL('dwg/writer.js', dist)),
    writer12: await import(new URL('dwg/writer12.js', dist)),
    readDxf: (await import(new URL('dxf/reader.js', dist))).readDxf,
    writeDxf: (await import(new URL('dxf/writer.js', dist))).writeDxf,
    writeSvg: (await import(new URL('export/svg.js', dist))).writeSvg
  };
} catch {
  console.error('build first:  npm run build');
  process.exit(1);
}
const { readDwg, readDxf, writeDxf, writeSvg } = mod;
const { writeDwg2000, writeDwg2018 } = mod.writer;
const { writeDwgR12 } = mod.writer12;

const N = Number(process.argv[2] ?? 40);

const bench = (label, fn) => {
  for (let i = 0; i < 5; i++) fn();       /* warm up the JIT */
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn();
  const ms = (performance.now() - t0) / N;
  console.log(label.padEnd(32) + ms.toFixed(3).padStart(9) + ' ms');
  return ms;
};

/* Real drawings in test/data/ when present (they are not shipped — this
 * is a local folder of whatever files you benchmark against). Without
 * them, the yardstick falls back to a synthetic drawing built through
 * the library itself, so `npm run bench` works on a fresh clone. */
const file = (name) => {
  try {
    return new Uint8Array(readFileSync(root + 'test/data/' + name));
  } catch {
    return null;
  }
};

/** A dense synthetic model: 2 000 mixed entities across 40 layers. */
const synthetic = () => {
  const d = {
    header: { vars: {} }, layers: [], linetypes: [], textStyles: [],
    blocks: {}, entities: [], warnings: []
  };
  for (let i = 0; i < 40; i++) {
    d.layers.push({
      name: 'L' + i, color: { kind: 'aci', index: 1 + (i % 250) },
      on: true, frozen: false, locked: false
    });
  }
  const byLayer = { kind: 'byLayer' };
  for (let i = 0; i < 2000; i++) {
    const layer = 'L' + (i % 40);
    const x = (i % 50) * 10, y = Math.floor(i / 50) * 10;
    switch (i % 5) {
      case 0: d.entities.push({ type: 'line', layer, color: byLayer, start: { x, y, z: 0 }, end: { x: x + 9, y: y + 4, z: 0 } }); break;
      case 1: d.entities.push({ type: 'circle', layer, color: byLayer, center: { x, y, z: 0 }, radius: 3 + (i % 4) }); break;
      case 2: d.entities.push({ type: 'arc', layer, color: byLayer, center: { x, y, z: 0 }, radius: 4, startAngle: 0.2, endAngle: 2.8 }); break;
      case 3: d.entities.push({ type: 'text', layer, color: byLayer, text: 'T' + i, position: { x, y, z: 0 }, height: 2, rotation: 0 }); break;
      default: d.entities.push({
        type: 'polyline', layer, color: byLayer, closed: true,
        vertices: [{ x, y, bulge: 0.4 }, { x: x + 6, y }, { x: x + 6, y: y + 6 }, { x, y: y + 6 }]
      });
    }
  }
  return d;
};

const d2000 = file('example_2000.dwg') ?? writeDwg2000(synthetic()).data;
const d2018 = file('example_2018.dwg') ?? writeDwg2018(synthetic()).data;
const d2007 = file('example_2007.dwg');
const dyn = file('example_dynblocks_2018.dwg');
const dxfSrc = readDwg(d2000);
const dxfText = (() => {
  try {
    return readFileSync(root + 'test/data/example_2000.dxf', 'latin1');
  } catch {
    return writeDxf(dxfSrc);
  }
})();
const drawing = readDwg(d2018);
if (!d2007) console.log('(test/data/ absent — timing the synthetic 2000-entity drawing)');

let total = 0;
total += bench('readDwg R2000', () => readDwg(d2000));
if (d2007) total += bench('readDwg R2007', () => readDwg(d2007));
total += bench('readDwg R2018', () => readDwg(d2018));
if (dyn) total += bench('readDwg dynblocks (1.2 MB)', () => readDwg(dyn));
total += bench('readDxf R2000', () => readDxf(dxfText));
total += bench('writeDwg2000', () => writeDwg2000(drawing));
total += bench('writeDwg2018', () => writeDwg2018(drawing));
total += bench('writeDwgR12', () => writeDwgR12(drawing));
total += bench('writeDxf', () => writeDxf(drawing));
total += bench('writeSvg', () => writeSvg(drawing));
console.log('TOTAL'.padEnd(32) + total.toFixed(3).padStart(9) + ' ms');
