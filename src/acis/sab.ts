/* nasjidwg — ACIS/ASM binary (SAB) to text (SAT) conversion.
 *
 * A SAB stream is the same record list as a SAT file in a tagged binary
 * form. The token grammar below was reverse-engineered byte-for-byte
 * against real payloads, and calibrated against a text form of the very
 * same solids, so what it emits matches token-for-token what a CAD
 * program writes.
 *
 * Tags: 04 int32, 06 double, 07/08 string (u8/u32 length), 0A/0B boolean
 * true/false, 0C entity pointer, 0D identifier, 0E subclass identifier
 * (joined with '-'), 0F/10 braces, 11 record end, 13/14 position/vector
 * (three doubles), 15 enum, 17 int64.
 */

const SIG_ACIS = 'ACIS BinaryFile';
const SIG_ASM = 'ASM BinaryFile';

/** Booleans print as record-specific keyword pairs [true, false]; the
 *  positions not named here are interval markers (finite/infinite). */
const BOOL_WORDS: Record<string, ReadonlyArray<readonly [string, string] | null>> = {
  face: [['reversed', 'forward'], ['double', 'single'], ['in', 'out']],
  coedge: [['reversed', 'forward']],
  edge: [['reversed', 'forward']],
  'cone-surface': [null, null, ['reversed', 'forward']],
  'plane-surface': [['reverse_v', 'forward_v']],
  'torus-surface': [['reverse_v', 'forward_v']],
  'sphere-surface': [['reverse_v', 'forward_v']],
  'spline-surface': [['reversed', 'forward']],
  pcurve: [['reversed', 'forward']]
};

/** Attribute migration actions, in the spelling SAT text uses. */
const ENUM_WORDS: Record<number, string> = {
  1: 'ignore', 2: 'copy', 4: 'keep_all'
};

/** Enum slots inside an exact-spline definition, keyed by the identifier
 *  they follow: the data form after "exactsur", then u/v closure and u/v
 *  singularity after the "nubs" basis. */
const IDENT_SLOTS: Record<string, ReadonlyArray<Record<number, string>>> = {
  exactsur: [{ 0: 'full', 1: 'summary' }],
  nubs: [
    { 0: 'open', 1: 'closed', 2: 'periodic' },
    { 0: 'open', 1: 'closed', 2: 'periodic' },
    { 0: 'none' },
    { 0: 'none' }
  ]
};

/** A double in SAT's spelling: up to 19 significant digits, bare
 *  integers unpadded, two-digit exponents, negative zero kept. */
const num = (v: number): string => {
  if (Object.is(v, -0)) return '-0';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  let s = v.toPrecision(19);
  if (!s.includes('e')) {
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  } else {
    s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  }
  return s;
};

const fromBase64 = (raw: string): Uint8Array => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const text = raw.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((text.length * 3) >> 2);
  let at = 0, acc = 0, bits = 0;
  for (const ch of text) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, at);
};

/** Convert a SAB payload (bytes or base64) to SAT text.
 *  Returns null when the payload is not a SAB stream it can read. */
export const sabToSat = (sab: Uint8Array | string): string | null => {
  const data = typeof sab === 'string' ? fromBase64(sab) : sab;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opens = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      if (data[i] !== s.charCodeAt(i)) return false;
    }
    return true;
  };
  if (!opens(SIG_ACIS) && !opens(SIG_ASM)) return null;
  /* both signatures occupy 15 bytes (ASM pads with a literal '4') */
  let p = 15;
  if (p + 16 > data.length) return null;
  const version = dv.getUint32(p, true);
  p += 8;
  const a = dv.getUint32(p, true);
  p += 4;
  const b = dv.getUint32(p, true);
  p += 4;

  const str = (n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(data[p + i]);
    p += n;
    return s;
  };

  try {
    /* three product strings and three doubles form the SAT header */
    const headStrings: string[] = [];
    const headDoubles: number[] = [];
    while (headStrings.length < 3 && data[p] === 0x07) {
      p++;
      headStrings.push(str(data[p++]));
    }
    while (headDoubles.length < 3 && data[p] === 0x06) {
      p++;
      headDoubles.push(dv.getFloat64(p, true));
      p += 8;
    }

    const records: string[] = [];
    let line: string[] = [];
    let pending = '';                     /* joined subclass identifier */
    let recName = '';
    let boolIndex = 0;
    let lastIdent = '';                   /* nearest identifier, for the
                                             schema of what follows it */
    let boolsSince = 0;
    let enumsSince = 0;
    const push = (word: string): void => {
      if (pending) {
        line.push(pending.slice(0, -1)); /* drop the trailing '-' */
        if (!line.length) { /* unreachable: pending flushes into line */ }
        pending = '';
      }
      line.push(word);
    };
    while (p < data.length) {
      const tag = data[p++];
      switch (tag) {
        case 0x04: push(String(dv.getInt32(p, true))); p += 4; break;
        case 0x06: push(num(dv.getFloat64(p, true))); p += 8; break;
        case 0x07: { const n = data[p++]; push('@' + n + ' ' + str(n)); break; }
        case 0x08: {
          const n = dv.getUint32(p, true);
          p += 4;
          push('@' + n + ' ' + str(n));
          break;
        }
        case 0x0a:
        case 0x0b: {
          const isTrue = tag === 0x0a;
          /* a spline reference's direction sense trails its identifier */
          const pair = lastIdent === 'spline' && boolsSince === 0
            ? ['reversed', 'forward'] as const
            : BOOL_WORDS[recName]?.[boolIndex];
          boolIndex++;
          boolsSince++;
          line.push(pair ? (isTrue ? pair[0] : pair[1]) : (isTrue ? 'F' : 'I'));
          break;
        }
        case 0x0c: push('$' + dv.getInt32(p, true)); p += 4; break;
        case 0x0d: {
          const n = data[p++];
          const name = pending + str(n);
          pending = '';
          if (!line.length) { recName = name; boolIndex = 0; }
          lastIdent = name;
          boolsSince = 0;
          enumsSince = 0;
          line.push(name);
          break;
        }
        case 0x0e: { const n = data[p++]; pending += str(n) + '-'; break; }
        case 0x0f: line.push('{'); break;
        case 0x10: line.push('}'); break;
        case 0x11:
          records.push(line.join(' ') + ' #');
          line = [];
          recName = '';
          break;
        case 0x13:
        case 0x14: {
          for (let i = 0; i < 3; i++) {
            push(num(dv.getFloat64(p, true)));
            p += 8;
          }
          break;
        }
        case 0x15: {
          const v = dv.getInt32(p, true);
          p += 4;
          const slot = IDENT_SLOTS[lastIdent]?.[enumsSince]?.[v];
          enumsSince++;
          push(slot ?? ENUM_WORDS[v] ?? String(v));
          break;
        }
        case 0x17: push(String(dv.getBigInt64(p, true))); p += 8; break;
        default:
          return null;                    /* a tag outside the grammar */
      }
    }
    /* The stream must CLOSE, not merely stop: every SAB is ACIS 7+ or ASM
       (SAB itself only exists from R2007 on), and both dialects end their
       text form with an explicit terminator line. Without it AutoCAD's
       modeler reads to the last record, waits for more, and refuses the
       whole entity — "Premature end of object". */
    const head = [
      `${version} ${records.length} ${a} ${b} `,
      headStrings.map((s) => s.length + ' ' + s).join(' ') + ' ',
      headDoubles.map(num).join(' ') + ' '
    ];
    const terminator = opens(SIG_ASM) ? 'End-of-ASM-data ' : 'End-of-ACIS-data ';
    return head.join('\n') + '\n' + records.join('\n') + '\n' + terminator + '\n';
  } catch {
    return null;                          /* truncated stream */
  }
};

/* ------------------------------------------------------------------ *
 * structural parse: the record graph behind the stream
 * ------------------------------------------------------------------ */

/** Field kinds in a parsed ACIS record. Ints and doubles stay apart
 *  because the binary form tells them apart and a spline's knot
 *  multiplicities ride beside its knot values. */
export const SAB_INT = 0;
export const SAB_NUM = 1;
export const SAB_STR = 2;
export const SAB_BOOL = 3;
export const SAB_PTR = 4;
export const SAB_IDENT = 5;
export const SAB_ENUM = 6;
export const SAB_OPEN = 7;
export const SAB_CLOSE = 8;

/** An ACIS stream as a flat record graph. Fields live in parallel typed
 *  arrays rather than objects: this drawing's solids carry a quarter of a
 *  million records between them, and one object per field would cost more
 *  than the geometry it describes. Record `i` owns fields
 *  `[start[i], start[i + 1])`; `num` holds the numeric payload, and for
 *  strings and identifiers it holds an index into `text`. */
export interface AcisRecords {
  /** Record names, subclass parts joined with '-' ('straight-curve'). */
  names: string[];
  start: Int32Array;
  kind: Uint8Array;
  num: Float64Array;
  text: string[];
  /** Kernel save version, e.g. 21200. */
  version: number;
  /** True when the stream opens with the ASM signature. */
  asm: boolean;
}

/** The base class of a record name: a 'tedge-edge' is an edge, a
 *  'straight-curve' a curve, a 'plane-surface' a surface. */
export const acisBase = (name: string): string => {
  const cut = name.lastIndexOf('-');
  return cut < 0 ? name : name.slice(cut + 1);
};

/** Growable field store shared by both dialect readers. */
const builder = () => {
  const names: string[] = [];
  const starts: number[] = [0];
  let kind = new Uint8Array(4096);
  let num = new Float64Array(4096);
  const text: string[] = [];
  const pool = new Map<string, number>();
  let n = 0;
  return {
    names, starts, text,
    get n(): number { return n; },
    field(k: number, v: number): void {
      if (n === kind.length) {
        const nk = new Uint8Array(n * 2), nn = new Float64Array(n * 2);
        nk.set(kind); nn.set(num); kind = nk; num = nn;
      }
      kind[n] = k; num[n] = v; n++;
    },
    intern(s: string): number {
      let at = pool.get(s);
      if (at === undefined) { at = text.length; text.push(s); pool.set(s, at); }
      return at;
    },
    /** Close the record opened as `name`; a record that never named
     *  itself is stream damage, and its fields go with it. */
    end(name: string): void {
      if (!name) { n = starts[starts.length - 1]; return; }
      names.push(name);
      starts.push(n);
    },
    done(version: number, asm: boolean): AcisRecords {
      return {
        names, start: Int32Array.from(starts),
        kind: kind.subarray(0, n), num: num.subarray(0, n),
        text, version, asm
      };
    }
  };
};

/** Locate the SAB signature at any BIT offset and return the stream
 *  lifted to a byte boundary. A blob pulled off an ACIS entity is already
 *  aligned at zero; one still sealed inside a DWG record is not, because
 *  the record's own bit fields end wherever they end. */
const liftSab = (data: Uint8Array): Uint8Array | null => {
  const at = (i: number, sh: number): number => sh === 0 ? data[i]
    : ((data[i] << sh) | (data[i + 1] >> (8 - sh))) & 0xff;
  /* A record's stream opens within its first bytes, past the common
     entity fields; a signature deeper in is payload, not a header. The
     bound is what lets a caller ask this of every sealed record it has
     without paying for the ones that hold no kernel data at all. */
  const reach = Math.min(data.length, 1024);
  /* Offset first, bit offset second: the header is the EARLIEST match in
     the record, and a later one is a coincidence inside the payload —
     eight of this corpus's sealed surfaces carry exactly such a ghost. */
  for (let i = 0; i + 16 < reach; i++) {
    for (let sh = 0; sh < 8; sh++) {
      for (const sig of [SIG_ACIS, SIG_ASM]) {
        const len = sig.length;
        let ok = true;
        for (let k = 0; k < len && ok; k++) ok = at(i + k, sh) === sig.charCodeAt(k);
        if (!ok) continue;
        if (sh === 0) return i === 0 ? data : data.subarray(i);
        const size = data.length - i - 1;
        const out = new Uint8Array(size);
        for (let k = 0; k < size; k++) out[k] = at(i + k, sh);
        return out;
      }
    }
  }
  return null;
};

/** Parse a SAB payload (bytes, or base64 as the model stores it) into its
 *  record graph. Returns null when no readable stream is present. */
export const parseSab = (sab: Uint8Array | string): AcisRecords | null => {
  const data = liftSab(typeof sab === 'string' ? fromBase64(sab) : sab);
  if (!data) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const asm = data[0] === 0x41 && data[1] === 0x53 && data[2] === 0x4d;
  let p = 15;                             /* both signatures are 15 bytes */
  if (p + 16 > data.length) return null;
  const version = dv.getUint32(p, true);
  p += 16;                                /* version, record count, two ids */

  const b = builder();
  let name = '';
  let prefix = '';
  const str = (n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(data[p + i]);
    p += n;
    return s;
  };
  /* Three product strings and three doubles form the header. They carry
     no record terminator, so they must be stepped over before the record
     loop or they would land in the first record — and every pointer in
     the stream, which addresses records by ordinal, would miss by one. */
  for (let i = 0; i < 3 && data[p] === 0x07; i++) { p++; str(data[p++]); }
  for (let i = 0; i < 3 && data[p] === 0x06; i++) p += 9;
  const fresh = (): boolean => b.n === b.starts[b.starts.length - 1];
  try {
    while (p < data.length) {
      const tag = data[p++];
      switch (tag) {
        case 0x04: b.field(SAB_INT, dv.getInt32(p, true)); p += 4; break;
        case 0x06: b.field(SAB_NUM, dv.getFloat64(p, true)); p += 8; break;
        case 0x07: b.field(SAB_STR, b.intern(str(data[p++]))); break;
        case 0x08: {
          const n = dv.getUint32(p, true);
          p += 4;
          b.field(SAB_STR, b.intern(str(n)));
          break;
        }
        case 0x0a: b.field(SAB_BOOL, 1); break;
        case 0x0b: b.field(SAB_BOOL, 0); break;
        case 0x0c: b.field(SAB_PTR, dv.getInt32(p, true)); p += 4; break;
        case 0x0d: {
          const word = prefix + str(data[p++]);
          prefix = '';
          if (!name && fresh()) name = word;
          else b.field(SAB_IDENT, b.intern(word));
          break;
        }
        case 0x0e: prefix += str(data[p++]) + '-'; break;
        case 0x0f: b.field(SAB_OPEN, 0); break;
        case 0x10: b.field(SAB_CLOSE, 0); break;
        case 0x11: b.end(name); name = ''; prefix = ''; break;
        case 0x13:
        case 0x14:
          for (let i = 0; i < 3; i++) {
            b.field(SAB_NUM, dv.getFloat64(p, true));
            p += 8;
          }
          break;
        case 0x15: b.field(SAB_ENUM, dv.getInt32(p, true)); p += 4; break;
        case 0x17: b.field(SAB_INT, Number(dv.getBigInt64(p, true))); p += 8; break;
        default: p = data.length;         /* a tag outside the grammar */
      }
    }
  } catch { /* truncated stream: keep the records already closed */ }
  return b.done(version, asm);
};

/** Parse a SAT text payload into the same record graph. The dialect is
 *  the same grammar spelled in words, so only the tokenizer differs: '$n'
 *  is a pointer, '@n text' a counted string, a bare word an identifier —
 *  including the ones SAT writes where the binary form carries a boolean
 *  or an enum, which nothing reading this graph needs to tell apart. */
export const parseSat = (sat: string): AcisRecords | null => {
  /* The header is three newline-delimited lines — counts, three counted
     product strings, three tolerances — and no '#' closes them. They must
     go before tokenizing, because records are addressed by ordinal. */
  let from = 0;
  if (/^\s*\d+\s+\d+\s+-?\d+\s+-?\d+\s*$/.test(sat.slice(0, sat.indexOf('\n')))) {
    for (let i = 0; i < 3; i++) {
      const nl = sat.indexOf('\n', from);
      if (nl < 0) return null;
      from = nl + 1;
    }
  }
  const tok = sat.slice(from).match(/@\d+ |[^\s]+/g);
  if (!tok) return null;
  const b = builder();
  let name = '';
  const fresh = (): boolean => b.n === b.starts[b.starts.length - 1];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (t[0] === '@') {
      const n = +t.slice(1, -1);
      let s = '';
      while (s.length < n && i + 1 < tok.length) s += (s ? ' ' : '') + tok[++i];
      b.field(SAB_STR, b.intern(s));
      continue;
    }
    if (t === '#') { b.end(name); name = ''; continue; }
    if (t === '{') { b.field(SAB_OPEN, 0); continue; }
    if (t === '}') { b.field(SAB_CLOSE, 0); continue; }
    if (t[0] === '$') { b.field(SAB_PTR, +t.slice(1)); continue; }
    if (/^[-+]?(\d|\.\d)/.test(t)) {
      b.field(/^[-+]?\d+$/.test(t) ? SAB_INT : SAB_NUM, +t);
      continue;
    }
    if (!name && fresh()) name = t;
    else b.field(SAB_IDENT, b.intern(t));
  }
  return b.names.length ? b.done(0, /End-of-ASM-data/.test(sat)) : null;
};
