/* nasjidwg — the two DWG LZ77 dialects, encoder against decoder.
 *
 * Every case here is a round-trip through the library's own codec pair:
 * compressR2004 against decompressR2004, compressR2007 against the R2007
 * section decompressor. The buffers are chosen to walk the corners of the
 * formats — overlapping copies, the count escape chains, the literal-run
 * minimums, and distances that sit exactly on an encoding boundary — and
 * the whole-file cases prove the compressed containers still read back as
 * the same drawing.
 */

import { describe, expect, it } from 'vitest';
import { compressR2004, decompressR2004 } from '../src/dwg/compress.js';
import { compressR2007, decompress } from '../src/dwg/sections2007.js';
import { readDwg } from '../src/dwg/reader.js';
import { dwgOf, sampleDrawing } from './corpus.js';

/* ------------------------------------------------------------------ */
/* buffer builders                                                    */

/** Deterministic bytes: a fixed LCG, so a failure names a reproducible
 *  buffer instead of a lost random seed. */
const randomBytes = (n: number, seed = 1): Uint8Array => {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};

/** `n` bytes in which no three-byte substring ever repeats: a counter in
 *  three digits, each digit drawn from its own value range, so any three
 *  consecutive bytes reveal both their alignment and their counter. The
 *  matchers can find nothing here, which forces the whole buffer through
 *  the literal-run paths — including the escape chains once `n` outgrows
 *  the inline counts. */
const unmatchable = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / 3);
    const digit = i % 3;
    out[i] = digit === 0 ? k % 85
      : digit === 1 ? 85 + Math.floor(k / 85) % 85
      : 170 + Math.floor(k / 7225) % 86;
  }
  return out;
};

/** A repeating pattern of the given period, `n` bytes long — matches at
 *  distance `period`, shorter than their own length, which is how both
 *  dialects spell an overlapping copy. */
const repetitive = (period: number, n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i % period) * 37 + 11 & 0xff;
  return out;
};

/** A 16-byte token, unmatchable filler, then the token again: the only
 *  match in the buffer sits at exactly `distance`. Token bytes live in a
 *  value range the filler's digit pattern never produces. */
const distanced = (distance: number): Uint8Array => {
  const token = Uint8Array.from({ length: 16 }, (_, i) => 200 + i);
  const out = new Uint8Array(distance + 16 + 8);
  out.set(token, 0);
  out.set(unmatchable(distance - 16), 16);
  out.set(token, distance);
  out.set(unmatchable(8), distance + 16);
  return out;
};

/* ------------------------------------------------------------------ */
/* round-trip harnesses                                               */

const firstDiff = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
};

const roundTrip2004 = (src: Uint8Array): number => {
  const comp = compressR2004(src);
  const back = decompressR2004(comp, src.length);
  expect(back.length).toBe(src.length);
  expect(firstDiff(back, src)).toBe(-1);
  return comp.length;
};

const roundTrip2007 = (src: Uint8Array): number => {
  const comp = compressR2007(src);
  /* Inputs under eight bytes are padded to the shortest opening literal
   * run, so the decoder needs that much room — exactly the slack the
   * library's own R2007 page readers always provide. */
  const out = new Uint8Array(Math.max(src.length, 8));
  decompress(out, 0, out.length, comp, comp.length);
  expect(firstDiff(out.subarray(0, src.length), src)).toBe(-1);
  return comp.length;
};

const bothWays = (src: Uint8Array): void => {
  roundTrip2004(src);
  roundTrip2007(src);
};

/* ------------------------------------------------------------------ */

describe('LZ77 round-trips, both dialects', () => {
  it('random bytes', () => {
    for (const n of [64, 1000, 4096]) bothWays(randomBytes(n, n));
  });

  it('all-zero buffers', () => {
    for (const n of [8, 64, 4096, 65536]) bothWays(new Uint8Array(n));
  });

  it('repetitive patterns, period 1..7 (overlapping copies)', () => {
    for (let period = 1; period <= 7; period++) {
      bothWays(repetitive(period, 2000));
    }
  });

  it('every size from 0 to 40 bytes', () => {
    for (let n = 0; n <= 40; n++) {
      bothWays(randomBytes(n, 7 + n));
      bothWays(repetitive(3, n));
    }
  });

  it('unmatchable runs force the literal escape chains', () => {
    /* 400 crosses both dialects' inline literal counts; 70200 outgrows
     * R2007's first chain byte and its first 16-bit word, and R2004's
     * single-byte chain closer. */
    for (const n of [400, 70200]) bothWays(unmatchable(n));
  });

  it('a 70001-byte run forces the match-length escapes', () => {
    /* One giant match: R2004 spells it through the 0x00 length chain,
     * R2007 caps a copy at 0x100FF and needs a second reference. */
    bothWays(new Uint8Array(70001).fill(0xab));
  });

  it('distances at the encoding boundaries', () => {
    /* 1024/1025 is R2004 compact/ordinary, 0x4000/0x4001 ordinary/long,
     * 0x8000 the long form's high bit, 0xbfff its reach; 0x200/0x201 and
     * 0x2000/0x2001 are R2007's compact/near/far seams, 0xffff its window.
     * Distances past a dialect's window must round-trip as literals. */
    for (const d of [1024, 1025, 0x200, 0x201, 0x2000, 0x2001,
                     0x4000, 0x4001, 0x8000, 0x8001, 0xbfff, 0xffff]) {
      bothWays(distanced(d));
    }
    /* Distance 1 is the period-1 pattern. */
    bothWays(repetitive(1, 64));
  });
});

describe('compression effectiveness', () => {
  it('a repetitive 64 KiB buffer compresses to well under half', () => {
    const src = repetitive(32, 65536);
    expect(roundTrip2004(src)).toBeLessThan(src.length / 4);
    expect(roundTrip2007(src)).toBeLessThan(src.length / 4);
  });
});

describe('whole files through the compressed containers', () => {
  const mix = (entities: readonly { type: string }[]): Record<string, number> => {
    const c: Record<string, number> = {};
    for (const e of entities) c[e.type] = (c[e.type] ?? 0) + 1;
    return c;
  };

  it.each(['R2004', 'R2018', 'R2007'] as const)(
    '%s reads back warning-free with every entity', (version) => {
      const back = readDwg(dwgOf(version));
      expect(back.warnings).toEqual([]);
      const expected = mix(sampleDrawing().entities);
      /* The AC1018 writer has nowhere to park a SAB body — the AcDs
       * section arrived in 2013 — so 'acis' never survives that container.
       * The never-compressed R2000 baseline drops it the same way. */
      if (version === 'R2004') delete expected.acis;
      expect(mix(back.entities)).toEqual(expected);
    });

  it('the R2004 container matches the uncompressed R2000 baseline', () => {
    expect(mix(readDwg(dwgOf('R2004')).entities))
      .toEqual(mix(readDwg(dwgOf('R2000')).entities));
  });
});
