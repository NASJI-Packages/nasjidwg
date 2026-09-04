#!/usr/bin/env node
/* nasjidwg — the conformance campaign against the reference CAD.
 *
 * validate-external.mjs proves one thing: the synthetic corpus opens. This
 * runs the GENUINE drawings the reference itself ships (and any dropped in
 * CORPUS_DIR) both ways and counts:
 *
 *   read    the reference lists every entity of the drawing by DXF name
 *           (a LISP script); our reader must see the same names, the same
 *           number of each, the same layers and blocks.
 *   write   what we read is written back in every release we write; the
 *           reference must open each one, AUDIT it at zero errors, and
 *           count the same entities again.
 *   dxf     the reference's own DXF of the drawing goes through readDxf
 *           and out as a 2018 DWG, to the same two checks.
 *
 * Every mismatch is a row in the report, per file, per release, with the
 * entity names that differ — the list this campaign works down. The
 * report is written as JSON beside a text summary so a run can be diffed
 * against the previous one.
 *
 *   node tools/conformance.mjs [--only <substring>] [--versions 2018,2000]
 *   ACCORECONSOLE=<path>  CORPUS_DIR=<dir with .dwg/.dxf>  OUT=<dir>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'index.js')).href);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt('--only', '');
const VERSIONS = opt('--versions', '2018,2013,2010,2007,2004,2000,R14').split(',');
const acPath = process.env.ACCORECONSOLE ?? 'C:\\Program Files\\Autodesk\\AutoCAD 2027\\accoreconsole.exe';
if (!existsSync(acPath)) { console.log('skipped: accoreconsole not found'); process.exit(0); }
const OUT = process.env.OUT ?? join(tmpdir(), 'nasjidwg-conformance');
mkdirSync(OUT, { recursive: true });

/* ---- the corpus: the reference's samples, plus whatever CORPUS_DIR holds ---- */
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(dwg|dxf)$/i.test(f)) out.push(p);
  }
  return out;
};
const corpus = [
  ...walk('C:\\Program Files\\Autodesk\\AutoCAD 2027\\Sample'),
  ...walk(process.env.CORPUS_DIR ?? ''),
].filter((p) => !ONLY || p.toLowerCase().includes(ONLY.toLowerCase()));

/* ---- the reference console ---- */
const LISP = `
(defun nasj-count (/ ss i e n tbl name k)
  (setq tbl nil)
  (setq ss (ssget "X"))
  (if ss (progn
    (setq i 0 n (sslength ss))
    (while (< i n)
      (setq e (entget (ssname ss i)))
      (setq name (cdr (assoc 0 e)))
      (setq k (assoc name tbl))
      (if k (setq tbl (subst (cons name (1+ (cdr k))) k tbl)) (setq tbl (cons (cons name 1) tbl)))
      (setq i (1+ i)))))
  (princ "\\nNASJ-ENTS ")
  (foreach p tbl (princ (strcat (car p) "=" (itoa (cdr p)) " ")))
  (princ "\\nNASJ-LAYERS ")
  (setq e (tblnext "LAYER" T)) (while e (princ (strcat (cdr (assoc 2 e)) ";")) (setq e (tblnext "LAYER")))
  (princ "\\nNASJ-BLOCKS ")
  (setq e (tblnext "BLOCK" T)) (while e (princ (strcat (cdr (assoc 2 e)) ";")) (setq e (tblnext "BLOCK")))
  (princ "\\nNASJ-END")
  (princ))
(nasj-count)
`;
const lsp = join(OUT, 'nasj-count.lsp');
writeFileSync(lsp, LISP);
const scr = join(OUT, 'probe.scr');
writeFileSync(scr, `(load "${lsp.replace(/\\/g, '/')}")\r\n_.AUDIT _Y\r\n_.QUIT _Y\r\n`);
const saveScr = (out, fmt) => {
  const p = join(OUT, `save-${basename(out)}.scr`);
  writeFileSync(p, `_.SAVEAS ${fmt} "${out}"\r\n_.QUIT _Y\r\n`);
  return p;
};
const runAcad = (file, script) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = spawnSync(acPath, ['/i', file, '/s', script, '/l', 'en-US'], { encoding: 'buffer', timeout: 180000 });
    const raw = Buffer.concat([res.stdout ?? Buffer.alloc(0), res.stderr ?? Buffer.alloc(0)]);
    let text = raw.toString('utf16le');
    if (!text.includes('AutoCAD')) text = raw.toString('latin1');
    if (!text.includes('Cannot find the specified drawing file')) return text;
  }
  return '';
};
const parseProbe = (text) => {
  const ents = {};
  const m = text.match(/NASJ-ENTS ([^\n]*)/);
  if (m) for (const kv of m[1].trim().split(/\s+/)) { const [k, v] = kv.split('='); if (k) ents[k] = Number(v); }
  const layers = (text.match(/NASJ-LAYERS ([^\n]*)/)?.[1] ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  const blocks = (text.match(/NASJ-BLOCKS ([^\n]*)/)?.[1] ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  const audit = text.match(/Total errors found\s+(\d+)\s+fixed\s+(\d+)/);
  const opened = !!m || !!audit;
  let why = '';
  if (!opened) {
    why = (text.match(/Drawing file is not valid|created by an incompatible version|Invalid or incomplete DXF input|DXF read error[^\n]*|Error in [A-Z_]+ Table|Missing [^\n]*|ErrorStatus=\d+/) ?? ['no verdict'])[0];
  }
  return { opened, why, audit: audit ? [Number(audit[1]), Number(audit[2])] : null, ents, layers, blocks };
};

/* ---- our side: the model's entity names in the reference's spelling ---- */
const DXF_NAME = {
  line: 'LINE', point: 'POINT', circle: 'CIRCLE', arc: 'ARC', ellipse: 'ELLIPSE',
  polyline: 'LWPOLYLINE', spline: 'SPLINE', text: 'TEXT', mtext: 'MTEXT', insert: 'INSERT',
  hatch: 'HATCH', solid: 'SOLID', ray: 'RAY', xline: 'XLINE', leader: 'LEADER', dimension: 'DIMENSION',
  viewport: 'VIEWPORT', face3d: '3DFACE', shape: 'SHAPE', tolerance: 'TOLERANCE', mline: 'MLINE',
  mesh: 'MESH', image: 'IMAGE', underlay: 'UNDERLAY', acis: '3DSOLID', mleader: 'MULTILEADER',
  light: 'LIGHT', table: 'ACAD_TABLE', proxy: 'ACAD_PROXY_ENTITY', ole: 'OLE2FRAME', pointcloud: 'POINTCLOUD',
};
const ourCounts = (drawing) => {
  const ents = {};
  /* the reference's (ssget "X") walks every layout: model space, the
     first paper space, and the further paper spaces the reader keeps as
     blocks named *Paper_Space<n> */
  const extraPaper = Object.entries(drawing.blocks ?? {})
    .filter(([nm]) => /^\*paper_space/i.test(nm)).flatMap(([, b]) => b.entities);
  const all = [...drawing.entities, ...(drawing.paperSpace ?? []), ...extraPaper];
  for (const e of all) {
    let name = DXF_NAME[e.type] ?? e.type.toUpperCase();
    if (e.type === 'polyline' && e.is3d) name = 'POLYLINE';
    if (e.type === 'ray' && e.infinite) name = 'XLINE';
    if (e.type === 'acis') name = e.solidKind ? e.solidKind.toUpperCase() : '3DSOLID';
    if (e.type === 'proxy') name = 'ACAD_PROXY_ENTITY';
    if (e.type === 'unknown') name = (e.dxfName ?? 'UNKNOWN').toUpperCase();
    ents[name] = (ents[name] ?? 0) + 1;
  }
  return ents;
};
const diffCounts = (ref, ours) => {
  const names = new Set([...Object.keys(ref), ...Object.keys(ours)]);
  const out = [];
  for (const n of [...names].sort()) if ((ref[n] ?? 0) !== (ours[n] ?? 0)) out.push(`${n} ${ref[n] ?? 0}->${ours[n] ?? 0}`);
  return out;
};

/* ---- the run ---- */
const WRITERS = {
  2018: lib.writeDwg2018, 2013: lib.writeDwg2018, 2010: lib.writeDwg2018,
  2007: lib.writeDwg2007, 2004: lib.writeDwg2004, 2000: lib.writeDwg2000, R14: lib.writeDwgR14,
};
const report = [];
const line = (s) => { console.log(s); };
for (const src of corpus) {
  const name = basename(src);
  const row = { file: name, ref: null, read: null, writes: {}, dxf: null };
  report.push(row);
  line(`\n== ${name}`);
  /* 1. the reference's view of the original */
  const ref = parseProbe(runAcad(src, scr));
  row.ref = ref;
  if (!ref.opened) { line(`  reference cannot open the original: ${ref.why}`); continue; }
  const refTotal = Object.values(ref.ents).reduce((a, b) => a + b, 0);
  line(`  reference: ${refTotal} entities, ${ref.layers.length} layers, ${ref.blocks.length} blocks, audit ${ref.audit?.join('/')}`);
  /* 2. our reader */
  let drawing;
  try {
    const bytes = readFileSync(src);
    drawing = extname(src).toLowerCase() === '.dxf' ? lib.readDxf(bytes.toString('utf8')) : lib.readDwg(new Uint8Array(bytes));
  } catch (err) {
    row.read = { error: String(err.message ?? err) };
    line(`  READ FAILED: ${row.read.error}`);
    continue;
  }
  const ours = ourCounts(drawing);
  const d = diffCounts(ref.ents, ours);
  const ourLayers = drawing.layers.map((l) => l.name);
  const missingLayers = ref.layers.filter((l) => !ourLayers.some((o) => o.toLowerCase() === l.toLowerCase()));
  const ourBlocks = Object.keys(drawing.blocks ?? {});
  /* named blocks by name; anonymous ones (*U, *D, *T, *B, *A, *X…) by
     count per prefix, since the reader numbers them itself; a name with
     a '|' is a block of an external reference, which no reader carries
     without the referenced file — listed apart */
  const named = ref.blocks.filter((b) => !/^\*/.test(b) && !b.includes('|') && !/^\*(Model|Paper)_Space/i.test(b));
  const missingBlocks = named.filter((b) => !ourBlocks.some((o) => o.toLowerCase() === b.toLowerCase()));
  const prefix = (b) => (b.match(/^\*([A-Z])/i) ?? [, ''])[1].toUpperCase();
  const anonRef = {}, anonOurs = {};
  for (const b of ref.blocks) if (/^\*[A-Z]\d/i.test(b) && !/^\*(Model|Paper)_Space/i.test(b)) anonRef[prefix(b)] = (anonRef[prefix(b)] ?? 0) + 1;
  for (const b of ourBlocks) if (/^\*[A-Z]\d/i.test(b) && !/^\*(Model|Paper)_Space/i.test(b)) anonOurs[prefix(b)] = (anonOurs[prefix(b)] ?? 0) + 1;
  const anonDiff = [...new Set([...Object.keys(anonRef), ...Object.keys(anonOurs)])].filter((k) => (anonRef[k] ?? 0) !== (anonOurs[k] ?? 0)).map((k) => `*${k} ${anonRef[k] ?? 0}->${anonOurs[k] ?? 0}`);
  const xrefBlocks = ref.blocks.filter((b) => b.includes('|')).length;
  row.read = { diff: d, missingLayers, missingBlocks, anonDiff, xrefBlocks, warnings: (drawing.warnings ?? []).length };
  line(`  read: ${d.length ? 'DIFF ' + d.join(', ') : 'entities match'}${missingLayers.length ? '; layers missing: ' + missingLayers.join(', ') : ''}${missingBlocks.length ? '; blocks missing: ' + missingBlocks.join(', ') : ''}${anonDiff.length ? '; anonymous blocks ' + anonDiff.join(', ') : ''}${xrefBlocks ? '; ' + xrefBlocks + ' xref-dependent blocks (not modelled)' : ''}`);
  /* 3. every writer, back through the reference */
  for (const v of VERSIONS) {
    const w = WRITERS[v];
    if (!w) continue;
    const out = join(OUT, `${name.replace(/\.[^.]+$/, '')}.${v}.dwg`);
    let res;
    try { res = w(drawing, { preserveHandles: true }); writeFileSync(out, res.data); }
    catch (err) { row.writes[v] = { error: String(err.message ?? err) }; line(`  write ${v}: WRITER THREW ${row.writes[v].error}`); continue; }
    const back = parseProbe(runAcad(out, scr));
    const dd = back.opened ? diffCounts(ref.ents, back.ents) : [];
    row.writes[v] = { opened: back.opened, why: back.why, audit: back.audit, diff: dd, skipped: res.skipped?.length ?? 0, downgraded: res.downgraded?.length ?? 0 };
    line(`  write ${String(v).padEnd(4)}: ${back.opened ? `open, audit ${back.audit?.join('/')}, ${dd.length ? 'DIFF ' + dd.join(', ') : 'entities match'}` : 'REJECTED ' + back.why}${res.skipped?.length ? ` (skipped ${res.skipped.length})` : ''}`);
  }
  /* 4. the reference's DXF of the original, through readDxf and out as 2018 */
  if (extname(src).toLowerCase() === '.dwg') {
    const refDxf = join(OUT, `${name.replace(/\.[^.]+$/, '')}.ref.dxf`);
    runAcad(src, saveScr(refDxf, 'DXF 16'));
    if (existsSync(refDxf)) {
      try {
        const dx = lib.readDxf(readFileSync(refDxf, 'utf8'));
        const dxd = diffCounts(ref.ents, ourCounts(dx));
        const out = join(OUT, `${name.replace(/\.[^.]+$/, '')}.dxf2018.dwg`);
        writeFileSync(out, lib.writeDwg2018(dx, { preserveHandles: true }).data);
        const back = parseProbe(runAcad(out, scr));
        row.dxf = { readDiff: dxd, opened: back.opened, why: back.why, audit: back.audit, diff: back.opened ? diffCounts(ref.ents, back.ents) : [] };
        line(`  dxf: read ${dxd.length ? 'DIFF ' + dxd.join(', ') : 'match'}; back as 2018 ${back.opened ? `open, audit ${back.audit?.join('/')}, ${row.dxf.diff.length ? 'DIFF ' + row.dxf.diff.join(', ') : 'match'}` : 'REJECTED ' + back.why}`);
      } catch (err) { row.dxf = { error: String(err.message ?? err) }; line(`  dxf: FAILED ${row.dxf.error}`); }
    }
  }
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
/* the summary: what is not yet exact */
let bad = 0;
for (const r of report) {
  const problems = [];
  if (r.ref && !r.ref.opened) problems.push('reference cannot open original');
  if (r.read?.error) problems.push('read error');
  if (r.read?.diff?.length) problems.push('read diff');
  if (r.read?.missingLayers?.length) problems.push('layers');
  if (r.read?.missingBlocks?.length) problems.push('blocks');
  if (r.read?.anonDiff?.length) problems.push('anonymous blocks');
  for (const [v, w] of Object.entries(r.writes)) {
    if (w.error || !w.opened) problems.push(`write ${v} rejected`);
    else if (w.audit && w.audit[0] > 0) problems.push(`write ${v} audit ${w.audit[0]}`);
    else if (w.diff.length) problems.push(`write ${v} diff`);
  }
  if (r.dxf && (r.dxf.error || !r.dxf.opened || r.dxf.readDiff?.length || r.dxf.diff?.length)) problems.push('dxf');
  if (problems.length) bad++;
  line(`${problems.length ? 'FAIL' : 'ok  '} ${r.file}${problems.length ? ': ' + problems.join('; ') : ''}`);
}
line(`\n${report.length - bad}/${report.length} drawings exact. Report: ${join(OUT, 'report.json')}`);
process.exit(bad ? 1 : 0);
