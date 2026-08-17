/* nasjidwg — generates docs/comparison.svg, the README comparison table.
 *
 * The image is data, so it is built from data: edit the ROWS below and
 * re-run `node tools/gen-comparison.mjs`. Nothing is drawn by hand and
 * the asset can never drift from what this file states.
 *
 * A PNG copy (for places that cannot show SVG) renders through any
 * installed Chromium at 2x, faithful fonts and all:
 *
 *   chrome --headless=new --disable-gpu --hide-scrollbars \
 *     --force-device-scale-factor=2 --window-size=1560,1335 \
 *     --screenshot=docs/comparison.png \
 *     "data:text/html,<style>html,body{margin:0;background:%230a0c10}img{display:block}</style><img src='file:///.../docs/comparison.svg' width=1560 height=1335>"
 *
 * Facts about the other projects are checked against each project's own
 * source and documentation, and the claims about THIS library are held to
 * the same standard: a row says what has actually been verified, not what
 * the code attempts. Names identify the projects; no affiliation is
 * implied. A '—' means the capability is not supported, not documented,
 * or simply not verified by us — it is not a claim that it is absent.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GREEN = '#3fb950';
const AMBER = '#d29922';
const GREY = '#8b949e';
const TEXT = '#e6edf3';
const DIM = '#9198a1';
const ACCENT = '#58a6ff';
const CARD = '#161b22';
const BG = '#0a0c10';
const RULE = '#30363d';
const ZEBRA = 'rgba(255,255,255,0.025)';

/** A cell: text lines + a tone. */
const g = (...lines) => ({ tone: GREEN, lines });
const a = (...lines) => ({ tone: AMBER, lines });
const n = (...lines) => ({ tone: GREY, lines });
const t = (...lines) => ({ tone: TEXT, lines });

/** null = group separator. */
const ROWS = [
  { cap: ['Language / runtime'], cells: [g('TypeScript', 'browser + Node'), t('C'), t('C#  .NET'), t('Python')] },
  { cap: ['Licence'], cells: [g('Apache-2.0'), a('GPL-3.0'), g('MIT'), g('MIT')] },
  { cap: ['Native dependencies'], cells: [g('none'), a('libc toolchain'), a('.NET runtime'), a('CPython')] },
  { cap: ['Runs in the browser'], cells: [g('yes'), a('via WASM port'), n('no'), n('no')] },
  null,
  { cap: ['Reads DWG'], cells: [g('R1.4 – R2018'), g('R1.4 – R2018'), g('R13 – R2018'), n('no')] },
  {
    cap: ['Writes DWG'],
    cells: [g('R2.6 – R2018 except R2007', 'pages LZ77-compressed'), a('R13 – R2018', '(no native R2007)'), g('R13 – R2018'), n('no')]
  },
  {
    cap: ['Native AC1021 (R2007) write'],
    cells: [a('no — container done,', '3 header fields unsolved'), n('falls back to R2010'), a('AC1021 header writer', 'is a stub (source read)'), n('n/a')]
  },
  { cap: ['Reads / writes DXF'], cells: [g('ASCII + binary'), g('ASCII + binary'), g('ASCII + binary'), g('ASCII + binary')] },
  null,
  { cap: ['Arabic shaping + RTL'], cells: [g('built in'), n('no'), n('no'), n('no')] },
  { cap: ['MTEXT inline codes, MIF,', '\\U+ escapes'], cells: [g('full'), a('partial'), a('partial'), a('partial')] },
  { cap: ['Every DWG codepage'], cells: [g('yes'), g('yes'), a('partial'), a('partial')] },
  null,
  { cap: ['SVG / PDF / GeoJSON export'], cells: [g('all three, built in'), a('GeoJSON only'), a('SVG only'), a('SVG + PDF add-ons')] },
  { cap: ['Hatch pattern explosion'], cells: [g('yes'), n('no'), n('no'), g('yes')] },
  { cap: ['ACIS SAB to SAT'], cells: [g('yes'), g('yes'), a('partial'), a('reads SAB, writes SAT')] },
  null,
  {
    cap: ['Sealed passthrough of unknown', 'objects (bit-exact, incl. proxies)'],
    cells: [g('yes — entities,', 'objects, failed decodes'), a('same-version rewrite only'), n('—'), a('DXF tags only')]
  },
  {
    cap: ['Unknown data across versions', '(A→B→A wrap + unwrap)'],
    cells: [g('yes'), a('degrades to placeholders'), n('—'), n('—')]
  },
  { cap: ['Handle-stable rewrite'], cells: [g('preserveHandles'), n('—'), n('—'), n('—')] },
  { cap: ['Built-in audit / self-check'], cells: [g('auditDrawing + CLI'), n('—'), n('—'), g('ezdxf.audit')] },
  { cap: ['SHX shape-font text rendering'], cells: [g('full bytecode engine'), n('—'), n('—'), g('yes (v1.1+)')] },
  {
    cap: ['External validation vs AutoCAD'],
    cells: [g('6 releases open in AutoCAD 2027,', 'all at AUDIT 0 errors (gated)'), n('—'), n('—'), n('n/a (no DWG)')]
  },
  null,
  {
    cap: ['Test fixtures'],
    cells: [g('generated at run time,', 'nothing shipped'), t('shipped drawings'), t('shipped drawings'), t('shipped drawings')]
  }
];

const W = 1560;
const CAP_X = 54;
const COL_X = [524, 774, 1024, 1274];
const HEADERS = ['nasjidwg', 'LibreDWG', 'ACadSharp', 'ezdxf'];
const FONT = 'Segoe UI, -apple-system, Roboto, Helvetica, Arial, sans-serif';

const esc = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---- live status band (docs/status.json, optional) ----------------
 * When the campaign status file exists, a board renders under the
 * subtitle: per-milestone verdict chips, what is in flight, and what
 * recently landed — so the picture always says where the work stands. */
const here0 = dirname(fileURLToPath(import.meta.url));
const statusPath = join(here0, '..', 'docs', 'status.json');
const status = existsSync(statusPath)
  ? JSON.parse(readFileSync(statusPath, 'utf8')) : null;

const parts = [];
let y = 160;                              /* header baseline */

if (status) {
  y = 148;
  parts.push(`<text x="${CAP_X}" y="${y}" font-size="18" font-weight="700" fill="${ACCENT}">`
    + `${esc(status.headline)}</text>`);
  parts.push(`<text x="${W - CAP_X}" y="${y}" text-anchor="end" font-size="13" fill="${DIM}">`
    + `${esc(status.updated)}   ·   ${esc(status.tests)}</text>`);
  y += 14;
  const chip = { pass: GREEN, run: AMBER, todo: GREY };
  const mark = { pass: '✓', run: '▶', todo: '•' };
  for (const v of status.verdicts ?? []) {
    y += 24;
    parts.push(`<text x="${CAP_X + 8}" y="${y}" font-size="14" fill="${chip[v.state] ?? GREY}">`
      + `${mark[v.state] ?? '•'}  ${esc(v.label)}</text>`);
    parts.push(`<text x="${CAP_X + 430}" y="${y}" font-size="14" fill="${chip[v.state] ?? GREY}">`
      + `${esc(v.note)}</text>`);
  }
  if (status.inflight) {
    y += 26;
    const words = String(status.inflight).split(' ');
    let line = '';
    for (const wd of words) {
      if ((line + ' ' + wd).length > 130) {
        parts.push(`<text x="${CAP_X + 8}" y="${y}" font-size="13" fill="${DIM}">${esc(line)}</text>`);
        y += 19;
        line = wd;
      } else line = line ? line + ' ' + wd : wd;
    }
    parts.push(`<text x="${CAP_X + 8}" y="${y}" font-size="13" fill="${DIM}">${esc(line)}</text>`);
  }
  for (const r of status.recentlyLanded ?? []) {
    y += 21;
    parts.push(`<text x="${CAP_X + 8}" y="${y}" font-size="13" fill="${TEXT}">+ ${esc(r)}</text>`);
  }
  y += 18;
  parts.push(`<line x1="${CAP_X}" y1="${y}" x2="${W - CAP_X}" y2="${y}" stroke="${RULE}"/>`);
  y += 40;                                /* table header baseline */
}

parts.push(
  `<text x="${CAP_X}" y="${y}" font-size="16" font-weight="600" fill="${TEXT}">Capability</text>`);
HEADERS.forEach((h, i) => {
  parts.push(`<text x="${COL_X[i]}" y="${y}" font-size="16" font-weight="600" `
    + `fill="${i === 0 ? ACCENT : TEXT}">${h}</text>`);
});
y += 18;
parts.push(`<line x1="${CAP_X}" y1="${y}" x2="${W - CAP_X}" y2="${y}" stroke="${RULE}"/>`);
y += 8;

let zebra = false;
for (const row of ROWS) {
  if (row === null) {
    y += 6;
    parts.push(`<line x1="${CAP_X}" y1="${y}" x2="${W - CAP_X}" y2="${y}" stroke="${RULE}"/>`);
    y += 6;
    zebra = false;
    continue;
  }
  const lines = Math.max(row.cap.length, ...row.cells.map((c) => c.lines.length));
  const h = 26 + lines * 21;
  if (zebra) {
    parts.push(`<rect x="${CAP_X - 16}" y="${y}" width="${W - 2 * CAP_X + 32}" height="${h}" `
      + `rx="6" fill="${ZEBRA}"/>`);
  }
  zebra = !zebra;
  const base = y + 16 + 15;               /* first text baseline in the row */
  row.cap.forEach((line, k) => {
    parts.push(`<text x="${CAP_X}" y="${base + k * 21}" font-size="15" `
      + `fill="${TEXT}">${esc(line)}</text>`);
  });
  row.cells.forEach((cell, i) => {
    cell.lines.forEach((line, k) => {
      parts.push(`<text x="${COL_X[i]}" y="${base + k * 21}" font-size="15" `
        + `fill="${cell.tone}">${esc(line)}</text>`);
    });
  });
  y += h;
}

y += 26;
parts.push(`<text x="${CAP_X}" y="${y}" font-size="13" fill="${DIM}">`
  + 'Green = does it natively&#160;&#160;&#160;Amber = partial or with caveats'
  + '&#160;&#160;&#160;Grey / — = not supported, not documented, or not verified by us'
  + '</text>');
y += 44;

const H = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<rect width="${W}" height="${H}" fill="${BG}"/>
<rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="14" fill="${CARD}"/>
<text x="${CAP_X}" y="82" font-size="30" font-weight="700" fill="${TEXT}">nasjidwg compared with the other open DWG/DXF libraries</text>
<text x="${CAP_X}" y="110" font-size="14" fill="${DIM}">Facts checked against each project's own source and documentation. Names are used to identify the projects; no affiliation is implied.</text>
${parts.join('\n')}
</svg>
`;

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, '..', 'docs', 'comparison.svg');
writeFileSync(svgPath, svg);
console.log(`docs/comparison.svg written (${W}×${H})`);

/* ---- optional PNG render: `node tools/gen-comparison.mjs --png` ----
 * Uses whatever Chromium is installed (Chrome, then Edge). Runs from
 * Node, so no MSYS argument mangling to worry about. */
if (process.argv.includes('--png')) {
  const browsers = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(existsSync);
  if (!browsers.length) {
    console.error('png: no Chrome/Edge found — SVG written, PNG skipped');
  } else {
    const wrap = join(tmpdir(), 'nasjidwg-cmp-wrap.html');
    const fileUrl = 'file:///' + svgPath.replace(/\\/g, '/');
    writeFileSync(wrap,
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:${BG}}img{display:block}</style></head>`
      + `<body><img src="${fileUrl}" width="${W}" height="${H}"></body></html>`);
    const pngPath = join(here, '..', 'docs', 'comparison.png');
    const res = spawnSync(browsers[0], [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--user-data-dir=${join(tmpdir(), 'nasjidwg-chr-prof')}`,
      '--force-device-scale-factor=2',
      `--window-size=${W},${H}`,
      `--screenshot=${pngPath}`,
      'file:///' + wrap.replace(/\\/g, '/')
    ], { timeout: 120000 });
    if (existsSync(pngPath)) console.log(`docs/comparison.png rendered (${W * 2}×${H * 2})`);
    else console.error('png: render failed', res.stderr?.toString().slice(-200));
  }
}
