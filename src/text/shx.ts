/* nasjidwg — AutoCAD SHX shape-font parser and vectorizer.
 *
 * Old drawings overwhelmingly reference compiled shape fonts (txt.shx,
 * romans.shx, isocp.shx …), and a viewer that substitutes a generic
 * outline font never quite looks like the plot. An SHX file is a tiny
 * stroke font: each glyph is a byte program that walks a pen around the
 * shape, and drawing text means executing those programs.
 *
 * File layout (classic shapes / normal fonts):
 *
 *   "AutoCAD-86 shapes 1.0" CR LF SUB      (1.1 for the later compiler)
 *   u16 first shape number  (little-endian, like every u16 here)
 *   u16 last shape number
 *   u16 number of shapes
 *   directory: number-of-shapes × { u16 shape number, u16 defbytes }
 *   data blocks in directory order, each defbytes long:
 *     name as ASCIIZ, then the shape bytecode, terminated by 0x00
 *
 * Shape 0 is not a glyph but the font description: its name is the font
 * name and its bytes are (above, below, modes) — cap height above the
 * baseline, descender depth below it, and the orientation modes byte
 * (0 horizontal, 2 dual).
 *
 * Unifont form ("AutoCAD-86 unifont 1.0"): glyphs are keyed by Unicode
 * code point and there is no separate directory — after the header comes
 * a u32 record count, then that many inline records of
 * { u16 code, u16 defbytes, data }. Record 0 is the font description
 * (name ASCIIZ, then above, below, modes, encoding, embedding type, 0).
 * Subshape references inside unifont bytecode are two bytes wide.
 *
 * Bytecode. A byte with a non-zero high nibble is a vector: high nibble
 * is the length, low nibble indexes the 16-direction table below (the
 * eight primary directions plus the half-slope diagonals; the diagonal
 * vectors are full length in both components, so direction 2 at length 1
 * really moves (1,1)). A byte 0x00–0x0E is a command:
 *
 *   0x00 end of shape
 *   0x01 pen down            0x02 pen up
 *   0x03 divide the vector scale by the next byte
 *   0x04 multiply the vector scale by the next byte
 *   0x05 push the pen location (stack of 4)
 *   0x06 pop the pen location (a teleport — nothing is drawn)
 *   0x07 draw subshape; number is the next byte (u16 in unifont)
 *   0x08 move (dx, dy), signed bytes
 *   0x09 sequence of (dx, dy) pairs, terminated by (0, 0)
 *   0x0A octant arc: radius byte, then a flags byte — high bit set means
 *        clockwise, bits 6–4 the starting octant (octant 0 = east, 45°
 *        steps counter-clockwise), bits 2–0 the octant span (0 = full
 *        circle). The pen sits on the arc's start point; the centre lies
 *        radius away opposite the start angle.
 *   0x0B fractional arc: 5 bytes — start offset, end offset (each in
 *        1/256ths of 45° past an octant boundary), radius high byte,
 *        radius low byte, then the same flags byte as 0x0A where the span
 *        counts the octants the arc touches
 *   0x0C bulge arc: (dx, dy, bulge) signed bytes; bulge/127 is the DXF
 *        polyline bulge (tan of a quarter of the included angle,
 *        negative = clockwise)
 *   0x0D sequence of bulge arcs, terminated by a (0, 0) displacement
 *        which is NOT followed by a bulge byte
 *   0x0E next command applies to vertical text only — when rendering
 *        horizontally (as we do) the following command is consumed and
 *        ignored entirely
 *
 * Glyphs come out as polylines in shape units, y up, the baseline at
 * y = 0; arcs are tessellated at roughly 16 segments per full circle.
 * The pen's final position is the advance to the next character — SHX
 * fonts carry no separate width table.
 */

import type { Point2, TextEntity, MTextEntity, TextStyle } from '../core/model.js';
import { shapeArabic, mirrorBrackets } from './arabic.js';

export interface ShxGlyph {
  /** Pen travel to the next character's origin, in shape units. */
  advance: number;
  /** Pen-down strokes as polylines in shape units, y up. */
  paths: { x: number; y: number }[][];
}

export interface ShxFont {
  name: string;
  /** Cap height above the baseline (shape 0). */
  above: number;
  /** Descender depth below the baseline (shape 0). */
  below: number;
  /** Vectorized glyph for a code point; cached. */
  glyph(code: number): ShxGlyph | undefined;
}

const TAU = Math.PI * 2;
const OCTANT = Math.PI / 4;

/* The 16-direction vector table. Directions step counter-clockwise from
 * east in 22.5°-ish increments; the in-between directions keep the long
 * component at full length and halve the short one, which is why SHX
 * diagonals are longer than their nominal length. */
const DIR: readonly Point2[] = [
  { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 1, y: 1 }, { x: 0.5, y: 1 },
  { x: 0, y: 1 }, { x: -0.5, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0.5 },
  { x: -1, y: 0 }, { x: -1, y: -0.5 }, { x: -1, y: -1 }, { x: -0.5, y: -1 },
  { x: 0, y: -1 }, { x: 0.5, y: -1 }, { x: 1, y: -1 }, { x: 1, y: -0.5 }
];

const i8 = (b: number): number => (b > 127 ? b - 256 : b);

/* ------------------------------------------------------------------ *
 * bytecode interpreter
 * ------------------------------------------------------------------ */

interface PenState {
  x: number; y: number;
  scale: number;
  down: boolean;
  stack: Point2[];
  paths: Point2[][];
  cur: Point2[];
}

const flush = (st: PenState): void => {
  if (st.cur.length > 1) st.paths.push(st.cur);
  st.cur = [];
};

/** Draw (pen down) or move (pen up) to an absolute point. */
const penTo = (st: PenState, nx: number, ny: number): void => {
  if (st.down) {
    if (!st.cur.length) st.cur.push({ x: st.x, y: st.y });
    st.cur.push({ x: nx, y: ny });
  } else {
    flush(st);
  }
  st.x = nx; st.y = ny;
};

/** Tessellate an arc about (cx, cy) from angle a0 sweeping `sweep`
 *  radians (sign = direction), ~16 segments per full circle. */
const arcTo = (
  st: PenState, cx: number, cy: number, r: number, a0: number, sweep: number
): void => {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (TAU / 16)));
  for (let k = 1; k <= n; k++) {
    const a = a0 + sweep * (k / n);
    penTo(st, cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
};

/** An arc whose start point is the current pen location: the centre is
 *  radius away, opposite the start angle. */
const arcFromPen = (
  st: PenState, r: number, a0: number, sweep: number
): void => {
  if (r <= 0) return;
  arcTo(st, st.x - r * Math.cos(a0), st.y - r * Math.sin(a0), r, a0, sweep);
};

/** Displacement with a DXF-style bulge (same convention as the polyline
 *  flattener in core/geo.ts: positive bulge sweeps counter-clockwise). */
const bulgeTo = (st: PenState, nx: number, ny: number, bulge: number): void => {
  const dist = Math.hypot(nx - st.x, ny - st.y);
  if (!bulge || dist < 1e-12 || !st.down) { penTo(st, nx, ny); return; }
  const theta = 4 * Math.atan(bulge);
  const radius = dist / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (st.x + nx) / 2, my = (st.y + ny) / 2;
  const perp = (Math.abs(theta) > Math.PI ? -1 : 1) * Math.sign(bulge);
  const h = Math.sqrt(Math.max(0, radius * radius - (dist / 2) ** 2)) * perp;
  const cx = mx - (h * (ny - st.y)) / dist;
  const cy = my + (h * (nx - st.x)) / dist;
  const a0 = Math.atan2(st.y - cy, st.x - cx);
  arcTo(st, cx, cy, radius, a0, theta);
  /* land exactly on the endpoint, trig wobble and all */
  if (st.cur.length) st.cur[st.cur.length - 1] = { x: nx, y: ny };
  st.x = nx; st.y = ny;
};

/** Execute one shape program. `skip-next` (0x0E) consumes the following
 *  command without executing it — we only render horizontal text. */
const run = (
  shapes: Map<number, Uint8Array>, data: Uint8Array,
  st: PenState, unifont: boolean, depth: number
): void => {
  let i = 0;
  let skip = false;
  const at = (k: number): number => data[k] ?? 0;
  while (i < data.length) {
    const b = data[i++];
    if (b >= 0x10) {
      /* vector byte: high nibble length, low nibble direction */
      if (!skip) {
        const len = (b >> 4) * st.scale;
        const d = DIR[b & 0x0f];
        penTo(st, st.x + d.x * len, st.y + d.y * len);
      }
      skip = false;
      continue;
    }
    switch (b) {
      case 0x00:
        return;
      case 0x01: if (!skip) st.down = true; break;
      case 0x02: if (!skip) { flush(st); st.down = false; } break;
      case 0x03: { const n = at(i++); if (!skip && n) st.scale /= n; break; }
      case 0x04: { const n = at(i++); if (!skip && n) st.scale *= n; break; }
      case 0x05:
        if (!skip && st.stack.length < 4) st.stack.push({ x: st.x, y: st.y });
        break;
      case 0x06:
        if (!skip) {
          const p = st.stack.pop();
          if (p) { flush(st); st.x = p.x; st.y = p.y; }
        }
        break;
      case 0x07: {
        const sub = unifont ? (at(i) << 8) | at(i + 1) : at(i);
        i += unifont ? 2 : 1;
        if (!skip && depth < 8) {
          const prog = shapes.get(sub);
          if (prog) run(shapes, prog, st, unifont, depth + 1);
        }
        break;
      }
      case 0x08: {
        const dx = i8(at(i++)), dy = i8(at(i++));
        if (!skip) penTo(st, st.x + dx * st.scale, st.y + dy * st.scale);
        break;
      }
      case 0x09:
        for (;;) {
          if (i >= data.length) break;
          const dx = i8(at(i++)), dy = i8(at(i++));
          if (!dx && !dy) break;
          if (!skip) penTo(st, st.x + dx * st.scale, st.y + dy * st.scale);
        }
        break;
      case 0x0a: {
        const r = at(i++) * st.scale;
        const f = at(i++);
        if (!skip) {
          const span = (f & 7) || 8;
          const a0 = ((f >> 4) & 7) * OCTANT;
          arcFromPen(st, r, a0, (f & 0x80 ? -1 : 1) * span * OCTANT);
        }
        break;
      }
      case 0x0b: {
        const so = at(i++), eo = at(i++);
        const r = ((at(i++) << 8) | at(i++)) * st.scale;
        const f = at(i++);
        if (!skip) {
          /* offsets are 1/256ths of an octant past a boundary; the span
             counts the octants the arc touches, so the magnitude is
             (span-1) whole octants plus the end fraction (a zero end
             offset means the arc runs to the final boundary), minus the
             start fraction */
          const span = (f & 7) || 8;
          const dir = f & 0x80 ? -1 : 1;
          const soA = (so / 256) * OCTANT;
          const eoA = eo ? (eo / 256) * OCTANT : OCTANT;
          const sweep = (span - 1) * OCTANT + eoA - soA;
          const a0 = ((f >> 4) & 7) * OCTANT + dir * soA;
          arcFromPen(st, r, a0, dir * sweep);
        }
        break;
      }
      case 0x0c: {
        const dx = i8(at(i++)), dy = i8(at(i++)), bg = i8(at(i++));
        if (!skip) {
          bulgeTo(st, st.x + dx * st.scale, st.y + dy * st.scale, bg / 127);
        }
        break;
      }
      case 0x0d:
        for (;;) {
          if (i >= data.length) break;
          const dx = i8(at(i++)), dy = i8(at(i++));
          if (!dx && !dy) break;        /* terminator carries no bulge byte */
          const bg = i8(at(i++));
          if (!skip) {
            bulgeTo(st, st.x + dx * st.scale, st.y + dy * st.scale, bg / 127);
          }
        }
        break;
      case 0x0e:
        if (!skip) { skip = true; continue; }
        break;
      default:
        return;                         /* 0x0F is not a command; stop */
    }
    skip = false;
  }
};

const vectorize = (
  shapes: Map<number, Uint8Array>, code: number, unifont: boolean
): ShxGlyph | undefined => {
  const data = shapes.get(code);
  if (!data) return undefined;
  const st: PenState = {
    x: 0, y: 0, scale: 1, down: true, stack: [], paths: [], cur: []
  };
  try {
    run(shapes, data, st, unifont, 0);
  } catch {
    return undefined;
  }
  flush(st);
  return { advance: st.x, paths: st.paths };
};

/* ------------------------------------------------------------------ *
 * file parsing
 * ------------------------------------------------------------------ */

const readU16 = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);

/** ASCIIZ starting at `i`, bounded by `end`; returns [text, next index]. */
const readAsciiz = (
  b: Uint8Array, i: number, end: number
): [string, number] => {
  let s = '';
  while (i < end && b[i] !== 0) s += String.fromCharCode(b[i++]);
  return [s, i + 1];
};

/** Parse an SHX file. Returns null for anything that is not one — a
 *  foreign or truncated buffer never throws. */
export const parseShx = (bytes: Uint8Array): ShxFont | null => {
  try {
    return parseShxInner(bytes);
  } catch {
    return null;
  }
};

const parseShxInner = (bytes: Uint8Array): ShxFont | null => {
  /* the header is ASCII up to the 0x1A sentinel */
  let sentinel = -1;
  const scanEnd = Math.min(bytes.length, 40);
  for (let i = 0; i < scanEnd; i++) {
    if (bytes[i] === 0x1a) { sentinel = i; break; }
  }
  if (sentinel < 0) return null;
  let header = '';
  for (let i = 0; i < sentinel; i++) header += String.fromCharCode(bytes[i]);
  const unifont = header.startsWith('AutoCAD-86 unifont 1.');
  if (!unifont && !header.startsWith('AutoCAD-86 shapes 1.')) return null;

  const shapes = new Map<number, Uint8Array>();
  let fontName = '';
  let above = 0, below = 0;
  const takeRecord = (code: number, start: number, defbytes: number): void => {
    const end = start + defbytes;
    const [name, dataStart] = readAsciiz(bytes, start, end);
    const data = bytes.subarray(Math.min(dataStart, end), end);
    if (code === 0) {
      /* the font-description pseudo-shape: name + (above, below, modes) */
      fontName = name;
      above = data[0] ?? 0;
      below = data[1] ?? 0;
    } else {
      shapes.set(code, data);
    }
  };

  let pos = sentinel + 1;
  if (unifont) {
    /* u32 record count, then inline { u16 code, u16 defbytes, data } */
    if (pos + 4 > bytes.length) return null;
    const count = readU16(bytes, pos) | (readU16(bytes, pos + 2) << 16);
    pos += 4;
    if (count <= 0 || count > 0x110000) return null;
    for (let k = 0; k < count; k++) {
      if (pos + 4 > bytes.length) return null;
      const code = readU16(bytes, pos);
      const defbytes = readU16(bytes, pos + 2);
      pos += 4;
      if (pos + defbytes > bytes.length) return null;
      takeRecord(code, pos, defbytes);
      pos += defbytes;
    }
  } else {
    /* range header, directory, then the data blocks in directory order */
    if (pos + 6 > bytes.length) return null;
    const count = readU16(bytes, pos + 4);
    pos += 6;
    if (count <= 0 || count > 0x10000) return null;
    if (pos + count * 4 > bytes.length) return null;
    const dir: { code: number; defbytes: number }[] = [];
    for (let k = 0; k < count; k++) {
      dir.push({ code: readU16(bytes, pos), defbytes: readU16(bytes, pos + 2) });
      pos += 4;
    }
    for (const entry of dir) {
      if (pos + entry.defbytes > bytes.length) return null;
      takeRecord(entry.code, pos, entry.defbytes);
      pos += entry.defbytes;
    }
  }
  if (!shapes.size) return null;

  const cache = new Map<number, ShxGlyph | undefined>();
  return {
    name: fontName,
    above,
    below,
    glyph: (code: number): ShxGlyph | undefined => {
      if (cache.has(code)) return cache.get(code);
      const g = vectorize(shapes, code, unifont);
      cache.set(code, g);
      return g;
    }
  };
};

/* ------------------------------------------------------------------ *
 * font registry
 * ------------------------------------------------------------------ */

/* Exporters cannot read font files themselves (no filesystem in src/):
 * the application hands in the bytes once and the exporters look fonts
 * up by the style's font name — case-insensitive, path and .shx
 * extension optional. */
const REGISTRY = new Map<string, ShxFont>();

const fontKey = (name: string): string => {
  let n = name.trim().toLowerCase();
  const cut = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
  if (cut >= 0) n = n.slice(cut + 1);
  if (n.endsWith('.shx')) n = n.slice(0, -4);
  return n;
};

/** Parse and register a font under its own name plus any aliases.
 *  Returns the font, or null when the bytes are not an SHX file. */
export const registerShxFont = (
  bytes: Uint8Array, names?: string[]
): ShxFont | null => {
  const font = parseShx(bytes);
  if (!font) return null;
  for (const n of [font.name, ...(names ?? [])]) {
    const key = n && fontKey(n);
    if (key) REGISTRY.set(key, font);
  }
  return font;
};

/** Look a registered font up by a text style's font file name. */
export const findShxFont = (styleFontName?: string): ShxFont | undefined =>
  styleFontName ? REGISTRY.get(fontKey(styleFontName)) : undefined;

/* ------------------------------------------------------------------ *
 * text layout for the exporters
 * ------------------------------------------------------------------ */

const RTL_RE = /[֐-߿ࢠ-ࣿיִ-﷿ﹰ-ﻼ]/;

/** Logical to naive visual order for RTL lines: the whole line reverses,
 *  then embedded Latin/digit runs get their internal order back. (Full
 *  UAX#9 is out of scope for a stroke renderer.) */
const toVisual = (line: string): string => {
  if (!RTL_RE.test(line)) return line;
  const chars = Array.from(line).reverse();
  const isLtr = (c: string): boolean => /[0-9A-Za-z]/.test(c);
  for (let i = 0; i < chars.length; i++) {
    if (!isLtr(chars[i])) continue;
    let j = i;
    while (j + 1 < chars.length && isLtr(chars[j + 1])) j++;
    for (let a = i, b = j; a < b; a++, b--) {
      const t = chars[a]; chars[a] = chars[b]; chars[b] = t;
    }
    i = j;
  }
  return chars.join('');
};

export interface ShxTextOptions {
  height: number;
  rotation?: number;                    /* radians */
  widthFactor?: number;
  oblique?: number;                     /* radians */
  halign?: string;                      /* left | center | middle | right */
  valign?: string;                      /* baseline | bottom | middle | top */
  /** Baseline-to-baseline distance in text heights. Default 1.25. */
  lineSpacing?: number;
}

/** Lay a text string out as world-space stroke polylines from an SHX
 *  font: position, height (scale = height / above), rotation, width
 *  factor and oblique applied; '\n' starts a new line below. Arabic is
 *  shaped (joined presentation forms) before glyph lookup so it hits the
 *  font's codes. Returns null when ANY code point lacks a glyph — the
 *  caller falls back to its plain text rendering for the whole string,
 *  never a half-and-half mix. */
export const renderShxText = (
  font: ShxFont, text: string, position: Point2, opts: ShxTextOptions
): Point2[][] | null => {
  const above = font.above > 0 ? font.above : 1;
  const s = (opts.height > 0 ? opts.height : 1) / above;
  const wf = opts.widthFactor && opts.widthFactor > 0 ? opts.widthFactor : 1;
  const shear = Math.tan(opts.oblique ?? 0);
  const rot = opts.rotation ?? 0;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const lineStep = (opts.lineSpacing ?? 1.25) * (opts.height > 0 ? opts.height : 1);
  const vShift = opts.valign === 'top' ? -above * s
    : opts.valign === 'middle' ? -above * s / 2
      : opts.valign === 'bottom' ? font.below * s : 0;

  const world: Point2[][] = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    /* Arabic: mirror brackets, bake the joining into presentation forms,
       then flip the line to visual order — we place glyphs left to
       right ourselves. */
    const visual = toVisual(shapeArabic(mirrorBrackets(lines[li], false)));
    const placed: { path: ShxGlyph['paths'][number]; penX: number }[] = [];
    let penX = 0;
    for (const ch of visual) {
      const cp = ch.codePointAt(0)!;
      const g = font.glyph(cp);
      if (!g) {
        /* a space is pure advance — synthesize one when the font has no
           shape 32; any other miss fails the whole string */
        if (cp === 0x20 || cp === 0x09) { penX += above; continue; }
        return null;
      }
      for (const p of g.paths) placed.push({ path: p, penX });
      penX += g.advance;
    }
    /* horizontal anchor works on the finished line width */
    const lineW = penX * s * wf;
    const ax = opts.halign === 'center' || opts.halign === 'middle' ? -lineW / 2
      : opts.halign === 'right' ? -lineW : 0;
    const y0 = vShift - li * lineStep;
    for (const { path, penX: px } of placed) {
      const pts: Point2[] = [];
      for (const p of path) {
        const lx = ax + ((px + p.x) * wf + p.y * shear) * s;
        const ly = y0 + p.y * s;
        pts.push({
          x: position.x + lx * cos - ly * sin,
          y: position.y + lx * sin + ly * cos
        });
      }
      if (pts.length > 1) world.push(pts);
    }
  }
  return world;
};

/** The exporters' one-call hook: resolve a TEXT/MTEXT entity's style
 *  against the registry and lay its text out. Null when the style's font
 *  is not registered or a glyph is missing — the caller keeps its
 *  existing rendering, so without registered fonts nothing changes. */
export const shxTextStrokes = (
  entity: TextEntity | MTextEntity, styles: readonly TextStyle[]
): Point2[][] | null => {
  const styleName = (entity.style ?? 'Standard').toLowerCase();
  const rec = styles.find((st) => st.name.toLowerCase() === styleName);
  const font = findShxFont(rec?.font);
  if (!font) return null;
  const isText = entity.type === 'text';
  return renderShxText(font, entity.text, entity.position, {
    height: entity.height > 0 ? entity.height : 5,
    rotation: entity.rotation ?? 0,
    widthFactor: (isText ? entity.widthFactor : undefined) ?? rec?.widthFactor,
    oblique: isText ? entity.oblique : undefined,
    halign: isText ? entity.halign : undefined,
    valign: isText ? entity.valign : undefined
  });
};
