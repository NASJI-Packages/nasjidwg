/* nasjidwg — page packing for the AC1018..AC1032 container.
 *
 * Pages in these releases are stored in a byte-oriented LZ77 dialect. The
 * packed form is a chain of opcodes that alternate between two things: a
 * run of raw bytes, and a back-reference into the output produced so far.
 * The alternation is implicit rather than flagged — every back-reference
 * carries, in its own low two bits, the length of the literal run that
 * follows it. Opcode 0x11 ends the stream.
 *
 * Counts share one escape convention. A count that does not fit its field
 * stores zero there and continues outside the opcode as a chain of 0x00
 * bytes worth 0xFF apiece, closed by a non-zero byte.
 */

/** Cursor over the packed bytes.
 *
 *  Reads past the end yield zero rather than throwing: a page whose tail
 *  was lost then drains its input and falls out of the decode loop, which
 *  salvages the objects that did arrive instead of failing the section. */
class Packed {
  private at = 0;

  constructor(private readonly src: Uint8Array) {}

  get exhausted(): boolean { return this.at >= this.src.length; }

  next(): number { return this.at < this.src.length ? this.src[this.at++] : 0; }

  /** Copy `n` source bytes straight into `out` at `write` (short reads
   *  zero-fill, matching next()'s salvage semantics). One set() replaces a
   *  method call per byte on the literal runs that dominate a big page. */
  copyInto(out: Uint8Array, write: number, n: number): void {
    const src = this.src;
    const avail = Math.min(n, Math.max(0, src.length - this.at));
    /* the byte-wise original tolerated writes past out's end (tail padding
       is never read) and always consumed the source — keep both */
    const room = Math.min(avail, Math.max(0, out.length - write));
    if (room > 0) out.set(src.subarray(this.at, this.at + room), write);
    this.at += avail;
    const zeroFrom = write + avail;
    if (avail < n && zeroFrom < out.length) {
      out.fill(0, zeroFrom, Math.min(write + n, out.length));
    }
  }

  /** The escape chain: 0xFF for every 0x00 byte, plus the byte that ends it. */
  private escaped(): number {
    let total = 0;
    let b: number;
    while ((b = this.next()) === 0 && !this.exhausted) total += 0xff;
    return total + b;
  }

  /** A count carried in the `field` bits of `opcode`, with `base` added
   *  back on. Zero in the field means the real count escaped out of line;
   *  the field is then saturated, so its width counts toward the total. */
  count(opcode: number, field: number, base: number): number {
    const inline = opcode & field;
    return (inline === 0 ? field + this.escaped() : inline) + base;
  }
}

/** Unpack one stream into `out` at `start`; returns the position one past
 *  the last byte written.
 *
 *  How much a stream produces is the stream's own business — it runs to
 *  its terminator — and its back-references may reach behind `start`: the
 *  pages of one logical section share a single window, so a later page
 *  routinely quotes bytes an earlier page produced. Callers therefore hand
 *  in the whole section buffer, never a lone page. */
export function decompressR2004Into(
  src: Uint8Array, out: Uint8Array, start: number
): number {
  const packed = new Packed(src);
  let write = start;

  /* Emit `n` raw bytes and hand back the opcode stored right behind them. */
  const literals = (n: number): number => {
    packed.copyInto(out, write, n);
    write += n;
    return packed.next();
  };

  /* A stream is allowed to open with literals, before any back-reference. */
  let opcode = packed.next();
  if ((opcode & 0xf0) === 0) opcode = literals(packed.count(opcode, 0x0f, 3));

  while (!packed.exhausted && write < out.length && opcode !== 0x11) {
    let length: number;
    let distance: number;

    if (opcode < 0x10) {
      /* Reserved by the format: these values would be indistinguishable
       * from the literal-run opcodes handled above. */
      throw new Error(
        `R2004 unpack: reserved opcode 0x${opcode.toString(16)}`);
    } else if (opcode < 0x20) {
      /* Long reach — distances from 0x4000 up. Bit 3 of the opcode is the
       * distance's top bit; the rest arrives in the following pair. */
      length = packed.count(opcode, 7, 2);
      const lead = packed.next();
      distance = (lead >> 2) + (packed.next() << 6) + 0x4000
               + ((opcode & 8) << 11);
      opcode = lead;
    } else if (opcode < 0x40) {
      /* Ordinary reach — the trailing pair holds a 14-bit distance. */
      length = packed.count(opcode, 0x1f, 2);
      const lead = packed.next();
      distance = (lead >> 2) + (packed.next() << 6) + 1;
      opcode = lead;
    } else {
      /* Compact — length and the low two distance bits ride inside the
       * opcode itself, one further byte carries the top eight. */
      length = (opcode >> 4) - 1;
      distance = (((opcode >> 2) & 3) | (packed.next() << 2)) + 1;
    }

    if (distance > write) {
      throw new Error(
        `R2004 unpack: back-reference ${distance} reaches before the output start at ${write}`);
    }

    /* A distance shorter than the length is how the format spells a
     * repeating run: that copy must read back bytes it wrote moments ago,
     * so it stays byte-at-a-time. A distance >= length has no overlap and
     * moves as one block. The last copy of a page may run into the
     * buffer's tail; that overshoot is padding and is never read. */
    const stop = Math.min(write + length, out.length);
    if (distance >= stop - write) {
      out.copyWithin(write, write - distance, write - distance + (stop - write));
      write = stop;
    } else {
      for (; write < stop; write++) out[write] = out[write - distance];
    }

    /* The literal run that follows, named by the low bits of whichever byte
     * ended the back-reference. Zero means the count is in the next opcode. */
    let run = opcode & 3;
    if (run === 0) {
      opcode = packed.next();
      if ((opcode & 0xf0) === 0) run = packed.count(opcode, 0x0f, 3);
    }
    if (run > 0) {
      if (write + run > out.length) break;
      opcode = literals(run);
    }
  }

  return write;
}

/** Unpack a self-contained block — the page map and section map pages —
 *  to exactly `decompressedSize` bytes. A stream that stops early leaves
 *  the remainder zeroed, which is normal: writers pad these pages. */
export function decompressR2004(src: Uint8Array, decompressedSize: number): Uint8Array {
  const out = new Uint8Array(decompressedSize);
  decompressR2004Into(src, out, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* the matcher                                                        */

/** What a dialect can express is all the matcher needs to know about it.
 *  The encodings themselves stay with their emitters; these four numbers
 *  are the whole interface between searching and spelling. */
export interface LzRules {
  /** No match may start before this position: the opening literal run has
   *  a smallest expressible size, so the first bytes are always literal. */
  firstMatchAt: number;
  /** The furthest back a reference can reach. */
  maxDistance: number;
  /** The longest copy one back-reference can spell. */
  maxLength: number;
  /** Three-byte matches are only encodable (or only worth their opcode)
   *  up to this distance; beyond it a match must run four bytes or more. */
  shortMatchMaxDistance: number;
}

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
/** How many chain candidates to try per position. Deep enough that the
 *  repetitive object streams DWG pages are made of compress well, shallow
 *  enough that pathological inputs stay linear in practice. */
const MAX_CHAIN = 128;

/** Greedy LZ77 parse of `src` under `rules`, using a hash chain over
 *  3-byte prefixes. Emits, in stream order, each match together with the
 *  literal run in front of it, and finishes with a final `length === 0`
 *  call carrying whatever literals remain. Newer candidates sit earlier in
 *  the chain, so among equal lengths the shortest distance wins — that is
 *  always the cheaper spelling in both dialects. */
export function lzParse(
  src: Uint8Array, rules: LzRules,
  emit: (litFrom: number, litTo: number, length: number, distance: number) => void,
): void {
  const n = src.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(Math.max(1, n)).fill(-1);
  const hashAt = (i: number): number =>
    Math.imul((src[i] << 16) | (src[i + 1] << 8) | src[i + 2], 0x9e3779b1)
      >>> (32 - HASH_BITS);
  const insert = (i: number): void => {
    const h = hashAt(i);
    prev[i] = head[h];
    head[h] = i;
  };

  let litFrom = 0;
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i >= rules.firstMatchAt && i + 3 <= n) {
      const cap = Math.min(rules.maxLength, n - i);
      let cand = head[hashAt(i)];
      for (let tries = MAX_CHAIN; cand >= 0 && tries > 0; tries--, cand = prev[cand]) {
        const dist = i - cand;
        if (dist > rules.maxDistance) break;      /* chains only get older */
        /* A contender must beat the champion, so it must at least match
         * where the champion ended — one probe rejects most of them. */
        if (bestLen > 0 && src[cand + bestLen] !== src[i + bestLen]) continue;
        let len = 0;
        while (len < cap && src[cand + len] === src[i + len]) len++;
        const floor = dist > rules.shortMatchMaxDistance ? 4 : 3;
        if (len >= floor && len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= cap) break;
        }
      }
    }
    if (bestLen > 0) {
      emit(litFrom, i, bestLen, bestDist);
      /* Every position inside the match still enters the chain: later
       * matches routinely start in the middle of this one. */
      const end = i + bestLen;
      const stop = Math.min(end, n - 2);
      for (; i < stop; i++) insert(i);
      i = end;
      litFrom = end;
    } else {
      if (i + 3 <= n) insert(i);
      i++;
    }
  }
  emit(litFrom, n, 0, 0);
}

/* ------------------------------------------------------------------ */
/* the R2004 encoder                                                  */

const R2004_RULES: LzRules = {
  /* The opening literal opcode cannot say less than four. */
  firstMatchAt: 4,
  /* The long form tops out at 0x3FFF + 0x4000 + 0x4000. */
  maxDistance: 0xbfff,
  /* Lengths escape into an open-ended chain; no practical ceiling. */
  maxLength: 0x7fffffff,
  /* Past 0x4000 only the long form remains, and there a three-byte match
   * would need opcode 0x11 — the terminator. Four is the floor out there. */
  shortMatchMaxDistance: 0x4000,
};

/** Pack `src` into a stream `decompressR2004Into` reverses byte for byte:
 *  a greedy hash-chain matcher over the three back-reference forms, with
 *  literal runs of one to three riding the low bits of the byte that ends
 *  the reference in front of them, and longer runs standing alone. Inputs
 *  under four bytes are padded, because the opening literal opcode cannot
 *  express a shorter run; the decoder's window simply drops the excess. */
export function compressR2004(src: Uint8Array): Uint8Array {
  const data = src.length >= 4 ? src : (() => {
    const padded = new Uint8Array(4);
    padded.set(src);
    return padded;
  })();
  const out: number[] = [];
  /* Index of the byte whose low two bits will name the literal run that
   * follows the match just written; -1 while no match has been written. */
  let countAt = -1;

  /* The shared escape chain: 0x00 per whole 0xFF, closed by the non-zero
   * remainder. `value` is what the decoder's escaped() must add up to. */
  const chain = (value: number): void => {
    let left = value;
    while (left > 0xff) { out.push(0); left -= 0xff; }
    out.push(left);
  };

  const literals = (from: number, to: number): void => {
    const run = to - from;
    if (run === 0) return;
    if (countAt >= 0 && run <= 3) {
      out[countAt] |= run;                 /* rides the previous reference */
    } else if (run <= 18) {
      out.push(run - 3);                   /* fits the opcode's low nibble */
    } else {
      out.push(0);                         /* nibble saturates at 15 + 3 */
      chain(run - 18);
    }
    for (let i = from; i < to; i++) out.push(data[i]);
  };

  const match = (length: number, distance: number): void => {
    if (length <= 14 && distance <= 1024) {
      /* Compact: two bytes carry everything, count bits in the opcode. */
      countAt = out.length;
      out.push(((length + 1) << 4) | (((distance - 1) & 3) << 2),
               (distance - 1) >> 2);
    } else if (distance <= 0x4000) {
      /* Ordinary: 14-bit distance in the trailing pair; the pair's lead
       * byte carries the count bits. */
      if (length <= 33) out.push(0x20 | (length - 2));
      else { out.push(0x20); chain(length - 33); }
      countAt = out.length;
      out.push(((distance - 1) & 0x3f) << 2, (distance - 1) >> 6);
    } else {
      /* Long: bit 3 of the opcode is the distance's top bit, the rest of
       * the reach sits in the pair with 0x4000 subtracted, not 0x4001. */
      const high = distance >= 0x8000 ? 8 : 0;
      const base = distance - (high !== 0 ? 0x8000 : 0x4000);
      if (length <= 9) out.push(0x10 | high | (length - 2));
      else { out.push(0x10 | high); chain(length - 9); }
      countAt = out.length;
      out.push((base & 0x3f) << 2, base >> 6);
    }
  };

  lzParse(data, R2004_RULES, (litFrom, litTo, length, distance) => {
    literals(litFrom, litTo);
    if (length > 0) match(length, distance);
  });
  /* The terminator is opcode 0x11 — a long-form opcode, and AutoCAD's
   * decoder fetches the form's two-byte distance pair before it looks at
   * the value, so every stream ends 0x11 0x00 0x00 and the pair counts
   * toward the compressed size. AutoCAD rejects the whole drawing when
   * those two bytes are missing (verified against AutoCAD 2027: a real
   * file whose page map was respelled with a bare 0x11 stops opening,
   * the same stream with the pair restored opens clean). Our own reader
   * stops at the 0x11 and never reads the pair, which is why the bug
   * could not surface in round-trip tests. */
  out.push(0x11, 0x00, 0x00);
  return Uint8Array.from(out);
}
