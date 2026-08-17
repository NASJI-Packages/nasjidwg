/* The AC1021-only rules, pinned. Every one of them was found with
 * AutoCAD 2027 as the oracle (campaign 9, `node tools/validate-external.mjs`)
 * and every one of them is invisible to a self round trip, so these tests
 * assert the writer's decisions rather than the round trip that hides them.
 * The byte-level truth lives in the external gate; what is pinned here is
 * that the writer keeps making the same decisions. */
import { describe, expect, it } from 'vitest';
import { emptyDrawing, readDwg, writeDwg2007, writeDwg2018 } from '../src/index.js';
import type { Drawing, Entity } from '../src/index.js';
import { readSections2007 } from '../src/dwg/sections2007.js';
import { readClasses } from '../src/dwg/classes.js';

const byLayer = { kind: 'byLayer' } as const;

/** A minimal binary kernel payload in either dialect: the magic the
 *  container keys off, then the end marker that bounds it. */
const blob = (dialect: 'ACIS' | 'ASM'): string => {
  const head = `${dialect} BinaryFile`;
  const end = dialect === 'ACIS'
    ? '\x0e\x03End\x0e\x02of\x0e\x04ACIS\r\x04data'
    : '\x0e\x03End\x0e\x02of\x0e\x03ASM\r\x04data';
  const body = `${head}${'\0'.repeat(9)}${end}`;
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
  return Buffer.from(bytes).toString('base64');
};

const withAcis = (over: Partial<Entity & { type: 'acis' }>): Drawing => {
  const d = emptyDrawing();
  d.entities = [{ type: 'acis', layer: '0', color: byLayer, kind: 'body', ...over } as Entity];
  return d;
};

describe('AC1021 (R2007) writer rules', () => {
  it('never emits an empty CLASSES payload', () => {
    /* AutoCAD 2027 refuses an AC1021 drawing whose CLASSES section is
       empty, exactly as it refuses an AC1032 one — the single reason a
       drawing with no application class at all would not open. */
    const secs = readSections2007(writeDwg2007(emptyDrawing()).data);
    const cls = secs.get('AcDb:Classes');
    expect(cls).toBeDefined();
    const parsed = readClasses(cls!, 'R2007');
    expect(parsed.size).toBeGreaterThan(0);
  });

  it('takes a pre-ASM kernel payload inline and gives it back', () => {
    const sab = blob('ACIS');
    const res = writeDwg2007(withAcis({ sab }));
    expect(res.skipped).toEqual([]);
    const back = readDwg(res.data);
    const e = back.entities.find((x) => x.type === 'acis');
    expect(e?.type).toBe('acis');
    if (e?.type !== 'acis') return;
    expect(e.sab).toBe(sab);
    expect(back.warnings).toEqual([]);
  });

  it('reports an ASM payload rather than writing one AC1021 cannot read', () => {
    /* AC1021's kernel reads only the pre-ASM binary form inline: the same
       drawing carrying an ASM stream is refused by AutoCAD 2027, while the
       ACIS-dialect one above opens at AUDIT 0. There is no faithful text
       form to fall back to, so the entity is reported. */
    const res = writeDwg2007(withAcis({ sab: blob('ASM') }));
    expect(res.skipped).toContain('acis(sab)');
    expect(readDwg(res.data).entities.some((e) => e.type === 'acis')).toBe(false);
  });

  it('still carries an ASM payload at AC1032, where the kernel reads it', () => {
    const res = writeDwg2018(withAcis({ sab: blob('ASM') }));
    expect(res.skipped).toEqual([]);
    expect(readDwg(res.data).entities.some((e) => e.type === 'acis')).toBe(true);
  });

  it('keeps the millisecond half of every date and both drawing GUIDs', () => {
    /* The day number alone floors to midnight, and the millisecond half is
       what tells two saves of one drawing apart; FINGERPRINTGUID and
       VERSIONGUID were stepped over entirely before. Read on every
       container that has them. */
    for (const write of [writeDwg2007, writeDwg2018]) {
      const vars = readDwg(write(emptyDrawing()).data).header.vars ?? {};
      for (const k of ['TDCREATE', 'TDUPDATE', 'TDINDWG', 'TDUSRTIMER']) {
        expect(typeof vars[k]).toBe('number');
        expect(typeof vars[`${k}_MS`]).toBe('number');
      }
      expect(String(vars.FINGERPRINTGUID)).toMatch(/^\{[0-9A-F-]{36}\}$/);
      expect(String(vars.VERSIONGUID)).toMatch(/^\{[0-9A-F-]{36}\}$/);
    }
  });

  it('writes a SAT body at AC1021 unchanged', () => {
    const sat = '400 0 1 0\nbody $-1 -1 $-1 $1 $-1 $-1 #\nEnd-of-ACIS-data\n';
    const res = writeDwg2007(withAcis({ sat }));
    expect(res.skipped).toEqual([]);
    const e = readDwg(res.data).entities.find((x) => x.type === 'acis');
    expect(e?.type === 'acis' && e.sat).toBe(sat);
  });
});
