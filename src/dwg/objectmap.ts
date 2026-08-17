/* nasjidwg — the object map ("AcDb:Handles" section).
 *
 * A sequence of pages, each: big-endian RS page size (the only big-endian
 * scalar in the format), then delta-coded pairs of (handle, file offset)
 * as modular chars, then a CRC. A page of size 2 terminates the map.
 * Both accumulators restart at zero on every page — the first pair of a
 * page carries absolute values, not deltas from the previous page.
 */

export interface ObjectMapEntry {
  handle: number;
  /** Absolute file offset (R13-R2000) or offset into AcDb:AcDbObjects
   *  (R2004+); the reader knows which. */
  offset: number;
}

export const readObjectMap = (section: Uint8Array): ObjectMapEntry[] => {
  const entries: ObjectMapEntry[] = [];
  let pos = 0;

  /* byte-aligned modular chars (7 data bits, high bit = continuation) */
  const umc = (end: number): number => {
    let v = 0, shift = 0;
    for (;;) {
      if (pos >= end) throw new RangeError('object map truncated');
      const b = section[pos++];
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
      shift += 7;
    }
  };
  const mc = (end: number): number => {
    let v = 0, shift = 0;
    for (;;) {
      if (pos >= end) throw new RangeError('object map truncated');
      let b = section[pos++];
      if (b & 0x80) {
        v += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } else {
        const neg = (b & 0x40) !== 0;
        b &= 0x3f;
        v += b * 2 ** shift;
        return neg ? -v : v;
      }
    }
  };

  while (pos + 2 <= section.length) {
    const size = (section[pos] << 8) | section[pos + 1];   /* big-endian */
    if (size <= 2) break;
    const end = Math.min(pos + size, section.length);
    pos += 2;
    let handle = 0;
    let offset = 0;
    while (pos < end) {
      handle += umc(end);
      offset += mc(end);
      entries.push({ handle, offset });
    }
    pos = end + 2;                        /* skip the page CRC */
  }
  return entries;
};
