# Parity

What nasjidwg does, release by release, and what it does not. Everything
here is checked by the test suite, which builds its own fixtures with the
library's own writers — nothing in this repository is a drawing produced
by other software.

| Release | Signature | Read | Write | AutoCAD 2027 verdict |
| --- | --- | --- | --- | --- |
| R1.4 | MC0.0 … AC1.50 | yes | no | — |
| R2.6 / R2.10 | AC1003 / AC2.10 | yes | yes | too old to judge |
| R9 / R10 | AC1004 – AC1006 | yes | yes | too old to judge |
| R11 / R12 | AC1009 | yes | yes | **opens, AUDIT 0 errors** (gated) |
| R13 | AC1012 | yes | yes | **opens, AUDIT 0 errors** (gated) |
| R14 | AC1014 | yes | yes | **opens, AUDIT 0 errors** (gated) |
| R2000 | AC1015 | yes | yes | **opens, AUDIT 0 errors** (gated) |
| R2004 | AC1018 | yes | yes (LZ77 pages) | **opens, AUDIT 0 errors** (gated) |
| R2007 | AC1021 | yes | yes (native RS container) | **opens, AUDIT 0 errors** (gated) |
| R2010 / R2013 / R2018 | AC1024 / AC1027 / AC1032 | yes | yes (LZ77 pages) | **opens, AUDIT 0 errors** (gated) |

All seven writable release families are regression-gated against AutoCAD
itself, **every one at zero AUDIT errors**: `node tools/validate-external.mjs`
opens and AUDITs each one in AutoCAD 2027's Core Console, and fails if any
of them stops passing.

The R2018 writer additionally survived a heavy-field campaign: the same
72 MB production drawing (246k entities, AEC content, 9,522 fit splines,
68 ACIS solids) rewritten in both handle modes — and once more through a
full DXF round trip — opens in AutoCAD 2027 with **RECOVER and AUDIT at
0 errors, 0 erased** (the untouched source itself audits 18 errors), and
its plot matches AutoCAD's plot of the original section for section.
Eleven writer spellings that our own reader tolerated but AutoCAD did
not — the R2013+ SPLINE scenario form, multi-solid AcDs payloads, hatch
spline fit data, forged ellipse normals, true colours collapsed to ACI,
path-less wipeout IMAGEDEFs, dropped hatch loop-type bits, anonymous
block naming, mesh linetype inheritance, multi-line hatch patterns in
the DXF reader, and stale sealed-object re-emission — were each read off
AutoCAD's own bytes and are pinned by regression tests.

DXF is read and written in both the ASCII and binary forms, at every
group-code width. The ASCII writer's output is gated in the same external
run (`DXF` row): the corpus DXF opens in AutoCAD 2027 at **AUDIT 0
errors**. The campaign that got it there was driven by a 72 MB production
drawing (AC1032, 232,382 model entities) whose 270 MB DXF now opens with a
single AUDIT fix — a one-dash linetype broken in the source, which
AutoCAD's own DXFOUT reproduces identically. DXFIN turned out to be far
stricter than any DWG reader: one missing group — a LAYER without its
plot-style 390, an absent empty VIEW table, a `97` inside a spline hatch
edge, gradient groups in an AC1015 file, an MLINE without its style's
hard 340 — discards the entire file, and each of those rules is now
pinned in `test/dxf-acadopen.test.ts`.

### Known limits

- R1.4 (the pre-AC1003 line) is read-only; everything from R2.6 on has a
  writer.
- ACAD_TABLE, MULTILEADER, LIGHT and the underlays are application
  classes and cannot exist in R13/R14; the writer reports them as
  skipped rather than writing something a reader would not understand.
- An ASM-dialect kernel stream (the solids of R2010+ files) has no
  spelling an AC1015 DXF can carry: AutoCAD's own R2000 DXFOUT downgrades
  the kernel data to the ACIS-400 text dialect — record ids dropped,
  fields reshaped — and that translator does not exist here yet. One
  inline ASM entity makes DXFIN discard the entire file, so `writeDxf`
  keeps such REGION/3DSOLID/BODY entities out and says so in
  `drawing.warnings`. Classic ACIS streams (R13–R2007 sources) travel
  as always.
- Pre-R13 table names are bound to CP1252 by the format itself; entity
  text still travels losslessly through `\U+` escapes.
- Real (non-nasjidwg) proxy payloads are preserved exactly as the source
  release stored them and are not version-translated (only the owning
  application's object enabler could do that). Records nasjidwg itself
  seals travel across generations wrapped and return native (A→B→A).
- Sealed objects re-anchor under the named objects dictionary; a deep
  extension-dictionary parent chain is not reconstructed yet.
- DXF itself can only spell soft (330) and hard (340) references, so DWG
  reference codes normalize to 4/3 after a DXF trip — a limit of DXF,
  not of the DWG round trip.
- Incremental (patch-in-place) save — rewriting a file in place rather
  than rebuilding it — is still not built. `verbatimRecords` gets the
  fidelity it was wanted for (untouched entities survive byte for byte);
  what remains unbuilt is the in-place container patch that would also
  save the rebuild cost on very large files.
- **R2007 write.** AC1021 output opens in AutoCAD 2027 at AUDIT 0 errors
  and is regression-gated like the rest, ACAD_TABLE included. The one
  R2007 limit left is the format's own, not ours: an **ASM-dialect** ACIS
  payload cannot travel inline in an AC1021 file, because that container's
  kernel reads only the pre-ASM "ACIS BinaryFile" form (a genuine
  ACIS-dialect blob written by this library into an AC1021 file opens at
  AUDIT 0; the same file carrying an ASM stream is refused). An ASM
  payload therefore leaves an R2007 target as SAT text, or is reported in
  `skipped`.

  What had blocked it for four campaigns was a wrong suspect. The header
  field at record offset 0x100 that every earlier ledger called the
  blocker — `random_seed` — turns out to carry no information about the
  file at all: five different drawings saved to R2007 from five separate
  AutoCAD launches carry the identical value, along with the identical
  prologue key, check-data word and `crc_seed_encoded`. It is one draw of
  a per-process RNG, and zero is accepted. The real defects were an empty
  CLASSES payload (refused at AC1021 exactly as at AC1032), the inline
  ACIS payload's bit-level start offset, and the cached wireframe block
  that follows it — the last two hidden by a reader that probes for the
  kernel magic instead of trusting the framing. The complete ledger,
  including what `random_seed` is and the measurement that retired
  13 650 digest combinations of searching for it, is in
  `src/dwg/container2007.ts`.


### Provenance

Nothing in `src/` is copied out of a file another program produced.
That rule is enforced by audit, not by assumption, and it has cost real
work. Three violations were found and removed:

- The **AcDs section** that carries an ACIS solid at R2013+ was first
  implemented by patching a 13.5 KB template lifted from an AutoCAD save
  — thumbnail bytes included. The template is gone: the section is now
  emitted field by field from a grammar reverse-engineered and verified
  by a parser that reads AutoCAD's own section back with no unexplained
  bytes. It is 2.4 KB instead of 13.5, carries no image data at all, and
  AutoCAD still audits it at zero errors.
- The **3DSOLID record tail** at R2018 was 355 bits taken bit-verbatim
  from a donor solid, including its revision id. Decoded against 28
  purpose-generated records until every field was named — the id turned
  out to be an ordinary RFC-4122 v4 UUID — it is now 163 bits this
  library computes, with a per-body id derived from the payload itself.
  Only two flags in that record are load-bearing (clearing either is
  refused); every value behind them is ours.
- The **20-byte run** after the R2004+ encrypted header is generated
  from the LCG that produces it (the keystream is indexed by file
  offset) rather than transcribed.

Format constants — the section sentinels, the Reed-Solomon generator
polynomial, Unicode and ACI tables — are structural markers and
standards data, not the content of any particular drawing, and are not
covered by this rule.

Everything nasjidwg covers or intends to cover, capability by capability.
Nothing is silently dropped — if it is not ✅ it is 🚧 (partial) or ⬜ (in
the queue below).

Legend: ✅ done & verified · 🚧 partial · ⬜ not started

Verification rests on four independent mechanisms, none of which ships a
drawing in this repository:

1. **Self round-trip** — the suite generates every fixture with the
   library's own writers and reads it back number-for-number.
2. **Codec cross-check** — the DWG and DXF paths encode the same document
   model independently and must agree with each other.
3. **AutoCAD 2027 as the external oracle** — `tools/validate-external.mjs`
   opens and AUDITs our output in the Core Console; all seven writable
   release families are regression-gated on it, every one at zero AUDIT
   errors.
4. **A 317-file real-world corpus** (139 MB, 1982→2027: AutoCAD's sample
   libraries, field drawings from real producers, vintage files) read as
   an external oracle during development — no test depends on them.

Earlier revisions of this file described a checked-in fixture corpus and
an `oracle.test.ts`; both are gone. Nothing is shipped, nothing is
downloaded, and `npm test` reproduces every fixture it asserts on.

## Containers (file structure)

| Capability | Status | Verified by |
|---|---|---|
| Version detect MC0.0/AC1.2..AC1032 (every published signature) | ✅ | unit tests |
| R13/R14 read | ✅ | genuine AC1012/AC1014 drawings decode with zero failed objects, reconciled entity-for-entity against AutoCAD's own DXF export of the same file |
| R2000 locator container | ✅ | real files + generated fixtures, zero failed objects |
| R2004/2010/2013/2018 page container + LZ77 | ✅ | every AutoCAD sample-library drawing of these releases reads clean; counts match the DXF oracle |
| R2007 RS container + its LZ77 | ✅ | 118 genuine AC1021 drawings read clean, counts match the DXF oracle |
| Object map paging | ✅ | multi-page maps in real 3 MB field drawings |
| CLASSES section, all layouts (R2000 / R2004 / R2007+ hsize+bitsize) | ✅ | class entities resolve in all 8 container versions (regression-tested) |
| Header variables section parse (R13-R2018, all 3 stream layouts) | ✅ | EXTMIN/LIMITS/INSUNITS/CLAYER agree across all 8 container versions + reference DXF. The dimensioning sizes (DIMSCALE/DIMASZ/DIMTXT/DIMEXO/DIMEXE/DIMGAP/DIMDEC…) and the point glyph (PDMODE/PDSIZE) are kept, not just stepped over — cross-checked against the reference DXF export of the same drawing, over the whole corpus; a consumer without PDMODE draws point dots the file does not show |
| Header date fields + drawing GUIDs | ✅ | TDCREATE/TDUPDATE/TDINDWG/TDUSRTIMER keep BOTH halves (`TDCREATE` is the Julian day, `TDCREATE_MS` the milliseconds into it — the day alone floors to midnight), and FINGERPRINTGUID/VERSIONGUID are captured rather than stepped over |
| Header dimensioning variables (DIMSCALE, DIMASZ, DIMTXT, DIMEXO/EXE, DIMGAP, …) | ✅ | captured into `header.vars`, values verified against an independent decoder across the corpus; consumed by `explodeDimension`. R13/R14 store DIMDEC in an unconfirmed slot — deliberately not captured rather than guessed |
| SummaryInfo + Preview (thumbnail) | ✅ | summary decodes from the section (R2004+) and from DWGPROPS before that; preview extracted as usable BMP/PNG on all 8 versions |
| CRC verification (opt-in) | ✅ | readDwg(bytes, { checkCrc: true }); detects single-byte corruption |
| Pre-R13 read (R1.1–R12) | ✅ | R1.4, R2.6, R2.10, R9, R10 and R11/R12 fixtures all decode; entity-for-entity and number-for-number against the reference exports |
| Pre-R13 record chaining (JUMP across entity/block/extra runs) | ✅ | the R9/R10 fixtures park a polyline in the extras run and jump back for its vertices |
| Pre-R13 drawing variables + fixed-record tables | ✅ | extents/limits/LTSCALE/CLAYER agree with the reference; LAYER, STYLE, LTYPE, BLOCK, VIEW, UCS, VPORT, APPID, DIMSTYLE |

## DWG entities (read)

| Entity | Status | Notes |
|---|---|---|
| LINE, POINT, CIRCLE, ARC, ELLIPSE | ✅ | oracle-verified geometry |
| TEXT, ATTRIB/ATTDEF (as text), MTEXT | ✅ | R13/14 explicit form + R2000+ dataflags form. ATTRIB/ATTDEF carry their marker (`attribute`) and their 70-flags — bit 1 sets `invisible`, bit 2 `constant` — verified against a field drawing whose 150-unit invisible ATTDEFs used to paint as plain visible text. Justification (`halign` / `valign` / `alignmentPoint`) survives a rewrite, and `preserveHandles` keeps the attrib's own handle rather than minting a fresh one. Each of the four resolves the STYLE record it points at, so `style` names the font, width factor and slant the file asked for: the pointer used to be read and dropped, and a 72 MB drawing whose 59 styles mix TTF and SHX handed back all 1,652 of its text objects with no style at all |
| LWPOLYLINE (bulges, widths, ids) | ✅ | the R2010+ vertex identifiers (DXF 91) are read into `PolylineVertex.id` and written back (flag 0x400), plinegen (`plineGen`) too; the reference's DXF of a rewrite shows the same 91 values |
| POLYLINE_2D/3D + vertex folding | ✅ | chain (≤R2000) and owned (R2004+) forms. A heavy polyline stays one: `heavy: '2d' \| '3d'`, a 3D polyline's vertices keep their `z`, a spline-fit one keeps its frame (VERTEX 70 = 16) apart from the fitted curve it draws (`fit`, `frame`), a curve-fit one marks the inserted vertices (`curveFit`, `tangent`); the header's own colour/weight/EED land on the entity. Written back as POLYLINE + VERTEX + SEQEND in DWG and DXF — the reference's census of the sheet-set samples (33 + 22 + 1 heavy polylines) matches and the rewrites audit clean |
| POLYLINE_MESH / POLYLINE_PFACE + faces | ✅ | mesh entity; 1–2 index faces kept |
| INSERT / MINSERT + attribs | ✅ | |
| SPLINE (both scenarios) | ✅ | fit-point + control-point forms |
| SOLID/TRACE, RAY/XLINE, 3DFACE, SHAPE | ✅ | |
| DIMENSION ×7 + ARC_DIMENSION | ✅ | all kinds, full point sets, oracle-verified |
| HATCH | ✅ | exact edge paths, polyline paths w/ bulges, deflines, seeds, gradient (R2004+). Associativity and the generating-entity handles (DXF 330) survive a rewrite when those handles remap; the writer rebuilds the reactor on each boundary — AutoCAD 2027 AUDIT reports "Boundary Missing a Reactor — Remove Associativity" without it. Associative-with-no-boundary is never written |
| MLINE, TOLERANCE, LEADER (full), VIEWPORT | ✅ | |
| IMAGE / WIPEOUT (+IMAGEDEF path) | ✅ | clip (an open ring — the DXF reader drops the closing duplicate so both codecs agree), the R2010+ inverted-clip bit, brightness/contrast/fade |
| REGION / 3DSOLID / BODY (ACIS) | ✅ SAT (v1) inline, SAB (v2) inline, and R2013+ payloads from the AcDs section — all 6 containers verified; `acisWires` turns the payload into the wireframe curves AutoCAD draws it with |
| LIGHT | ✅ | name, type, position/target, intensity, colour |
| MULTILEADER | ✅ | leader lines, dogleg, landing, text or block content |
| ACAD_TABLE (all containers) | ✅ | full grid, widths/heights, placement and cell text; the R2010+ linked-table structure decodes to the same table as the pre-2010 record, verified across four containers of one drawing |
| OLE2FRAME / OLEFRAME | ✅ | frame corners, link/embed/static type, tile mode, aspect lock, and the embedded document kept byte for byte |
| MESH (subdivision surface) | ✅ | control mesh, face list, creases; agrees with the reference export vertex-for-vertex |
| PLANE/EXTRUDED/LOFTED/REVOLVED/SWEPT/NURB SURFACE | ✅ | retained as ACIS with their kernel payload and surface flavour |
| POINTCLOUD / POINTCLOUDEX | 🚧 | placement, extents, scan file name and point count decode; written from the format description because no drawing in the corpus carries a scan, so it is not fixture-verified |
| Proxy graphics decode | ✅ | the cached display list becomes real entities (circles, arcs, polylines, meshes, text, rays), so entities we cannot model still draw |

Unknown ≠ lost: common data (layer, color, linetype, handle) is decoded and
the entity is retained with its source type name — verified per version.

## DWG objects (read)

| Object | Status |
|---|---|
| LAYER / LTYPE / STYLE (full) | ✅ |
| BLOCK_HEADER / BLOCK_CONTROL | ✅ | anonymous blocks (*D, *U, …) are stored under one bare stem name each — numbered off their unique handles at read time so every definition survives and each dimension keeps its own |
| IMAGEDEF (file path, resolved onto images) | ✅ |
| DICTIONARY / LAYOUT / GROUP / MLINESTYLE | ✅ layouts (name, tab order, block, limits, extents), groups (members), mline styles (elements) |
| APPID / DIMSTYLE / VPORT / VIEW / UCS | ✅ names + geometry; APPID resolves xdata owners, DIMSTYLE resolves dimension.style |
| Saved view: VIEWTWIST + the viewport UCS | ✅ the whole VPORT record — twist, target/direction, lens, clipping, view mode, circle sides, UCSICON, snap and grid, and the R2000+ per-viewport UCS — read, written and carried through DXF. Graded field for field against AutoCAD's own DXFOUT: **36 of 36 on nine drawings** across R14/R2000/R2007/R2018, including three saved with UCSICON 3, 1 and 0 and one with DVIEW front clipping. A drawing laid out at an angle draws square only if VIEWTWIST survives, and `viewTwistTransform` hands a consumer the 2D transform that squares it |
| Header UCS (UCSORG / UCSXDIR / UCSYDIR) | ✅ captured into `header.ucs` (and `header.pUcs`), written back by every DWG writer and by the DXF writer as $UCSORG/$UCSXDIR/$UCSYDIR; `ucsTransform` turns it into a basis. Before R2000 this is the only place a rotated layout is recorded |
| XRECORD retention (typed values, dictionary names) | ✅ DWG + DXF both ways |
| SORTENTSTABLE (draw order) | ✅ applied, not just parsed: each table reorders its space's entity array in place by ascending sort key (an entity no entry names sorts under its own handle), so the array a consumer draws IS the draw order — DWG and DXF readers agree. Verified pair-for-pair against AutoCAD's own DXF of a 193,382-entry model-space table (518 tables in that drawing; the 507 empty ones skip). The DXF spelling hides a trap: the object's own handle is a group 5 that sits BEFORE the AcDbSortentsTable marker, and only the 331/5 pairs after it are entries |
| Dynamic-block visibility (states + members) | ✅ | blocks flagged dynamic; every state named in definition order with the entities it shows — 48 states verified |
| Dynamic-block parameters + actions | ✅ linear/rotation/flip/alignment/base-point parameters with names, labels, descriptions, points and value sets ("Door Size" [24,28,32,36,40] decodes from the fixture), plus the action kinds (move/stretch/scale/flip/rotate/…) |
| Remaining dynamic-block records (lookup tables, constraint parameters, grips) | 🚧 retained as objects; they carry no geometry of their own |
| PDF/DGN/DWF underlays + definitions | ✅ read and write, DWG and DXF both; verified against a reference DWG/DXF pair |
| EED/XDATA retention (entities, app-resolved) | ✅ | read and written (R13–R2018). The writer encodes the DXF 1000-range, mints an APPID record for every named application, and remaps 1005/1003 through the file's own handles. A 72 MB field drawing's insert/line/dimension XDATA — including two ACAD DSTYLE overrides — used to vanish with no warning |
| GEODATA (geographic placement) | ✅ DWG (all three version forms) + DXF read, DXF write, GeoRSS lat/long parsed — DWG and DXF readers agree field-for-field on the reference pair |

## DWG write

| Capability | Status |
|---|---|
| R2000 container + objects | ✅ full file structure (locators+CRCs, header vars, object map, 2nd header, aux/objfree/template/preview) |
| R2004 (AC1018) page container | ✅ page/section maps, LZ77 system pages, encrypted file header |
| R2018 (AC1032) container | ✅ same page container + R2010+ object framing (BOT type, handle-size prefix) and R2007+ string streams |
| Header variables write | ✅ every container generation. R2007+ splits the section into data/handle/string streams exactly as it splits objects (bitsize field, UTF-16 tail) and adds its own fields (CMATERIAL, DIMFXL/DIMARCSYM/DIMFXLON, R2010 DIMTXTDIRECTION, R2013 REQUIREDVERSIONS); written R2000-style the section did not parse at all and every variable in an R2007/2018 file was lost |
| R2007 (AC1021) write | ✅ the Reed-Solomon page container, its LZ77 dialect, all three header checksums, the R2007 object framing and the inline ACAD_TABLE grid; **externally gated at AUDIT 0 errors** in AutoCAD 2027 with the full corpus. One limit, reported in `skipped`: an ASM-dialect ACIS payload, which AC1021's kernel cannot read inline — a genuine ACIS-dialect blob written by this library opens clean |
| Page compression (R2004/R2007/R2010+) | ✅ real greedy hash-chain LZ77 matchers for both dialects, self-verified: every compressed page decodes byte-for-byte through the library's own oracle-tested decompressors, plus a structured fuzz sweep. The corpus containers shrank 37-43% (R2004 6624→3776, R2007 9600→6016, R2018 7712→4384 bytes) |
| Pre-R13 write (R12 / AC1009) | ✅ `writeDwgR12`: fixed 205-variable header block, split table directory (five entries up front, five embedded at fixed offsets), per-record CRCs, all 14 section sentinels, second header — every pre-R13 fixture (R1.4→R12) survives a rewrite number-for-number |
| Pre-R12 write (R10 / R9 / R2.6 / R2.10) | ✅ `writeDwgR10/R9/R2_6/R2_10`: per-release header-variable blocks (761/741/506-byte layouts), leading-run table directory, one-byte linetype refs, 2D bodies with shared elevation before R10 (3DLINE/3DFACE as the exact-3D escape hatches), per-record CRCs — each verified by round trip through the pre-R13 reader, number-for-number. What a release cannot hold is downgraded to visible geometry or reported, never dropped silently |
| R13/R14 header variables | ✅ written in the AC1012/AC1014 field order (own dimension-flag block, inline DIMPOST…DIMBLK2 texts, no R2000+ blocks), mirrored field-for-field from the reader — extents, limits, LTSCALE and the dimensioning sizes round-trip through both releases |
| Proxy passthrough (entities + objects) | ✅ ACAD_PROXY_ENTITY (0x1F2) and ACAD_PROXY_OBJECT (0x1F3) survive a round trip in every container R13→R2018: application payload bit-for-bit (the stream is not byte-aligned), cached display list byte-for-byte (and still decoded to drawable primitives), handle references code-for-code, and the original application class re-emitted in CLASSES with its app name. Dictionary-owned proxy objects keep their NOD entry names |
| Universal sealed passthrough | ✅ every record the semantic layer cannot model — an unknown application class, a dictionary object with no decoder, or a KNOWN type whose decode fails — rewinds and is retained SEALED: payload bit-exact, R2007+ string stream verbatim, handle references code-for-code, cached display list byte-for-byte. Re-emitted natively when the target shares the payload's encoding generation (14 / 2000 / 2004 / 2007 / 2018). Ignorance downgrades the view, never the file |
| Cross-generation transport (A→B→A) | ✅ sealed bits from generation A travel through a foreign generation B wrapped in a proxy record — the format's own idiom for data the host release cannot hold — tagged with their generation, and unwrap back to the native record on returning to A. Verified including a 2018→R13→2004→2018 odyssey with a non-byte-aligned payload and a string stream |
| Handle-stable rewrite (`preserveHandles`) | ✅ every writer accepts `{ preserveHandles: true }`: entities and retained objects keep their source numbering, fresh structural handles are allocated above it, and the object map is emitted sorted. Sealed records reference each other by handle, so with the numbering stable those references stay valid across any number of rewrites without the library understanding them |
| Self-validation (`auditDrawing` + `nasjidwg audit`) | ✅ the library's own AUDIT pass: duplicate handles, dangling layer/linetype/block/style references, missing group members, non-finite geometry, header-extents mismatch — errors first, never throws; the CLI exits nonzero on errors |
| Sealed data through DXF | ✅ proxies leave as real ACAD_PROXY_ENTITY / ACAD_PROXY_OBJECT records (92/310 graphics, 93/310 data with the bit count, 330/340 refs, class in CLASSES) and parse back — so the payload survives any path through the library, DWG↔DXF included, in ASCII and binary DXF both |
| DXF tag storage | ✅ an unknown DXF entity or object retains its complete raw tag list verbatim and re-emits it (only its own handle and pre-subclass owner are re-pointed; 102-fenced reactors survive untouched) — parity with ezdxf's one former advantage |
| Byte-preserving rewrite (`retainRecords` + `verbatimRecords`) | ✅ read with `readDwg(bytes, { retainRecords: true })`, write with `{ preserveHandles: true, verbatimRecords: true }`, and every entity still carrying the record the reader sealed is emitted from those exact bytes instead of being re-encoded — incremental-save fidelity without an incremental container. Symbol tables keep their source handles so those bytes stay meaningful; the object map, size prefixes, R2010+ handle-stream split, CRCs and container are built as always. Verified byte-identical over three generations at R13/R14/R2000/R2004/R2018, each opening in AutoCAD with AUDIT 0 errors. Off by default, a no-op without `preserveHandles`, and refused for foreign encoding generations, mismatched record types, XDATA carriers and the entity kinds whose records reach into objects this library mints fresh (dimension, mline, image, insert-with-attributes, ACIS, the class-numbered records). **The contract: a caller that changes an entity must `delete entity.record`** — the writer trusts the seal rather than diffing it |
| Mutation fuzz | ✅ 840 seeded byte mutations + truncations across all 7 written containers, every run: the reader either decodes with a warnings array or throws an ordinary Error — never hangs, never leaks a non-Error |
| SHX shape fonts | ✅ full bytecode interpreter (16-direction vectors, octant / fractional / bulge arcs, subshapes, push/pop, scale, vertical-skip; unifont structurally), font registry, and the SVG/PDF exporters draw text as the font's real vector strokes when a font is registered — byte-identical output when none is |
| External validation vs AutoCAD | ✅ `node tools/validate-external.mjs` drives AutoCAD 2027's Core Console (open + AUDIT per container) with a regression-gated PASS_BASELINE of **all seven writable release families — R12, R13, R14, R2000, R2004, R2007 and R2018 — every one opening AUDIT-CLEAN 0/0 on the full corpus**: every entity family, the hand-built ASM solid (carried in the AcDs section, as 2013+ requires), the Bill-of-Materials table with merged cells (AutoCAD's own DXFOUT returns every cell string), MULTILEADER with its synthesized Standard MLEADERSTYLE, and Arabic layer names normalized clean. Nine campaign rounds burned ~70 splice-proven format rules into the writers and structural tests — among them: the R2004 LZ terminator is `0x11 0x00 0x00`; CLASSES bind positionally, number densely from 500, and may not be empty from R2007 on; R2010+ LEADER keeps endptproj and drops box h/w; R13/14 BT/BE are full BD/3BD; the R2010+ TABLE folds TABLECONTENT into the entity and closes with a five-field break range; R2018 MTEXT carries an annotative/column tail; R2007+ symbol names travel raw UTF-16; AC1032 stores ACIS as ASM blobs in AcDs while AC1021 reads only the pre-ASM form, inline, starting on the bit after its version field and followed by a cached wireframe block. Several were symmetric reader+writer beliefs no self-round-trip could catch — exactly what the external loop exists for. One ledger is still open and honourably so: every ledger closed |
| Reader certified against real AutoCAD files | ✅ **317 real drawings, 139 MB, spanning 1982 to 2027** — every AutoCAD 2027 sample library, field drawings up to 3 MB from real producers, vintage R1.4/R2.6/R2.10/R9/R10/R12/R13/R14 files, and 49 purpose-minted references — all read with **zero throws, zero timeouts, zero CRC mismatches** in 13.2 s with CRC verification enabled, and the decoded geometry matches AutoCAD's own DXFOUT field for field. The whole corpus produces four warning occurrences in total. Twelve reader defects the generated corpus could never expose were found and pinned, among them: the R2007 table cell grammar and the R2010+ inline grid (real tables had been decoding as empty stubs); MLINESTYLE's per-element linetype (a data-stream index through R2013, a handle only from R2018 — this alone had been sealing the record on 155 of 280 files, and the same error lived in the R2007 writer); the MTEXT background-scale field (BD, not BL — 89 MTEXTs were being sealed with their text already parsed); XRECORD trusting a declared size that overran the record; a header-extents guard that let a Z of 7.35e+223 through; the DICTIONARY hard-owner byte that starts at R13c3 (61 of 71 dictionaries in a genuine R13 file were failing silently); GROUP naming; anonymous-block numbering; the 2004+ CMC ByLayer/ByBlock methods; and entities whose owner resolves to nothing, which now land in model space with a warning instead of vanishing. **No test reads any of these files** — they are external oracles only; the suite still generates every fixture it asserts on |
| OLE2FRAME write | ✅ R14→R2018: frame + embedded compound document byte-for-byte; a hand-built entity gets its 0x62-byte frame header synthesized from the corners. R13 (which predates OLE2FRAME) reports the skip |
| Dynamic-block visibility write | ✅ R2000→R2018: blocks with visibility states leave as a real BLOCKVISIBILITYPARAMETER — name, prompt, member list and per-state entity lists remapped onto the written file's handles — and come back as the same dynamic block through the reader |
| Draw order (SORTENTSTABLE) write | ✅ a default write needs no table — fresh handles ascend in array order, and array order IS the draw order. Under `preserveHandles`, every space whose array order differs from its ascending handle order gets a native SORTENTSTABLE under an ACAD_SORTENTS entry in the block record's extension dictionary, its sort keys reusing the space's own handles (the i-th array entity sorts under the i-th smallest handle — no fresh numbers, no collisions). Verified on a 72 MB field drawing: 232,382 model entities keep their exact draw order through a preserved rewrite. R13/R14 cannot name the class and report the skip |
| R2007+ string-stream sizes past 0x8000 bits | ✅ the two-word spelling the readers always accepted (high word first, low word carrying the 0x8000 continuation flag) is now written too. The old single-word write silently truncated the size: a drawing registering a few hundred application classes — the 72 MB field file carries 245 — wrote a CLASSES section that read back as ZERO classes, and every class-typed record in the file went sealed or missing with it |

## DWG write — entity coverage

Every natively-modeled entity is encodable: line, point, circle, arc,
ellipse, lwpolyline, text (+Arabic shaping), mtext, insert/minsert with
attribs + SEQEND, spline (both scenarios), solid, ray/xline, 3dface,
shape, tolerance, leader, viewport, mline, polygon/polyface meshes with
their vertex chains, images (+CLASSES and IMAGEDEF objects), hatch
(exact edges, deflines, seeds, gradient, associativity with remapped
boundary handles), all 8 dimension kinds, LIGHT,
MULTILEADER (its own AcDbMLeader record in every container), ACAD_TABLE
(its own record everywhere — through R2007 as the inline grid, from
R2010 as the placed entity plus its paired TABLECONTENT object),
PDF/DGN/DWF underlays with their shared definition objects, and ACIS
solids — SAT in every container, SAB from R2007 on in the kernel dialect
that container reads, and a binary payload leaves a target that cannot
hold it through the SAB→SAT conversion.

Nothing is downgraded in the R13+ writers any more; the `downgraded`
list exists for targets that genuinely lack a record (the R12 writer).
Anything a writer cannot emit at all lands in `skipped`; nothing is
dropped silently. On the R2000/R2004/R2018 fixtures both lists come
back empty.

The R12 writer speaks the byte-aligned pre-R13 record set natively: line,
point, circle, arc, text (+attribs), solid, 3dface, shape, 2D polylines
with bulges/widths, polygon and polyface meshes with their vertex chains,
insert (+ATTRIB/SEQEND), all 7 R12 dimension kinds, viewport. Entity text
travels as `\U+` escapes (Arabic included, losslessly); table names are
bound to CP1252, which is what the format itself can hold. What R12 has
no record for is downgraded to visible geometry (ellipse/spline →
polyline, mtext → text lines, hatch → pattern lines, table → grid +
text, leader/mleader/mline → polylines, tolerance → text) and the rest
(ray/xline, images, ACIS, paper space) is reported in `skipped`.

## DXF

| Capability | Status |
|---|---|
| ASCII write (R2000) full entity set | ✅ dimensions-by-kind, exact hatch edges + gradient, mline, mesh, image w/ CLASSES + OBJECTS sections, Arabic pipeline, saved view |
| ASCII tolerant read | ✅ never throws; every model type incl. ATTDEF, ARC_DIMENSION, mesh flavors, IMAGEDEF paths; SORTENTSTABLE draw order applied the same way the DWG reader applies it |
| Binary DXF read | ✅ verified against a real-world binary DXF byte stream |
| Binary DXF write | ✅ round-trip tested |
| OBJECTS section write (root dict, layouts, groups, mline styles, image defs) | ✅ |
| Pre-R13 binary DXF (1-byte codes, 255 escape) | ✅ read (auto-detected) + write via `writeDxfBinary(d, { narrowCodes: true })` |

## Text / i18n

| Capability | Status |
|---|---|
| Arabic shaping to Presentation Forms-B + lam-alef | ✅ |
| Unshaping + signature detection, bracket mirroring | ✅ |
| \U+XXXX escapes, %%-codes, CP1252 | ✅ |
| 29 single-byte codepages (1250–1258, 874, ISO-8859-2..9, DOS 437/850/852/855/857/860/861/863/864/865/866/869, Mac) | ✅ generated from Unicode.org tables |
| Correct DWG codepage-number map (29=1251, 35=1256, …) | ✅ |
| CJK double-byte pages (932/936/949/950, BIG5, GB2312, JOHAB) | ✅ generated tables, lazily unpacked; EUC and 8-bit code forms both resolve |
| MTEXT full inline-code parser (fonts/colors/stacking) | ✅ parseMtext() |
| \M+ MIF escapes | ✅ decode + encode |

## Beyond file IO

| Capability | Status |
|---|---|
| Bounding boxes (entity + drawing, insert-aware) | ✅ |
| 2D transforms + deep clone | ✅ a transform that is not a similarity turns a circle, arc or ellipse into the ellipse it really becomes (conjugate semi-diameters → axes + parameter shift), so explode and both exporters place a squashed round curve where AutoCAD draws it |
| Explode: insert (recursive), polyline→arcs | ✅ |
| Explode: hatch pattern lines | ✅ clipped to boundaries, with dashes |
| Dimension geometry generation | ✅ `explodeDimension`: extension/dimension lines, arrowheads, measurement text (with `<>`/override rules and DIMSCALE/DIMTXT/DIMEXO/DIMEXE) for linear, aligned, radius, diameter, both angulars and ordinate — SVG/PDF fall back to it, and the R12 writer materializes it as a real *D block |
| SVG export (all entity families, Arabic RTL) | ✅ |
| GeoJSON export (all geometric types) | ✅ georeferenced to WGS84 lon/lat through the GEODATA anchor when the drawing carries one |
| JSON lossless round-trip | ✅ |
| ACIS/ASM wireframe extraction | ✅ `acisWires(entity)` — a solid's kernel stream turned into the polylines a CAD program draws it with. Measured against AutoCAD's own XEDGES below |
| Thumbnail extraction (BMP/PNG) | ✅ |
| .pat hatch pattern files | ✅ read + write, verified on a real library |
| CLI tools (info, convert, layers, grep, thumb) | ✅ convert targets .dwg .dxf .dxb .svg .pdf .json .geojson; `convert --verify` re-reads the written file and reports the round trip; `layers` lists names, colors, linetypes and state flags |
| PDF export | ✅ standalone single-page PDF 1.4, real vector paths, no dependencies: every entity family incl. nested inserts, hatch fills, arcs as exact cubics, tables and mesh faces; text it cannot draw with a standard font is reported, never dropped. Plot control: explicit sheet (`width`/`height`), fixed `scale`, `offset`, window `clip` and `monochrome`. Both exporters frame `contentBounds`, so a georeferenced drawing is not printed as a speck |


### Solid wireframes: what the extractor does, and what it does not

A 3DSOLID stores surfaces, not lines. What a CAD program draws for it in
wireframe is its EDGES — the curves where two faces meet — and that is what
`acisWires(entity)` returns: `Point3[][]` in model coordinates, computed on
first use and remembered against the entity, so opening a drawing costs
nothing until something asks to see the solids.

```ts
import { readDwg, acisWires } from 'nasjidwg';
const drawing = readDwg(bytes);
for (const e of drawing.entities) {
  for (const polyline of acisWires(e)) draw(polyline);  // [] for anything else
}
```

`parseSab` / `parseSat` expose the layer beneath: the whole stream as a flat
record graph (`AcisRecords`), fields in parallel typed arrays because a
drawing's solids can carry a quarter of a million records between them.
`acisWiresFromPayload(bytes | text)` skips the entity wrapper.

**Reads.** Both dialects — modern ASM/ACIS binary (SAB) and the classic
SAT text — from the same grammar. Topology: body → lump → shell → face →
loop → coedge → edge, with the tolerant variants (`tedge`, `tcoedge`,
`tvertex`) and the body `transform`. Pointers resolve by what they point AT
rather than by slot number, so the field-layout drift between kernel
versions does not move the geometry. A stream still sealed inside a DWG
record is found at whatever BIT offset the record's own fields left it.

**Evaluates.** `straight` (the direction is used exactly as stored — ACIS
does not keep it unit, and the edge's parameters are measured against the
length it has), `ellipse` (circles, arcs and true ellipses), and `intcurve`
in its `exact_int_cur`, `int_int_cur` and `par_int_cur` forms through their
approximating B-spline — de Boor, rational or not, with ACIS's own knot
convention where the end multiplicities are written one short of clamped.
An intcurve read against its spline (negated parameters) and a periodic one
whose parameters wrap past the knot end are both handled, detected from the
numbers rather than from a flag the two dialects spell differently.

**Approximates.** Curves are tessellated to a chord tolerance keyed to the
body's own size (and never more than 45° of arc a segment), so a handrail
fillet and a ramp deck get the same smoothness rather than the same segment
count. Edge ends are snapped to the kernel's own vertex points, so
neighbouring edges close on a shared point.

**Drops.** Zero-length edges. An `intcurve` whose definition is a `{ ref N }`
reference to another subtype object in the stream is drawn as the chord
between its (exact) vertices — the ordinal space those references address is
not yet resolved; it is 134 of 30,351 edges, 0.44%, in the corpus below.
Faces, surfaces and shading are not produced at all: this is a wireframe,
which is what a 2D CAD viewer draws.

**Measured against AutoCAD.** A 19.5 MB R2007 architectural drawing (1,660
3DSOLID/REGION/SURFACE entities in model space, ASM 225.1) put through
AutoCAD 2027's own **XEDGES** command, its output written to DXF at 16
decimals and compared entity for entity:

| | AutoCAD XEDGES | nasjidwg | |
|---|---|---|---|
| straight edges | 23,650 LINE | 23,650 | every one matched endpoint-for-endpoint within 1e-4 units; **zero unmatched on either side** |
| circles/arcs/ellipses | 4,574 ARC + 1,160 CIRCLE + 769 ELLIPSE = 6,503 | 6,503 | |
| spline edges | 1,596 SPLINE | 1,600 | |
| **total edges** | **31,749** | **31,753** | +0.013% |
| curved-edge endpoints | 13,860 | 13,416 matched, **none unmatched** | mean error 1.7e-6, max 5.1e-4 on coordinates of ~7×10⁵ — the kernel's own approximation tolerance |
| closed rings | 1,169 | all 1,169 matched | max centre error 5.7e-4 |

Extraction of all 1,916 bodies takes **~700 ms** — measurable beside the
1.9 s the file's own read costs, which is why it is lazy and memoized rather
than a field populated at read time.

**One record type stays sealed.** That drawing's 256 `SURFACE` (AcDbSurface)
records are not modelled as `acis` entities, because the writers have no
SURFACE class record to emit them through and turning them into a modelled
entity would lose them on write, where today they pass through byte-exact.
They *do* carry ASM payloads — at bit offset 4 inside the retained record —
and `acisWires` reads them straight out of the sealed bits, so nothing is
undrawable for the sake of the seal.


## Capability summary

The axes a DWG/DXF library is judged on, and where this one stands:

| Axis | Status |
|---|---|
| DWG read R13–R2018 | ✅ all 8 container versions |
| DWG read pre-R13 (R1.x–R12) | ✅ nine fixtures from 1983 onward |
| DWG write R2000 / R2004 | ✅ compressed pages |
| DWG write R2007 | ✅ externally gated at AUDIT 0, ACAD_TABLE included; an ASM-dialect ACIS payload leaves as SAT or is reported |
| DWG write R2010 / R2013 / R2018 | ✅ compressed pages |
| DWG write R12 (AC1009) | ✅ |
| DWG write R10 / R9 / R2.6 / R2.10 | ✅ round-trip verified per release |
| Proxy passthrough (0x1F2 + 0x1F3) | ✅ payload bit-exact, graphics byte-exact, refs code-exact, class re-emitted — every container R13→R2018 |
| OLE2FRAME | ✅ read + write (R14+), document byte-for-byte |
| Dynamic-block visibility | ✅ read + write (R2000+) |
| ACAD_TABLE | ✅ read and written in every container. AC1021 keeps a cell's content as a full table VALUE — the additional-data flag, the format flags, the data type, the text inline as byte-counted UTF-16, the unit type, then the value's format string and rendered form in the record's string stream — which is why a bare string there was refused; pinned against AutoCAD-minted AC1021 tables and verified by AutoCAD reading our output back cell for cell (R2010+ writes through the paired TABLECONTENT object) |
| MULTILEADER | ✅ read + write, its own record |
| ACIS solids | ✅ SAT write everywhere, SAB from R2007 in the dialect that container's kernel reads (pre-ASM inline at AC1021, ASM through AcDs at AC1032), and SAB→SAT conversion so a binary payload reaches a target that cannot hold it |
| GEODATA + georeferenced GeoJSON | ✅ DWG and DXF read, DXF write, WGS84 output |
| Dimension geometry generation | ✅ `explodeDimension` |
| LIGHT, point clouds, OLE frames | ✅ modeled (LIGHT and OLE2FRAME also written) |
| PDF export | ✅ standalone vector, no dependencies |
| Arabic/RTL pipeline | ✅ shaping, escapes, codepages |
| Codepages | ✅ 29 single-byte + 5 CJK + MIF escapes |
| Underlays (PDF/DGN/DWF) | ✅ all three kinds, read and write, DWG and DXF |
| Dynamic-block parameters + actions | ✅ visibility states and nine parameter kinds with their labels and value sets |
| OCS / arbitrary-axis handling | ✅ extrusion retained, round-tripped, and resolved in bounds and every export (`toWcs`). The writer used to forge +Z on every OCS entity but ELLIPSE — 698 arcs, 20 circles, 23 inserts and 50 polylines in a 72 MB field drawing landed displaced. A negated normal is a reflection: a reference comes out mirrored (negative X scale, rotation reversed), not turned by pi. ELLIPSE is the format's exception — its centre and major axis are spelled in WCS, so a negated normal turns its sweep and moves nothing |
| Degenerate curvature (arc-fit leftovers) | ✅ a bulge under 1e-8, an ARC whose two angles are bit-identical, and a hatch edge that wraps all but a hair of a turn the wrong way round collapse to what AutoCAD draws — the chord, nothing, and the hair — in bounds, in boundaries and in every export; an arc is boxed by the run it draws, not by the circle it was cut from |
| Rotated layouts (VIEWTWIST + header UCS) | ✅ read, written, DXF both ways, and `viewTwistTransform` / `ucsTransform` for consumers |
| Adversarial-file corpus | ✅ 18 regression cases covering the structural quirks real-world producers emit |
| Validate-by-round-trip tooling | ✅ `convert --verify` |

## Performance

`npm run bench` times the built library over the synthetic 2000-entity
drawing (the real fixtures are regenerated by the test suite, not kept
in the tree). Development machine, Node 22, one core:

| Operation | Time |
|---|---|
| readDwg R2000 / R2018 (synthetic 2000 entities) | 3.3 / 3.4 ms |
| readDxf R2000 | 6.6 ms |
| writeDwg2000 / 2018 / R12 | 9.4 / 13.2 / 8.6 ms |
| writeDxf / writeSvg | 2.5 / 4.5 ms |

The scale test is a real 72 MB R2018 site drawing: 1.7M object records,
246k model entities, 6,484 block definitions. 0.13.1 reads it in about
**3.4 s**, down from 4.9 s, by removing allocation rather than
reordering work — handle references resolve without materialising a
{code,value} pair, colours are shared frozen singletons, the handle
table is a dense array instead of a Map (its `set` was the hottest line
of the whole read), the object map parses into parallel typed arrays,
unaligned bit-packed doubles merge three 32-bit words through a reused
scratch instead of eight byte reads, and R2004 pages decompress with
block copies. Output verified byte-for-byte identical against 0.13.0 on
three field drawings including the 72 MB one.

(An earlier note here said a block-copy path for the LZ77 literal runs
had been tried and removed as a loss. That was measured on a 1.2 MB
file, where the runs are short; on the 72 MB file the same idea — one
set() per literal run, copyWithin for non-overlapping back-references,
byte-at-a-time kept for the overlapping runs that need it — is a clear
win and is what ships now.)

## Work queue (what is genuinely left)

1. Validation of written files in an external CAD application. The
   current guarantee is a full round trip through our own oracle-verified
   reader across all containers plus AC1009; the external check is
   `ODAFileConverter <in-dir> <out-dir> ACAD2018 DXF 0 1` — the trailing
   `1` runs an audit over every file it loads (R12 output can be checked
   the same way with `ACAD12`).
2. Constraint parameters and grip records, and the vertical-application
   classes (AEC, Civil, Mechanical): recognized and retained, not
   modeled. They carry no geometry of their own, and both reference
   libraries leave the same tier partial.
