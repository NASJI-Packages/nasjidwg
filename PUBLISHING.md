# Publishing nasjidwg to npm

The pre-publish checklist. Run every step from the repository root; stop at
the first failure.

## 1. Fill in the TODO fields

`package.json` deliberately omits these rather than carrying invented URLs.
Set them before the first publish:

- **TODO: set before publishing** — `repository` (e.g. `{ "type": "git", "url": "git+https://…" }`)
- **TODO: set before publishing** — `bugs` (issue tracker URL)
- **TODO: set before publishing** — `homepage`

## 2. Pick the version

The version field currently reads `0.1.0` and this document does not change
it. Recommendation only: the library's current state — five DWG releases
opened externally in AutoCAD 2027, four of them AUDIT 0 errors / 0 fixed
(see PARITY.md) — is well past a 0.1. **0.9.0** is the honest label for
"externally validated, pre-1.0 API": bump with
`npm version 0.9.0 --no-git-tag-version` when you agree.

## 3. Build, test, gate

```
npm run build        # tsc → dist/
npm run typecheck    # no emit, no errors
npm test             # vitest — the whole suite must be green
node examples/smoke.mjs   # dist ESM import → readDwg → writeSvg, must print "smoke OK"
```

`prepublishOnly` re-runs build + test as a safety net, but never rely on it
as the first execution.

## 4. Verify the tarball

```
npm pack --dry-run
```

Must contain **only**: `dist/**`, `README.md`, `LICENSE`, `NOTICE`,
`docs/comparison.svg`, `package.json`. Must NOT contain: `examples/`
(including the generated `examples/sample.dwg`), `test/`, `src/`, `tools/`,
`.tmp-acad/`, `docs/status.json`. The `files` whitelist in package.json
enforces this — if anything extra appears, fix `files`, do not add an
`.npmignore`.

Sanity-check the entry point resolves as the `exports` map promises:

```
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m).length + ' exports'))"
```

(84 exports as of this writing — or simply `node examples/smoke.mjs`, which
imports through the same path).

## 5. Publish

```
npm publish --access public
```

Then verify the published page shows the README and `npm i nasjidwg` +
`import { readDwg } from 'nasjidwg'` works in a scratch directory.

## Notes

- `examples/sample.dwg` is a generated artifact (corpus drawing, R2018
  writer) and is intentionally outside the package; regenerate it with a
  temporary vitest probe importing `sampleDrawing()` from `test/corpus.ts`.
- `sideEffects: false` is declared for bundlers; if a future module gains
  import-time side effects, revisit that flag before publishing.

## Environment gotchas (they cost hours if you meet them cold)

- **Spell the drive letter uppercase.** `npx vitest` fails on Windows when
  the shell's working directory is spelled with a lowercase drive letter: Node loads two
  copies of the vitest module under the two spellings of the path and every
  test file dies at its first `describe` with "Vitest failed to find the
  runner". `cd /E/nasjidwg` and the whole suite passes. Nothing to do with
  the code.
- **`tools/validate-external.mjs` needs AutoCAD.** It drives
  `accoreconsole.exe` (path overridable with `ACCORECONSOLE`) and simply
  reports "skipped" when it is absent, so it never blocks a build — but the
  six-release acceptance claim can only be re-verified on a machine that
  has AutoCAD installed.
