/* nasjidwg — binary DXF, both group-code widths.
 *
 * Binary DXF is the same group-code stream as ASCII DXF with typed value
 * encoding. This module converts between raw bytes and the (code, value)
 * pair list the ASCII codec already speaks, so both flavors share one
 * reader and one writer.
 *
 * Group codes are two little-endian bytes from R13 on. Before that they are
 * a single byte, with 255 escaping to a following two-byte code. The width
 * is detected from the first record, which is always (0, "SECTION").
 */

const SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';

export const isBinaryDxf = (data: Uint8Array): boolean => {
  if (data.length < SENTINEL.length) return false;
  for (let i = 0; i < SENTINEL.length; i++) {
    if (data[i] !== SENTINEL.charCodeAt(i)) return false;
  }
  return true;
};

type ValueKind = 'str' | 'dbl' | 'i16' | 'i32' | 'i64' | 'i8' | 'bool' | 'bin';

/** Value encoding for a group code (per the DXF reference appendix). */
const kindOf = (c: number): ValueKind =>
  c <= 9 ? 'str'
  : c <= 59 ? 'dbl'
  : c <= 79 ? 'i16'
  : c <= 99 ? 'i32'
  : (c === 100 || c === 102 || c === 105) ? 'str'
  : c <= 149 ? 'dbl'
  : c <= 169 ? 'i64'
  : c <= 179 ? 'i16'
  : c <= 239 ? 'dbl'
  : c <= 289 ? 'i16'                      /* 280-289 are 2-byte on disk */
  : c <= 299 ? 'bool'
  : c <= 309 ? 'str'
  : c <= 319 ? 'bin'
  : c <= 369 ? 'str'
  : c <= 389 ? 'i16'
  : c <= 399 ? 'str'
  : c <= 409 ? 'i16'
  : c <= 419 ? 'str'
  : c <= 429 ? 'i32'
  : c <= 439 ? 'str'
  : c <= 459 ? 'i32'
  : c <= 469 ? 'dbl'
  : c <= 481 ? 'str'
  : c === 999 ? 'str'
  : c === 1004 ? 'bin'
  : c <= 1009 ? 'str'
  : c <= 1059 ? 'dbl'
  : c <= 1070 ? 'i16'
  : 'i32';

/** True when the stream uses the pre-R13 single-byte group codes. */
export const isNarrowCodeBinaryDxf = (data: Uint8Array): boolean => {
  /* the first record is (0, "SECTION"): a wide code puts a second zero
     byte before the text, a narrow one starts the text straight away */
  const p = SENTINEL.length;
  return data.length > p + 1 && data[p] === 0 && data[p + 1] !== 0;
};

/** Decode binary DXF into (code, value-as-text) pairs. */
export const binaryDxfToPairs = (data: Uint8Array): [number, string][] => {
  const pairs: [number, string][] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const narrow = isNarrowCodeBinaryDxf(data);
  let p = SENTINEL.length;
  while (p + (narrow ? 1 : 2) <= data.length) {
    let code: number;
    if (narrow) {
      code = data[p++];
      if (code === 255) {                 /* escape to a wide code */
        if (p + 2 > data.length) return pairs;
        code = dv.getUint16(p, true);
        p += 2;
      }
    } else {
      code = dv.getUint16(p, true);
      p += 2;
    }
    switch (kindOf(code)) {
      case 'str': {
        let s = '';
        while (p < data.length && data[p] !== 0) {
          s += String.fromCharCode(data[p++]);
        }
        p++;
        pairs.push([code, s]);
        break;
      }
      case 'dbl':
        if (p + 8 > data.length) return pairs;
        pairs.push([code, String(dv.getFloat64(p, true))]);
        p += 8;
        break;
      case 'i16':
        if (p + 2 > data.length) return pairs;
        pairs.push([code, String(dv.getInt16(p, true))]);
        p += 2;
        break;
      case 'i32':
        if (p + 4 > data.length) return pairs;
        pairs.push([code, String(dv.getInt32(p, true))]);
        p += 4;
        break;
      case 'i64': {
        if (p + 8 > data.length) return pairs;
        const lo = dv.getUint32(p, true), hi = dv.getInt32(p + 4, true);
        pairs.push([code, String(hi * 0x100000000 + lo)]);
        p += 8;
        break;
      }
      case 'i8':
      case 'bool':
        if (p + 1 > data.length) return pairs;
        pairs.push([code, String(dv.getInt8(p))]);
        p += 1;
        break;
      case 'bin': {
        if (p >= data.length) return pairs;
        const len = data[p++];
        let hex = '';
        for (let i = 0; i < len && p < data.length; i++, p++) {
          hex += data[p].toString(16).padStart(2, '0').toUpperCase();
        }
        pairs.push([code, hex]);
        break;
      }
    }
  }
  return pairs;
};

/** Encode (code, value-as-text) pairs into binary DXF bytes.
 *  Pass `narrowCodes` for the pre-R13 single-byte form. */
export const pairsToBinaryDxf = (
  pairs: readonly [number, string][], narrowCodes = false
): Uint8Array => {
  const chunks: number[] = [];
  for (let i = 0; i < SENTINEL.length; i++) chunks.push(SENTINEL.charCodeAt(i));
  const scratch = new DataView(new ArrayBuffer(8));
  const push16 = (v: number): void => {
    scratch.setInt16(0, v, true);
    chunks.push(scratch.getUint8(0), scratch.getUint8(1));
  };
  const push32 = (v: number): void => {
    scratch.setInt32(0, v, true);
    for (let i = 0; i < 4; i++) chunks.push(scratch.getUint8(i));
  };
  for (const [code, value] of pairs) {
    if (narrowCodes && code < 255) {
      chunks.push(code);
    } else {
      if (narrowCodes) chunks.push(255);
      scratch.setUint16(0, code, true);
      chunks.push(scratch.getUint8(0), scratch.getUint8(1));
    }
    switch (kindOf(code)) {
      case 'str':
        for (let i = 0; i < value.length; i++) {
          chunks.push(value.charCodeAt(i) & 0xff);
        }
        chunks.push(0);
        break;
      case 'dbl': {
        scratch.setFloat64(0, parseFloat(value) || 0, true);
        for (let i = 0; i < 8; i++) chunks.push(scratch.getUint8(i));
        break;
      }
      case 'i16':
        push16(parseInt(value, 10) || 0);
        break;
      case 'i32':
        push32(parseInt(value, 10) || 0);
        break;
      case 'i64': {
        const v = parseInt(value, 10) || 0;
        push32(v >>> 0 === v ? v : v % 0x100000000);
        push32(Math.floor(v / 0x100000000));
        break;
      }
      case 'i8':
      case 'bool':
        chunks.push((parseInt(value, 10) || 0) & 0xff);
        break;
      case 'bin': {
        const n = Math.min(255, value.length >> 1);
        chunks.push(n);
        for (let i = 0; i < n; i++) {
          chunks.push(parseInt(value.slice(i * 2, i * 2 + 2), 16) || 0);
        }
        break;
      }
    }
  }
  return new Uint8Array(chunks);
};
