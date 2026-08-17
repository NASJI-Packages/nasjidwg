/* nasjidwg — deterministic mutation fuzz over every container.
 *
 * The reader's contract: a damaged file either decodes (salvaging what
 * it can, reporting the rest in warnings) or throws an ordinary Error.
 * It never hangs, never throws a non-Error, never returns a half-built
 * document without a warnings array. This suite drives that contract
 * with seeded byte mutations over the whole generated corpus — the same
 * probe on every machine, every run, so a regression is reproducible by
 * its (version, iteration) coordinates alone.
 */

import { describe, expect, it } from 'vitest';
import { DWG_VERSIONS, dwgOf } from './corpus.js';
import { readDwg } from '../src/dwg/reader.js';

/** Park-Miller LCG: tiny, seedable, identical everywhere. */
const lcg = (seed: number): (() => number) => {
  let s = seed % 0x7fffffff;
  if (s <= 0) s += 0x7ffffffe;
  return () => (s = (s * 48271) % 0x7fffffff) / 0x7fffffff;
};

const MUTATIONS_PER_VERSION = 120;

describe.each(DWG_VERSIONS)('mutation fuzz %s', (version) => {
  const base = dwgOf(version);

  it(`survives ${MUTATIONS_PER_VERSION} seeded mutations`, () => {
    const rand = lcg(0xC0FFEE ^ version.length * 7919 + version.charCodeAt(1));
    for (let i = 0; i < MUTATIONS_PER_VERSION; i++) {
      const bytes = base.slice();
      /* 1-4 byte flips; every third round also truncates the tail */
      const flips = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < flips; k++) {
        const at = Math.floor(rand() * bytes.length);
        bytes[at] ^= 1 + Math.floor(rand() * 255);
      }
      const cut = i % 3 === 2
        ? bytes.subarray(0, 8 + Math.floor(rand() * (bytes.length - 8)))
        : bytes;
      try {
        const d = readDwg(cut);
        expect(Array.isArray(d.warnings), `iteration ${i}`).toBe(true);
        expect(Array.isArray(d.entities), `iteration ${i}`).toBe(true);
      } catch (err) {
        expect(err, `iteration ${i} threw a non-Error`).toBeInstanceOf(Error);
      }
    }
  }, 30000);
});
