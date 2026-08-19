#!/usr/bin/env node
/* nasjidwg — external validation against real AutoCAD.
 *
 * Regenerates the test corpus (one DWG per writer version) into a scratch
 * directory, feeds each file to AutoCAD Core Console (open + AUDIT), and
 * prints a verdict table. This replaces self-consistency with external
 * proof: our own reader accepts far more than AutoCAD does.
 *
 * Locating AutoCAD: the ACCORECONSOLE environment variable wins; then the
 * default install path of AutoCAD 2027. Without it the run is skipped
 * (exit 0) so CI machines without AutoCAD stay green.
 *
 * Exit status: nonzero when a version in PASS_BASELINE (known to open
 * today) stops opening — i.e. an external regression.
 *
 * Verified quirk: accoreconsole occasionally reports "Cannot find the
 * specified drawing file" for a file that exists when runs follow each
 * other closely; the run is retried once before believing it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS = ['R12', 'R13', 'R14', 'R2000', 'R2004', 'R2007', 'R2018'];

/* Versions that must keep opening in AutoCAD (audit may still report
 * fixable errors). Extend as more containers start passing. R12 opens
 * end to end; R2000 and R2004 open with the complete corpus (ACAD_TABLE
 * included — its record needs the four override-presence tail bits and
 * densely numbered CLASSES records, see src/dwg/writer.ts). R14 opens
 * with the complete corpus since the round-4 fixes: synthesized
 * DIMSTYLE/MLINESTYLE STANDARD records, full-width BD/3BD thickness and
 * extrusion on simple entities (the BT/BE shortcuts are R2000+), the
 * promptless ATTRIB tail, and BYBLOCK-first linetype control slots.
 * R2018 opens audit-clean with the complete corpus since round 7: the
 * corpus SAB payload became a minimal ASM-format stream riding the AcDs
 * section, and R2007+ symbol names travel as raw UTF-16 (a literal
 * \U+XXXX escape in a name is flagged "un-normalized" and renamed).
 * R2007 joined in round 9, once three AC1021-only defects were found and
 * fixed: an empty CLASSES payload is refused exactly as it is at R2018
 * (the stub record it already wrote there now goes out from R2007 on);
 * the inline ACIS payload begins on the very BIT after its version field,
 * not on the next byte boundary, and is followed by a flag and the cached
 * wireframe block AutoCAD writes on every save; and an ASM-dialect kernel
 * stream cannot travel inline in an AC1021 file at all, so it leaves as
 * SAT or is reported. The one entity R2007 still cannot carry is
 * ACAD_TABLE, which the writer reports in `skipped`.
 * R13 joined in round 8, once a vintage AC1012 reference showed the four
 * places we had been writing the R14 spelling under an AC1012 signature:
 * the DICTIONARY hard-owner byte (R13c3 and later only — this one alone
 * cost ErrorStatus 53 before AUDIT ever ran), NUL-terminated strings,
 * the missing 53-byte ObjFreeSpace section, and the four trailing shorts
 * that close the header-variable section. See test/external.test.ts. */
const PASS_BASELINE = ['R12', 'R13', 'R14', 'R2000', 'R2004', 'R2007', 'R2018',
  'DXF'];

/* ------------------------------------------------------------------ */

const acPath = process.env.ACCORECONSOLE
  ?? 'C:\\Program Files\\Autodesk\\AutoCAD 2027\\accoreconsole.exe';
if (!existsSync(acPath)) {
  console.log('skipped: accoreconsole not found (set ACCORECONSOLE to override)');
  process.exit(0);
}

const work = join(tmpdir(), `nasjidwg-acad-${process.pid}`);
mkdirSync(work, { recursive: true });

/* -- regenerate the corpus through a vitest probe, so the files come from
 * the same writers the suite tests, TypeScript and all -- */
const probe = join(ROOT, 'test', `zz-validate-emit-${process.pid}.test.ts`);
writeFileSync(probe, `
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { DWG_VERSIONS, dwgOf, dxfOf } from './corpus.js';
it('emit', () => {
  for (const v of DWG_VERSIONS) {
    writeFileSync(${JSON.stringify(work)} + '/corpus_' + v + '.dwg', dwgOf(v));
  }
  writeFileSync(${JSON.stringify(work)} + '/corpus_DXF.dxf', dxfOf());
});
`);
try {
  const gen = spawnSync('npx', ['vitest', 'run', probe], {
    cwd: ROOT, shell: true, encoding: 'utf8', timeout: 240000
  });
  if (gen.status !== 0) {
    console.error('corpus generation failed:\n' + gen.stdout + gen.stderr);
    process.exit(2);
  }
} finally {
  rmSync(probe, { force: true });
}

const scr = join(work, 'audit.scr');
writeFileSync(scr, '_.AUDIT _Y\r\n_.QUIT _Y\r\n');

/* -- one accoreconsole run: open + AUDIT, decoded from UTF-16LE -- */
const runAcad = (dwg) => {
  const res = spawnSync(acPath, ['/i', dwg, '/s', scr, '/l', 'en-US'], {
    encoding: 'buffer', timeout: 120000
  });
  const raw = Buffer.concat([res.stdout ?? Buffer.alloc(0), res.stderr ?? Buffer.alloc(0)]);
  /* Core console speaks UTF-16LE; fall back to latin1 when it doesn't. */
  let text = raw.toString('utf16le');
  if (!text.includes('AutoCAD')) text = raw.toString('latin1');
  return text;
};

const verdictOf = (text) => {
  const audit = text.match(/Total errors found\s+(\d+)\s+fixed\s+(\d+)/);
  if (audit) {
    return {
      ok: true,
      label: audit[1] === '0'
        ? 'OPEN + AUDIT clean'
        : `OPEN, audit found ${audit[1]} fixed ${audit[2]}`
    };
  }
  if (text.includes('created by an incompatible version')) {
    return { ok: false, label: 'REJECTED: incompatible version' };
  }
  if (text.includes('Drawing file is not valid')) {
    return { ok: false, label: 'REJECTED: file not valid' };
  }
  if (text.includes('Cannot find the specified drawing file')) {
    return { ok: false, flaky: true, label: 'FLAKE: "cannot find" (retry)' };
  }
  const status = text.match(/ErrorStatus=(\d+)/);
  if (status) return { ok: false, label: `OPEN FAILED (ErrorStatus=${status[1]})` };
  return { ok: false, label: 'no verdict (timeout or crash)' };
};

const results = [];
/* the ASCII DXF writer is gated exactly like the DWG containers */
const targets = VERSIONS.map((v) => [v, `corpus_${v}.dwg`])
  .concat([['DXF', 'corpus_DXF.dxf']]);
for (const [v, file] of targets) {
  const dwg = join(work, file);
  let verdict = verdictOf(runAcad(dwg));
  if (verdict.flaky) {
    /* transient sharing/lock hiccup — one retry after a breather */
    await new Promise((f) => setTimeout(f, 5000));
    verdict = verdictOf(runAcad(dwg));
  }
  results.push([v, verdict]);
  console.log(`${v.padEnd(6)} ${verdict.label}`);
}

rmSync(work, { recursive: true, force: true });

let regressed = false;
for (const v of PASS_BASELINE) {
  const hit = results.find(([nm]) => nm === v);
  if (hit && !hit[1].ok) {
    console.error(`REGRESSION: ${v} used to open in AutoCAD and no longer does`);
    regressed = true;
  }
}
process.exit(regressed ? 1 : 0);
