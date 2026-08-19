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
