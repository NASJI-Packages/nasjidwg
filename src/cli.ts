#!/usr/bin/env node
/* nasjidwg — command line tools.
 *
 *   nasjidwg info    <file>              summary of what is inside
 *   nasjidwg convert <in> <out>          by extension: dwg/dxf/svg/pdf/json/geojson
 *   nasjidwg grep    <pattern> <files…>  search text entities
 *   nasjidwg thumb   <file> <out>        extract the embedded preview
 *
 * Node-only by design: the library itself stays environment-neutral, this
 * file is the only place that touches the filesystem.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { readDwg } from './dwg/reader.js';
import { writeDwg2000, writeDwg2004, writeDwg2007, writeDwg2018 } from './dwg/writer.js';
import { writeDwgR12 } from './dwg/writer12.js';
import { readDxf } from './dxf/reader.js';
import { writeDxf, writeDxfBinary } from './dxf/writer.js';
import { isBinaryDxf } from './dxf/binary.js';
import { writeSvg } from './export/svg.js';
import { writePdf } from './export/pdf.js';
import { toGeoJSON } from './export/geojson.js';
import { readJson, writeJson } from './export/json.js';
import { drawingBounds } from './core/geo.js';
import { auditDrawing } from './core/audit.js';
import type { Drawing } from './core/model.js';

const USAGE = `nasjidwg — DWG/DXF toolkit

  nasjidwg info    <file>
  nasjidwg convert <input> <output> [--as r12|r2000|r2004|r2007|r2018] [--verify]
  nasjidwg layers  <file...> [--on]
  nasjidwg grep    <pattern> <file...> [-i]
  nasjidwg thumb   <file> <output>
  nasjidwg audit   <file> [--crc]

Formats are chosen by extension: .dwg .dxf .dxb .svg .pdf .json .geojson
--verify re-reads the written file and confirms the round trip.`;

/** Load any supported input into the document model. */
export const loadDrawing = (path: string): Drawing => {
  const bytes = new Uint8Array(readFileSync(path));
  const ext = extname(path).toLowerCase();
  if (ext === '.dwg') return readDwg(bytes);
  if (ext === '.json' || ext === '.geojson') {
    return readJson(new TextDecoder().decode(bytes));
  }
  if (ext === '.dxf' || ext === '.dxb') return readDxf(bytes);
  /* unknown extension: sniff the content */
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (/^AC10\d\d$/.test(magic)) return readDwg(bytes);
  if (isBinaryDxf(bytes)) return readDxf(bytes);
  return readDxf(bytes);
};

const saveDrawing = (d: Drawing, path: string, as: string): void => {
  const ext = extname(path).toLowerCase();
  if (ext === '.dwg') {
    const write = as === 'r2018' ? writeDwg2018
      : as === 'r2007' ? writeDwg2007
      : as === 'r2004' ? writeDwg2004
      : as === 'r12' ? writeDwgR12 : writeDwg2000;
    const { data, skipped } = write(d);
    writeFileSync(path, data);
    if (skipped.length) {
      const counts = new Map<string, number>();
      for (const s of skipped) counts.set(s, (counts.get(s) ?? 0) + 1);
      const list = [...counts].map(([k, n]) => `${n}× ${k}`).join(', ');
      process.stderr.write(`note: ${list} could not be written\n`);
    }
    return;
  }
  if (ext === '.dxb') { writeFileSync(path, writeDxfBinary(d)); return; }
  if (ext === '.dxf') { writeFileSync(path, writeDxf(d)); return; }
  if (ext === '.svg') { writeFileSync(path, writeSvg(d)); return; }
  if (ext === '.pdf') {
    const { data, skipped } = writePdf(d);
    writeFileSync(path, data);
    if (skipped.length) {
      const counts = new Map<string, number>();
      for (const s2 of skipped) {
        counts.set(s2.reason, (counts.get(s2.reason) ?? 0) + 1);
      }
      const list = [...counts].map(([k, n]) => `${n}× ${k}`).join(', ');
      process.stderr.write(`note: ${list}\n`);
    }
    return;
  }
  if (ext === '.geojson') {
    writeFileSync(path, JSON.stringify(toGeoJSON(d), null, 2));
    return;
  }
  if (ext === '.json') { writeFileSync(path, writeJson(d, true)); return; }
  throw new Error(`unknown output format "${ext}"`);
};

const info = (path: string): string => {
  const d = loadDrawing(path);
  const counts = new Map<string, number>();
  for (const e of d.entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const b = drawingBounds(d);
  const out: string[] = [];
  out.push(`${basename(path)}  ${d.header.version ?? 'DXF'}`);
  if (d.header.codepage) out.push(`  codepage    ${d.header.codepage}`);
  out.push(`  layers      ${d.layers.length}`);
  out.push(`  blocks      ${Object.keys(d.blocks).length}`);
  out.push(`  entities    ${d.entities.length} model, ${d.paperSpace?.length ?? 0} paper`);
  for (const [t, n] of [...counts].sort((a, b2) => b2[1] - a[1])) {
    out.push(`    ${t.padEnd(11)} ${n}`);
  }
  if (d.layouts?.length) out.push(`  layouts     ${d.layouts.map((l) => l.name).join(', ')}`);
  if (d.groups?.length) out.push(`  groups      ${d.groups.length}`);
  if (d.xrecords?.length) out.push(`  xrecords    ${d.xrecords.length}`);
  if (b) {
    const r = (n: number): string => String(Math.round(n * 1e3) / 1e3);
    out.push(`  extents     ${r(b.min.x)},${r(b.min.y)} .. ${r(b.max.x)},${r(b.max.y)}`);
  }
  const s = d.header.summary;
  if (s?.author || s?.lastSavedBy || s?.title) {
    out.push(`  summary     ${[s.title, s.author, s.lastSavedBy].filter(Boolean).join(' / ')}`);
  }
  if (d.header.thumbnail) {
    out.push(`  preview     ${d.header.thumbnail.format}, ${d.header.thumbnail.data.length} bytes`);
  }
  for (const w of d.warnings) out.push(`  ! ${w}`);
  return out.join('\n');
};

/** Layer listing, one line per layer with its state flags. */
const layersOf = (files: string[], onlyOn: boolean): string => {
  const out: string[] = [];
  for (const file of files) {
    const d = loadDrawing(file);
    const prefix = files.length > 1 ? basename(file) + ': ' : '';
    for (const ly of d.layers) {
      if (onlyOn && (!ly.on || ly.frozen)) continue;
      const flags = [
        ly.on ? '' : 'off', ly.frozen ? 'frozen' : '', ly.locked ? 'locked' : '',
        ly.plottable === false ? 'noplot' : ''
      ].filter(Boolean).join(',');
      const aci = ly.color.kind === 'aci' ? ly.color.index : '';
      out.push(prefix + ly.name
        + (aci !== '' ? `  color=${aci}` : '')
        + (ly.linetype ? `  ltype=${ly.linetype}` : '')
        + (flags ? `  [${flags}]` : ''));
    }
  }
  return out.join('\n');
};

/** Read the written file back and confirm nothing was lost silently. */
const verifyRoundTrip = (source: Drawing, outPath: string): string => {
  const back = loadDrawing(outPath);
  const count = (d: Drawing): number => d.entities.length
    + (d.paperSpace?.length ?? 0)
    + Object.values(d.blocks).reduce((n, b) => n + b.entities.length, 0);
  const lines = [
    `verify: ${count(back)}/${count(source)} entities, ` +
    `${back.layers.length}/${source.layers.length} layers, ` +
    `${Object.keys(back.blocks).length}/${Object.keys(source.blocks).length} blocks`
  ];
  for (const w of back.warnings) lines.push(`verify: ! ${w}`);
  return lines.join('\n');
};

const grep = (pattern: string, files: string[], ignoreCase: boolean): string => {
  const re = new RegExp(pattern, ignoreCase ? 'i' : '');
  const out: string[] = [];
  for (const file of files) {
    const d = loadDrawing(file);
    const scan = (list: Drawing['entities'], where: string): void => {
      for (const e of list) {
        const text = e.type === 'text' || e.type === 'mtext' ? e.text
          : e.type === 'tolerance' ? e.text
          : e.type === 'dimension' ? (e.text ?? '')
          : '';
        if (text && re.test(text)) {
          out.push(`${basename(file)}:${where}:${e.layer}: ${text.replace(/\n/g, ' ')}`);
        }
        if (e.type === 'insert') {
          for (const a of e.attributes ?? []) {
            if (re.test(a.text)) {
              out.push(`${basename(file)}:${where}:${a.layer}: ${a.text}`);
            }
          }
        }
      }
    };
    scan(d.entities, 'model');
    scan(d.paperSpace ?? [], 'paper');
    for (const [name, def] of Object.entries(d.blocks)) scan(def.entities, name);
  }
  return out.join('\n');
};

/** AUDIT: run the drawing's self-checks and report every finding. The
 *  format choice mirrors loadDrawing; it is repeated here only because
 *  readDwg must receive the CRC option this command can ask for. */
const audit = (path: string, checkCrc: boolean): { report: string; errors: number } => {
  const bytes = new Uint8Array(readFileSync(path));
  const ext = extname(path).toLowerCase();
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  const opts = checkCrc ? { checkCrc: true } : {};
  const d = ext === '.dwg' ? readDwg(bytes, opts)
    : ext === '.dxf' || ext === '.dxb' ? readDxf(bytes)
    : /^AC10\d\d$/.test(magic) ? readDwg(bytes, opts)
    : readDxf(bytes);
  const out: string[] = [];
  for (const w of d.warnings) out.push(`! ${w}`);
  const findings = auditDrawing(d);
  for (const f of findings) {
    out.push(`${f.severity.toUpperCase()} ${f.code}: ${f.message}`);
  }
  const count = (s: 'error' | 'warning' | 'info'): number =>
    findings.filter((f) => f.severity === s).length;
  const errors = count('error');
  out.push(`audit: ${errors} errors, ${count('warning')} warnings, ${count('info')} info`);
  return { report: out.join('\n'), errors };
};

export const runCli = (argv: string[]): number => {
  const args = argv.slice();
  const cmd = args.shift();
  try {
    if (!cmd || cmd === '-h' || cmd === '--help') {
      process.stdout.write(USAGE + '\n');
      return 0;
    }
    if (cmd === 'info') {
      if (!args[0]) throw new Error('info needs a file');
      process.stdout.write(info(args[0]) + '\n');
      return 0;
    }
    if (cmd === 'convert') {
      const asIdx = args.indexOf('--as');
      let as = 'r2000';
      if (asIdx !== -1) {
        as = (args[asIdx + 1] ?? 'r2000').toLowerCase();
        args.splice(asIdx, 2);
      }
      const verify = args.includes('--verify');
      const rest = args.filter((a) => a !== '--verify');
      if (rest.length < 2) throw new Error('convert needs an input and an output');
      const source = loadDrawing(rest[0]);
      saveDrawing(source, rest[1], as);
      if (verify) process.stdout.write(verifyRoundTrip(source, rest[1]) + '\n');
      return 0;
    }
    if (cmd === 'layers') {
      const onlyOn = args.includes('--on');
      const files = args.filter((a) => a !== '--on');
      if (!files.length) throw new Error('layers needs at least one file');
      const listing = layersOf(files, onlyOn);
      if (listing) process.stdout.write(listing + '\n');
      return 0;
    }
    if (cmd === 'grep') {
      const ignoreCase = args.includes('-i');
      const rest = args.filter((a) => a !== '-i');
      const pattern = rest.shift();
      if (!pattern || !rest.length) throw new Error('grep needs a pattern and files');
      const hits = grep(pattern, rest, ignoreCase);
      if (hits) process.stdout.write(hits + '\n');
      return hits ? 0 : 1;
    }
    if (cmd === 'thumb') {
      if (args.length < 2) throw new Error('thumb needs a file and an output');
      const d = loadDrawing(args[0]);
      const t = d.header.thumbnail;
      if (!t) throw new Error('this drawing has no embedded preview');
      writeFileSync(args[1], t.data);
      return 0;
    }
    if (cmd === 'audit') {
      const checkCrc = args.includes('--crc');
      const files = args.filter((a) => a !== '--crc');
      if (!files[0]) throw new Error('audit needs a file');
      const { report, errors } = audit(files[0], checkCrc);
      process.stdout.write(report + '\n');
      return errors ? 1 : 0;
    }
    throw new Error(`unknown command "${cmd}"`);
  } catch (err) {
    process.stderr.write(
      'nasjidwg: ' + (err instanceof Error ? err.message : String(err)) + '\n');
    return 2;
  }
};

/* Run only when invoked directly, so tests can import the helpers. */
const invoked = process.argv[1] ?? '';
if (/nasjidwg|cli\.(t|j)s$/.test(basename(invoked))) {
  process.exitCode = runCli(process.argv.slice(2));
}
