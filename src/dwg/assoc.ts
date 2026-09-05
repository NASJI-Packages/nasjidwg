/* nasjidwg — the associative framework across the R2013 respelling.
 *
 * The AcDbAssoc* records (a constraint network, its variables, the
 * geometry dependencies and the 2D constraint groups that hold the
 * constraint solver's nodes) are the reference's own classes, and they
 * changed spelling at R2013 without a change of drawing generation: an
 * R2010 file and an R2013 file share the encoding group, but the bits of
 * these four kinds differ. The reference's own re-saves of its samples,
 * bit-walked record by record (an R2018 original against its 2007, 2010,
 * 2013 and 2018 saves; three R2010 originals against theirs), say what
 * changed and that nothing else did:
 *
 * - AcDbAssocAction (the base of ACDBASSOCNETWORK, ACDBASSOCVARIABLE and
 *   ACDBASSOC2DCONSTRAINTGROUP): class version 1 before R2013, 2 from it;
 *   version 2 closes the base with four fields — `BS 0, BL owned
 *   parameters, BS 0, BL value parameters` — that the samples always
 *   carry as zeros. The rest of a network or a variable is the same in
 *   both spellings, string stream included.
 * - AcDbAssocGeomDependency: its persistent sub-entity id names its
 *   class as a text before R2013 (`AcDbAssocSingleEdgePersSubentId`,
 *   `AcDbAssocEdgePersSubentId` — a string of the record's string
 *   stream); from R2013 as `B 0, BL code` (1 and 3 for those two). The
 *   fields of the id itself (an edge's `BS, BL, BL`) and the closing
 *   `B` are the same in both.
 * - AcDbAssoc2dConstraintGroup: before R2013 every node is spelled as
 *   `T class, BL id, RC status, BL n, n×BL connections, body`; from
 *   R2013 the group opens with `BL 0, BL 0, B 0`, a table of the distinct
 *   class names (`BL count`, the names in the string stream in order of
 *   first use), `BL nodes`, one `B 0, BL name index (1-based), BL id`
 *   per node, and then every node as `BL id, BL n, n×BL, RC status,
 *   body`. The node bodies are the same in both; their grammar (below)
 *   is pinned by the reference's DXF of four samples, and every node
 *   walk here must land on the record's last bit or the translation is
 *   refused.
 * - ACDBASSOCDEPENDENCY, ACDBASSOCVALUEDEPENDENCY and the dependency
 *   bodies (ASSOCDIMDEPENDENCYBODY, BLOCKPARAMDEPENDENCYBODY) are
 *   bit-identical in both spellings.
 *
 * The R2007 spelling is the R2010 one (the reference's 2007 and 2010
 * saves are bit-identical for the family), so a record can be carried
 * natively between the R2007 family and the R2013 family in either
 * direction. The R2000/R2004 spelling (strings inline) is not handled
 * here — those targets keep the proxy path. Everything a translation
 * does not understand — an unknown node class, a non-zero field the
 * other spelling cannot hold, an unknown persistent id class, a walk
 * that misses the last bit — refuses, and the caller keeps the record
 * as it was. */

import { BitReader } from './bitstream.js';
import { BitWriter } from './bitwriter.js';
import { toBase64 } from './objects.js';

export type AssocSpelling = 'pre2013' | 'r2013';

/** The bits of a sealed record of the family, as the readers keep them. */
export interface AssocBits {
  data?: string;
  dataBits?: number;
  strData?: string;
  strBits?: number;
  refs?: { code: number; value: string }[];
}

/** Whether a class name (DXF spelling, upper case) is one of the
 *  associative framework's. */
export const isAssocKind = (kind: string): boolean =>
  kind.startsWith('ACDBASSOC') || kind.startsWith('ASSOC') || /DEPENDENCYBODY$/.test(kind);

/** The kinds whose bits are the same in both spellings. */
const SAME_KINDS = new Set(['ACDBASSOCDEPENDENCY', 'ACDBASSOCVALUEDEPENDENCY',
  'ASSOCDIMDEPENDENCYBODY', 'BLOCKPARAMDEPENDENCYBODY']);

/** The CLASSES version pair a kind of the family carries in each
 *  spelling — the pair is what tells the reference which spelling the
 *  records are in, not the file's release: the dependency classes
 *  (ACDBASSOCDEPENDENCY, ACDBASSOCGEOMDEPENDENCY, ACDBASSOCVALUEDEPENDENCY,
 *  ASSOCDIMDEPENDENCYBODY) are 27/50 in its 2007 and 2010 saves and
 *  27/175 in its 2013 and 2018 files, the rest of the family the same
 *  in both (27/45 the actions and the network, 28/1 the block parameter
 *  dependency body). A 2007 file of ours carrying the R2010 spelling
 *  under 27/175 had its dependencies read as the R2013 form — the
 *  reference erased them and rebuilt the networks (24 silent AUDIT fixes
 *  on Structural - Metric, six constraint parameters lost); under 27/50
 *  the same file audits clean. Undefined for a kind whose pair does not
 *  change. */
export const assocClassPair = (
  kind: string, spelling: AssocSpelling
): { dwgVersion: number; maintVersion: number } | undefined => {
  const k = kind.toUpperCase();
  if (k === 'ACDBASSOCDEPENDENCY' || k === 'ACDBASSOCGEOMDEPENDENCY'
    || k === 'ACDBASSOCVALUEDEPENDENCY' || k === 'ASSOCDIMDEPENDENCYBODY') {
    return { dwgVersion: 27, maintVersion: spelling === 'r2013' ? 175 : 50 };
  }
  return undefined;
};

/** Persistent sub-entity id classes and their R2013 codes. */
const PERS_SUBENT: [number, string][] = [
  [1, 'AcDbAssocSingleEdgePersSubentId'],
  [3, 'AcDbAssocEdgePersSubentId']
];

/** The constraint group's node bodies (past the id, status and
 *  connections), field by field: H a handle of the handle stream (no data
 *  bits), 3BD? a point present when the node's geometry dependency is not
 *  null, 3BD?rc one present when the RC before it is not zero, BD13 a
 *  real the R2013 spelling alone carries (a circle's or arc's fourth —
 *  zero in every record the reference wrote, and what it reads into a
 *  record without one; the RC13 case of the same mechanism is kept for a
 *  closing byte, none known today). */
const NODE_BODY: Record<string, readonly string[]> = {
  AcConstrainedBoundedLine: ['H', 'BL', '3BD', '3BD', 'B', '3BD', '3BD'],
  AcConstrainedDatumLine: ['H', 'BL', '3BD', '3BD'],
  AcConstrainedImplicitPoint: ['H', 'BL', '3BD?', 'RC', 'BL', 'BL'],
  AcConstrainedArc: ['H', 'BL', '3BD', '3BD', '3BD', 'BD', 'BD', 'BD', 'BD13', '3BD', '3BD'],
  AcConstrainedCircle: ['H', 'BL', '3BD', '3BD', '3BD', 'BD', 'BD', 'BD', 'BD13'],
  AcPointCurveConstraint: ['BL', 'B', 'B'],
  AcFixedConstraint: ['BL', 'B', 'B'],
  AcPointCoincidenceConstraint: ['BL', 'B', 'B'],
  AcColinearConstraint: ['BL', 'B', 'B'],
  AcParallelConstraint: ['BL', 'B', 'B'],
  AcPerpendicularConstraint: ['BL', 'B', 'B'],
  AcTangentConstraint: ['BL', 'B', 'B'],
  AcEqualLengthConstraint: ['BL', 'B', 'B'],
  AcEqualRadiusConstraint: ['BL', 'B', 'B'],
  AcMidPointConstraint: ['BL', 'B', 'B'],
  AcCenterPointConstraint: ['BL', 'B', 'B'],
  AcHorizontalConstraint: ['BL', 'B', 'B', 'BL'],
  AcVerticalConstraint: ['BL', 'B', 'B', 'BL'],
  AcDistanceConstraint: ['BL', 'B', 'B', 'H', 'H', 'RC', '3BD?rc'],
  AcAngleConstraint: ['BL', 'B', 'B', 'H', 'H', 'RC'],
  AcRadiusDiameterConstraint: ['BL', 'B', 'B', 'H', 'H', 'RC']
};

const fromBase64 = (text: string): Uint8Array => {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** A record's data bits: read to find the fields, copy spans verbatim. */
class Src {
  readonly r: BitReader;
  constructor(readonly bytes: Uint8Array, readonly nbits: number) {
    this.r = new BitReader(bytes, 0, nbits);
  }
  get pos(): number { return this.r.pos; }
  copy(w: BitWriter, from: number, to: number): void {
    for (let i = from; i < to; i++) w.b((this.bytes[i >> 3] >> (7 - (i & 7))) & 1);
  }
}

/** One text of an R2007+ string stream: its span and its characters. */
interface StrSpan { start: number; end: number; text: string }

/** The string stream as a list of texts, or null when it does not parse
 *  as a run of `BS length, length × RS` that ends on its last bit. */
const parseStrings = (s: AssocBits): StrSpan[] | null => {
  if (!s.strData || !s.strBits) return [];
  const bytes = fromBase64(s.strData);
  const r = new BitReader(bytes, 0, s.strBits);
  const out: StrSpan[] = [];
  try {
    while (r.pos < s.strBits) {
      const start = r.pos;
      const len = r.bs();
      if (len < 0 || r.pos + len * 16 > s.strBits) return null;
      let text = '';
      for (let i = 0; i < len; i++) text += String.fromCharCode(r.rs());
      out.push({ start, end: r.pos, text });
    }
  } catch {
    return null;
  }
  return r.pos === s.strBits ? out : null;
};

/** Writes the string stream: a source span verbatim or a new text. */
const emitStrings = (
  src: AssocBits, items: (StrSpan | string)[]
): { strData?: string; strBits?: number } => {
  const w = new BitWriter();
  const bytes = src.strData ? fromBase64(src.strData) : new Uint8Array(0);
  for (const it of items) {
    if (typeof it === 'string') w.tu(it);
    else for (let i = it.start; i < it.end; i++) w.b((bytes[i >> 3] >> (7 - (i & 7))) & 1);
  }
  return w.pos ? { strData: toBase64(w.bytes()), strBits: w.pos } : {};
};

const finish = (
  src: AssocBits, w: BitWriter, strings: { strData?: string; strBits?: number }
): AssocBits => ({
  ...src,
  data: toBase64(w.bytes()), dataBits: w.pos,
  strData: strings.strData, strBits: strings.strBits
});

/** The AcDbAssocAction base, read from `s` and written to `w` in the
 *  target spelling. Returns the counts the handle stream depends on, or
 *  null when the record cannot cross (a non-zero R2013 field). */
const actionBase = (
  s: Src, w: BitWriter, from: AssocSpelling, to: AssocSpelling
): { numDeps: number } | null => {
  const r = s.r;
  const ver = r.bs();
  const afterVer = s.pos;
  r.bl(); r.bl(); r.bl();
  const numDeps = r.bl();
  if (numDeps < 0 || numDeps > 100000) return null;
  for (let i = 0; i < numDeps; i++) r.b();
  const fixedEnd = s.pos;
  if (from === 'r2013') {
    if (ver === 2) {
      const a = r.bs(); const owned = r.bl(); const c = r.bs(); const values = r.bl();
      if (a !== 0 || owned !== 0 || c !== 0 || values !== 0) return null;
    } else if (ver !== 1) return null;
  } else if (ver !== 1) return null;
  if (to === 'r2013') {
    w.bs(2);
    s.copy(w, afterVer, fixedEnd);
    w.bs(0); w.bl(0); w.bs(0); w.bl(0);
  } else {
    w.bs(1);
    s.copy(w, afterVer, fixedEnd);
  }
  return { numDeps };
};

/** A network or a variable: the base respelled, the rest verbatim. */
const respellAction = (rec: AssocBits, from: AssocSpelling, to: AssocSpelling): AssocBits | null => {
  const s = new Src(fromBase64(rec.data!), rec.dataBits!);
  const w = new BitWriter();
  if (!actionBase(s, w, from, to)) return null;
  s.copy(w, s.pos, s.nbits);
  return finish(rec, w, { strData: rec.strData, strBits: rec.strBits });
};

/** A geometry dependency: the persistent sub-entity id's class as a
 *  text (pre-2013) or a code (R2013). */
const respellGeomDependency = (rec: AssocBits, from: AssocSpelling, to: AssocSpelling): AssocBits | null => {
  const strings = parseStrings(rec);
  if (!strings) return null;
  const s = new Src(fromBase64(rec.data!), rec.dataBits!);
  const r = s.r;
  const w = new BitWriter();
  /* AcDbAssocDependency: version, status, four flags, order, has-name,
     dependency body id; then the geometry dependency's version and
     enabled flag */
  const ver = r.bs();
  if (ver < 0 || ver > 3) return null;
  r.bl(); r.b(); r.b(); r.b(); r.b(); r.bl();
  const hasName = r.b();
  r.bl();
  r.bs(); r.b();
  const head = s.pos;
  s.copy(w, 0, head);
  const nameAt = hasName ? 1 : 0;
  if (from === 'pre2013') {
    const cls = strings[nameAt];
    if (!cls) return null;
    const code = PERS_SUBENT.find(([, name]) => name === cls.text)?.[0];
    if (code === undefined) return null;
    w.b(0); w.bl(code);
    s.copy(w, s.pos, s.nbits);
    const rest = strings.filter((_, i) => i !== nameAt);
    return finish(rec, w, emitStrings(rec, rest));
  }
  if (r.b() !== 0) return null;               /* a class named inline: unknown */
  const code = r.bl();
  const name = PERS_SUBENT.find(([c]) => c === code)?.[1];
  if (!name) return null;
  s.copy(w, s.pos, s.nbits);
  const items: (StrSpan | string)[] = [...strings.slice(0, nameAt), name, ...strings.slice(nameAt)];
  return finish(rec, w, emitStrings(rec, items));
};

/** A 2D constraint group: the base respelled, the node list re-laid. */
const respellConstraintGroup = (rec: AssocBits, from: AssocSpelling, to: AssocSpelling): AssocBits | null => {
  const strings = parseStrings(rec);
  if (!strings) return null;
  const s = new Src(fromBase64(rec.data!), rec.dataBits!);
  const r = s.r;
  const w = new BitWriter();
  const base = actionBase(s, w, from, to);
  if (!base) return null;
  /* the group's head: version, a flag, the work plane (three points),
     the dependency count (handles), one more count — verbatim */
  const headStart = s.pos;
  r.bl(); r.b();
  for (let i = 0; i < 9; i++) r.bd();
  const numDeps = r.bl();
  if (numDeps < 0 || numDeps > 100000) return null;
  r.bl();
  s.copy(w, headStart, s.pos);
  /* the handle stream past the base and the head: one per node H field */
  let refAt = 2 + base.numDeps + 1 + numDeps;
  const refs = rec.refs;
  const nextRef = (): string | null => {
    const x = refs?.[refAt++];
    return x && x.value !== '0' ? x.value : null;
  };
  /* the nodes' classes, one per node, in either spelling */
  let numNodes: number;
  let numNames = 0;
  const names: string[] = [];
  const tableIds: number[] = [];
  if (from === 'r2013') {
    if (r.bl() !== 0 || r.bl() !== 0 || r.b() !== 0) return null;
    numNames = r.bl();
    if (numNames < 0 || numNames > strings.length) return null;
    numNodes = r.bl();
    if (numNodes < 0 || numNodes > 100000) return null;
    for (let i = 0; i < numNodes; i++) {
      if (r.b() !== 0) return null;
      const ix = r.bl();
      if (ix < 1 || ix > numNames) return null;
      names.push(strings[ix - 1].text);
      tableIds.push(r.bl());
    }
  } else {
    numNodes = r.bl();
    if (numNodes < 0 || numNodes > 100000 || strings.length < numNodes) return null;
    for (let i = 0; i < numNodes; i++) names.push(strings[i].text);
  }
  /* every node: its head fields as spans, its body as one span (an R2013-only
     closing byte left out of the span and noted) */
  type Part = [number, number] | 'RC13' | 'BD13';
  interface Node {
    id: number; idSpan: [number, number]; statusSpan: [number, number];
    connSpan: [number, number]; body: Part[];
  }
  const nodes: Node[] = [];
  try {
    for (let k = 0; k < numNodes; k++) {
      const grammar = NODE_BODY[names[k]];
      if (!grammar) return null;
      let idSpan: [number, number], statusSpan: [number, number], connSpan: [number, number];
      const span = (fn: () => void): [number, number] => { const a = s.pos; fn(); return [a, s.pos]; };
      const conns = (): void => {
        const n = r.bl();
        if (n < 0 || n > 100000) throw new RangeError('connections');
        for (let i = 0; i < n; i++) r.bl();
      };
      if (from === 'r2013') {
        idSpan = span(() => r.bl());
        connSpan = span(conns);
        statusSpan = span(() => r.rc());
      } else {
        idSpan = span(() => r.bl());
        statusSpan = span(() => r.rc());
        connSpan = span(conns);
      }
      const id = new BitReader(s.bytes, idSpan[0], idSpan[1]).bl();
      if (from === 'r2013' && tableIds[k] !== id) return null;
      /* the body: spans copied verbatim around the R2013-only fields,
         which are read (and must be zero) in that spelling and noted
         for the writer in either */
      const body: Part[] = [];
      let segStart = s.pos;
      let geomDep: string | null = null;
      let lastRc = 0;
      let firstH = true;
      for (const t of grammar) {
        switch (t) {
          case 'H': { const h = nextRef(); if (firstH) { geomDep = h; firstH = false; } break; }
          case 'BL': r.bl(); break;
          case 'B': r.b(); break;
          case 'RC': lastRc = r.rc(); break;
          case 'BD': r.bd(); break;
          case '3BD': r.bd3(); break;
          case '3BD?': if (geomDep !== null) r.bd3(); break;
          case '3BD?rc': if (lastRc !== 0) r.bd3(); break;
          case 'RC13':
          case 'BD13':
            body.push([segStart, s.pos], t);
            if (from === 'r2013' && (t === 'RC13' ? r.rc() : r.bd()) !== 0) return null;
            segStart = s.pos;
            break;
          default: return null;
        }
      }
      body.push([segStart, s.pos]);
      nodes.push({ id, idSpan, statusSpan, connSpan, body });
    }
  } catch {
    return null;
  }
  if (s.pos !== s.nbits) return null;
  if (refs && refAt !== refs.length) return null;
  /* write the node list in the target spelling, the nodes in ascending id
     order — the order of the reference's own saves in either spelling
     (its older files list them as its hash table happened to; the
     connections name ids, not positions, so the order is free) */
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].id - nodes[b].id);
  const body = (n: Node): void => {
    for (const part of n.body) {
      if (typeof part === 'string') { if (to === 'r2013') { if (part === 'RC13') w.rc(0); else w.bd(0); } }
      else s.copy(w, part[0], part[1]);
    }
  };
  const nameOf = (i: number): StrSpan | string => strings.find((x) => x.text === names[i]) ?? names[i];
  let items: (StrSpan | string)[];
  if (to === 'r2013') {
    const distinct: string[] = [];
    for (const i of order) if (!distinct.includes(names[i])) distinct.push(names[i]);
    w.bl(0); w.bl(0); w.b(0);
    w.bl(distinct.length);
    w.bl(numNodes);
    for (const i of order) {
      const n = nodes[i];
      w.b(0); w.bl(distinct.indexOf(names[i]) + 1);
      s.copy(w, n.idSpan[0], n.idSpan[1]);
    }
    for (const i of order) {
      const n = nodes[i];
      s.copy(w, n.idSpan[0], n.idSpan[1]);
      s.copy(w, n.connSpan[0], n.connSpan[1]);
      s.copy(w, n.statusSpan[0], n.statusSpan[1]);
      body(n);
    }
    /* the distinct names in order of first use; any further text of the
       source stream (none is known) follows */
    const rest = strings.slice(from === 'r2013' ? numNames : numNodes);
    items = [...distinct.map((d) => strings.find((x) => x.text === d) ?? d), ...rest];
  } else {
    w.bl(numNodes);
    for (const i of order) {
      const n = nodes[i];
      s.copy(w, n.idSpan[0], n.idSpan[1]);
      s.copy(w, n.statusSpan[0], n.statusSpan[1]);
      s.copy(w, n.connSpan[0], n.connSpan[1]);
      body(n);
    }
    const rest = strings.slice(from === 'r2013' ? numNames : numNodes);
    items = [...order.map(nameOf), ...rest];
  }
  return finish(rec, w, emitStrings(rec, items));
};

/** A record of the family in the other spelling: the same record when
 *  the spellings agree or the kind is spelled alike in both, null when
 *  the record cannot be carried (an unknown kind of the family, a field
 *  the target cannot hold, a walk that does not land on the last bit). */
export const respellAssoc = (
  kind: string, rec: AssocBits, from: AssocSpelling, to: AssocSpelling
): AssocBits | null => {
  if (from === to) return rec;
  const k = kind.toUpperCase();
  if (SAME_KINDS.has(k)) return rec;
  if (!rec.data || !rec.dataBits) return null;
  try {
    switch (k) {
      case 'ACDBASSOCNETWORK':
      case 'ACDBASSOCVARIABLE':
        return respellAction(rec, from, to);
      case 'ACDBASSOCGEOMDEPENDENCY':
        return respellGeomDependency(rec, from, to);
      case 'ACDBASSOC2DCONSTRAINTGROUP':
        return respellConstraintGroup(rec, from, to);
      default:
        return null;
    }
  } catch {
    return null;
  }
};
