#!/usr/bin/env node
/* nasjidwg — the reader against every release the reference writes.
 *
 * conformance.mjs reads each sample in the release it ships in. This has
 * the reference re-save a sample into every release it can (R14, 2000,
 * 2004, 2007, 2010, 2013, 2018, and DXF), reads each one with readDwg /
 * readDxf, and compares the entity census with the reference's own count
 * of the original — the same drawing, seven encodings, one expected answer.
 *
 *   node tools/reader-versions.mjs [--only <substring>] [--limit N]
 *   ACCORECONSOLE=<path>  OUT=<dir>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'index.js')).href);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt('--only', '');
const LIMIT = Number(opt('--limit', '0')) || Infinity;
const acPath = process.env.ACCORECONSOLE ?? 'C:\\Program Files\\Autodesk\\AutoCAD 2027\\accoreconsole.exe';
if (!existsSync(acPath)) { console.log('skipped: accoreconsole not found'); process.exit(0); }
const OUT = process.env.OUT ?? join(tmpdir(), 'nasjidwg-reader-versions');
mkdirSync(OUT, { recursive: true });

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.dwg$/i.test(f)) out.push(p);
  }
  return out;
};
const corpus = walk('C:\\Program Files\\Autodesk\\AutoCAD 2027\\Sample')
  .filter((p) => !ONLY || p.toLowerCase().includes(ONLY.toLowerCase())).slice(0, LIMIT);

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
  (princ "\\nNASJ-END")
  (princ))
(nasj-count)
`;
const lsp = join(OUT, 'nasj-count.lsp');
writeFileSync(lsp, LISP);
const probe = join(OUT, 'probe.scr');
writeFileSync(probe, `(load "${lsp.replace(/\\/g, '/')}")\r\n_.QUIT _Y\r\n`);
const runAcad = (file, script) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = spawnSync(acPath, ['/i', file, '/s', script, '/l', 'en-US'], { encoding: 'buffer', timeout: 240000 });
    const raw = Buffer.concat([res.stdout ?? Buffer.alloc(0), res.stderr ?? Buffer.alloc(0)]);
    let text = raw.toString('utf16le');
    if (!text.includes('AutoCAD')) text = raw.toString('latin1');
    if (!text.includes('Cannot find the specified drawing file')) return text;
  }
  return '';
};
const census = (text) => {
  const ents = {};
  const m = text.match(/NASJ-ENTS ([^\n]*)/);
  if (m) for (const kv of m[1].trim().split(/\s+/)) { const [k, v] = kv.split('='); if (k) ents[k] = Number(v); }
  return m ? ents : null;
};

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
  const extraPaper = Object.entries(drawing.blocks ?? {})
    .filter(([nm]) => /^\*paper_space/i.test(nm)).flatMap(([, b]) => b.entities);
  const all = [...drawing.entities, ...(drawing.paperSpace ?? []), ...extraPaper];
  /* the further columns of a multi-column MTEXT are entities of their
     own in the file, named by handle in the first column's
     ACAD_MTEXT_COLUMNS xdata; the reference folds them into one */
  const columnChildren = new Set();
  for (const e of all) {
    if (e.type !== 'mtext') continue;
    for (const g of e.xdata ?? []) {
      if (!g.values.some((v) => typeof v.value === 'string' && /ACAD_MTEXT_COLUMN/i.test(v.value))) continue;
      for (const v of g.values) if (v.code === 1005 && typeof v.value === 'string') columnChildren.add(v.value.toUpperCase());
    }
  }
  for (const e of all) {
    if (e.type === 'mtext' && e.handle && columnChildren.has(e.handle.toUpperCase())) continue;
    let name = DXF_NAME[e.type] ?? e.type.toUpperCase();
    /* a heavy polyline (VERTEX records) is the reference's POLYLINE; the
       inline one its LWPOLYLINE */
    if (e.type === 'polyline' && (e.heavy || e.vertices.some((v) => v.z !== undefined))) name = 'POLYLINE';
    if (e.type === 'ray' && e.infinite) name = 'XLINE';
    if (e.type === 'acis') name = e.solidKind ? e.solidKind.toUpperCase() : '3DSOLID';
    if (e.type === 'proxy') name = 'ACAD_PROXY_ENTITY';
    if (e.type === 'image' && e.wipeout) name = 'WIPEOUT';
    if (e.type === 'text' && e.attribute === 'attdef') name = 'ATTDEF';
    if (e.type === 'unknown') name = (e.sourceType ?? e.appClass?.dxfName ?? 'UNKNOWN').toUpperCase();
    ents[name] = (ents[name] ?? 0) + 1;
  }
  return ents;
};
const diffCounts = (ref, ours) => {
  const names = new Set([...Object.keys(ref), ...Object.keys(ours)]);
  return [...names].sort().filter((n) => (ref[n] ?? 0) !== (ours[n] ?? 0)).map((n) => `${n} ${ref[n] ?? 0}->${ours[n] ?? 0}`);
};

/* the releases the reference's SAVEAS offers, and the DXF of the current one */
const RELEASES = [['R14', 'R14'], ['2000', '2000'], ['2004', '2004'], ['2007', '2007'], ['2010', '2010'], ['2013', '2013'], ['2018', '2018']];
const report = [];
for (const src of corpus) {
  const name = basename(src);
  const stem = name.replace(/\.[^.]+$/, '');
  console.log(`\n== ${name}`);
  const ref = census(runAcad(src, probe));
  if (!ref) { console.log('  reference cannot open the original'); continue; }
  const total = Object.values(ref).reduce((a, b) => a + b, 0);
  console.log(`  reference: ${total} entities`);
  const row = { file: name, ref, reads: {} };
  report.push(row);
  /* one console run writes every release of this drawing */
  const outs = RELEASES.map(([label, fmt]) => [label, join(OUT, `${stem}.${label}.dwg`)]);
  const dxfOut = join(OUT, `${stem}.ref.dxf`);
  const saveAll = join(OUT, `save-${stem}.scr`);
  writeFileSync(saveAll, outs.map(([label, out]) => `_.SAVEAS ${RELEASES.find(([l]) => l === label)[1]} "${out}"`).join('\r\n')
    + `\r\n_.SAVEAS DXF 16 "${dxfOut}"\r\n_.QUIT _Y\r\n`);
  runAcad(src, saveAll);
  for (const [label, out] of [...outs, ['DXF', dxfOut]]) {
    if (!existsSync(out)) { row.reads[label] = { missing: true }; console.log(`  ${label.padEnd(5)}: the reference did not write it`); continue; }
    try {
      const bytes = readFileSync(out);
      const d = label === 'DXF' ? lib.readDxf(bytes.toString('utf8')) : lib.readDwg(new Uint8Array(bytes));
      const diff = diffCounts(ref, ourCounts(d));
      row.reads[label] = { diff, warnings: (d.warnings ?? []).length };
      console.log(`  ${label.padEnd(5)}: ${diff.length ? 'DIFF ' + diff.join(', ') : 'match'}${d.warnings?.length ? ` (${d.warnings.length} warnings)` : ''}`);
    } catch (err) {
      row.reads[label] = { error: String(err.message ?? err) };
      console.log(`  ${label.padEnd(5)}: READ FAILED ${row.reads[label].error}`);
    }
  }
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
let bad = 0;
for (const r of report) {
  const problems = Object.entries(r.reads).filter(([, v]) => v.error || v.diff?.length || v.missing).map(([k, v]) => `${k}${v.error ? ' error' : v.missing ? ' missing' : ''}`);
  if (problems.length) bad++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${r.file}${problems.length ? ': ' + problems.join(', ') : ''}`);
}
console.log(`\n${report.length - bad}/${report.length} drawings read exactly in every release. Report: ${join(OUT, 'report.json')}`);
process.exit(bad ? 1 : 0);
