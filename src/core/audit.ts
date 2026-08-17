/* nasjidwg — the auditor: this library's own AUDIT command.
 *
 * A drawing that came out of a damaged file, a buggy producer or a
 * careless edit should be able to say so itself, before a CAD package
 * has to. auditDrawing walks the whole document model and reports what
 * a repair pass would have to touch: handles that collide, names that
 * resolve to nothing, geometry that is not a number. It only reports —
 * the drawing is never modified — and it never throws, because an
 * auditor that crashes on a broken drawing is useless on exactly the
 * drawings that need it.
 */

import type { Drawing, Entity } from './model.js';
import { drawingBounds } from './geo.js';

export interface AuditFinding {
  severity: 'error' | 'warning' | 'info';
  /** Stable machine-readable identifier, e.g. 'duplicate-handle'. */
  code: string;
  /** A human sentence naming the exact object at fault. */
  message: string;
  /** Handle of the offending object, when one is known. */
  handle?: string;
}

const RANK: Record<AuditFinding['severity'], number> = {
  error: 0, warning: 1, info: 2
};

/* Names that mean "inherit", not "look me up in a table". */
const INHERITED = new Set(['bylayer', 'byblock', 'continuous']);

/** Handles compare as hex values: case and leading zeros do not count. */
const normHandle = (h: unknown): string | undefined => {
  if (typeof h !== 'string' || h === '') return undefined;
  return h.toUpperCase().replace(/^0+(?=.)/, '');
};

/** Lower-cased names of a table, surviving a malformed one. */
const namesOf = (table: unknown): Set<string> => {
  const out = new Set<string>();
  if (Array.isArray(table)) {
    for (const row of table) {
      const name = (row as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && name) out.add(name.toLowerCase());
    }
  }
  return out;
};

/** A point that can actually be compared: x and y must be numbers. */
const pointOf = (p: unknown): { x: number; y: number; z: number } | null => {
  if (!p || typeof p !== 'object') return null;
  const q = p as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof q.x !== 'number' || typeof q.y !== 'number') return null;
  return { x: q.x, y: q.y, z: typeof q.z === 'number' ? q.z : 0 };
};

/** True when any number reachable inside the value is NaN or infinite.
 *  The walk mirrors the model's JSON shape: arrays and plain objects are
 *  descended, strings are not numbers, and byte payloads (Uint8Array and
 *  friends) cannot hold either value so they are skipped rather than
 *  scanned. A visited set keeps even a cyclic object from recursing. */
const hasNonFinite = (value: unknown, seen: Set<object>): boolean => {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (ArrayBuffer.isView(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) if (hasNonFinite(v, seen)) return true;
    return false;
  }
  for (const k of Object.keys(value)) {
    if (hasNonFinite((value as Record<string, unknown>)[k], seen)) return true;
  }
  return false;
};

/** One entity plus the container it lives in, for messages. */
interface Placed { ent: Entity; where: string }

/** Audit a drawing: every finding a repair pass would act on, errors
 *  first, then warnings, then informational notes. Never throws. */
export const auditDrawing = (d: Drawing): AuditFinding[] => {
  const findings: AuditFinding[] = [];
  const add = (
    severity: AuditFinding['severity'], code: string, message: string,
    handle?: string
  ): void => {
    findings.push(handle
      ? { severity, code, message, handle } : { severity, code, message });
  };
  /* A finding the auditor failed to make is better than an exception the
     caller has to survive: every check runs under this. */
  const guard = (check: () => void): void => {
    try { check(); } catch { /* a broken drawing must not break the audit */ }
  };

  if (!d || typeof d !== 'object') return findings;
  try {

    /* ---- the drawing, flattened into (entity, container) pairs ---- */
    const placed: Placed[] = [];
    guard(() => {
      const push = (list: unknown, where: string): void => {
        if (!Array.isArray(list)) return;
        for (const e of list) {
          if (e && typeof e === 'object') placed.push({ ent: e as Entity, where });
        }
      };
      push(d.entities, 'model space');
      push(d.paperSpace, 'paper space');
      if (d.blocks && typeof d.blocks === 'object') {
        for (const name of Object.keys(d.blocks)) {
          push((d.blocks as Record<string, { entities?: unknown } | undefined>)
            [name]?.entities, `block "${name}"`);
        }
      }
    });

    const typeOf = (e: Entity): string =>
      typeof e.type === 'string' ? e.type : 'entity';
    const describe = (p: Placed): string => {
      const h = normHandle(p.ent.handle);
      return `${typeOf(p.ent)}${h ? ` (handle ${h})` : ''} in ${p.where}`;
    };
    const handleOf = (p: Placed): string | undefined =>
      typeof p.ent.handle === 'string' && p.ent.handle ? p.ent.handle : undefined;

    /* Every handle an entity carries — including nested attribute and
       proxy-graphics entities — plus the dictionary objects' own, form
       the universe handle references are resolved against. */
    const entityHandles = new Set<string>();
    const knownHandles = new Set<string>();
    guard(() => {
      const visit = (e: unknown, depth: number): void => {
        if (!e || typeof e !== 'object' || depth > 8) return;
        const h = normHandle((e as Entity).handle);
        if (h) entityHandles.add(h);
        const sub = e as { attributes?: unknown; graphics?: unknown };
        for (const list of [sub.attributes, sub.graphics]) {
          if (Array.isArray(list)) for (const c of list) visit(c, depth + 1);
        }
      };
      for (const p of placed) visit(p.ent, 0);
      for (const h of entityHandles) knownHandles.add(h);
      for (const list of [d.xrecords, d.proxyObjects]) {
        if (!Array.isArray(list)) continue;
        for (const r of list) {
          const h = normHandle((r as { handle?: unknown } | null)?.handle);
          if (h) knownHandles.add(h);
        }
      }
    });

    const layerNames = namesOf(d.layers);
    const linetypeNames = namesOf(d.linetypes);
    const textStyleNames = namesOf(d.textStyles);
    const dimStyleNames = namesOf(d.dimStyles);
    const blockNames = new Set<string>();
    guard(() => {
      if (d.blocks && typeof d.blocks === 'object') {
        for (const key of Object.keys(d.blocks)) blockNames.add(key.toLowerCase());
      }
    });

    /* ---- duplicate-handle: two objects claiming the same identity ---- */
    guard(() => {
      const byHandle = new Map<string, Placed[]>();
      for (const p of placed) {
        const h = normHandle(p.ent.handle);
        if (!h) continue;
        const hit = byHandle.get(h);
        if (hit) hit.push(p); else byHandle.set(h, [p]);
      }
      for (const [h, group] of byHandle) {
        if (group.length < 2) continue;
        const list = group.map((p) => `${typeOf(p.ent)} in ${p.where}`).join(', ');
        add('error', 'duplicate-handle',
          `${group.length} entities share handle ${h}: ${list}`, h);
      }
    });

    /* ---- names an entity uses that no table defines ---- */
    guard(() => {
      for (const p of placed) {
        const e = p.ent;
        const layer = typeof e.layer === 'string' ? e.layer : '';
        if (layer && !INHERITED.has(layer.toLowerCase())
            && !layerNames.has(layer.toLowerCase())) {
          add('warning', 'dangling-layer',
            `${describe(p)} lies on layer "${layer}", which is not in the layer table`,
            handleOf(p));
        }
        const lt = typeof e.linetype === 'string' ? e.linetype : '';
        if (lt && !INHERITED.has(lt.toLowerCase())
            && !linetypeNames.has(lt.toLowerCase())) {
          add('warning', 'dangling-linetype',
            `${describe(p)} uses linetype "${lt}", which is not in the linetype table`,
            handleOf(p));
        }
        if (e.type === 'insert' && typeof e.blockName === 'string' && e.blockName
            && !blockNames.has(e.blockName.toLowerCase())) {
          add('error', 'dangling-block',
            `${describe(p)} references block "${e.blockName}", which has no definition`,
            handleOf(p));
        }
        if ((e.type === 'text' || e.type === 'mtext')
            && typeof e.style === 'string' && e.style
            && !textStyleNames.has(e.style.toLowerCase())) {
          add('warning', 'dangling-style',
            `${describe(p)} uses text style "${e.style}", which is not in the style table`,
            handleOf(p));
        }
        if (e.type === 'dimension' && typeof e.style === 'string' && e.style
            && !dimStyleNames.has(e.style.toLowerCase())) {
          add('warning', 'dangling-style',
            `${describe(p)} uses dimension style "${e.style}", which is not in the dimension style table`,
            handleOf(p));
        }
      }
    });

    /* ---- dangling-ref: informational by design. A proxy's references
       legitimately point at objects its owning application keeps outside
       this model, so an unresolved one is a note, never a defect. ---- */
    guard(() => {
      const report = (
        owner: string, ownerHandle: string | undefined, refs: unknown
      ): void => {
        if (!Array.isArray(refs)) return;
        const seen = new Set<string>();
        for (const r of refs) {
          const v = normHandle((r as { value?: unknown } | null)?.value);
          if (!v || v === '0' || knownHandles.has(v) || seen.has(v)) continue;
          seen.add(v);
          add('info', 'dangling-ref',
            `${owner} references handle ${v}, which matches nothing in this drawing`,
            ownerHandle);
        }
      };
      for (const p of placed) {
        if (p.ent.type === 'proxy') report(describe(p), handleOf(p), p.ent.refs);
      }
      if (Array.isArray(d.proxyObjects)) {
        for (const po of d.proxyObjects) {
          if (!po || typeof po !== 'object') continue;
          const nm = typeof po.name === 'string' && po.name ? ` "${po.name}"` : '';
          report(`proxy object${nm}`,
            typeof po.handle === 'string' && po.handle ? po.handle : undefined,
            po.refs);
        }
      }
    });

    /* ---- group-member-missing: a group naming a member that is gone ---- */
    guard(() => {
      if (!Array.isArray(d.groups)) return;
      for (const g of d.groups) {
        if (!g || typeof g !== 'object' || !Array.isArray(g.entityHandles)) continue;
        const gname = typeof g.name === 'string' ? g.name : '?';
        for (const member of g.entityHandles) {
          const h = normHandle(member);
          if (!h || entityHandles.has(h)) continue;
          add('warning', 'group-member-missing',
            `group "${gname}" lists member handle ${h}, but no entity carries it`, h);
        }
      }
    });

    /* ---- non-finite-geometry: NaN or infinity anywhere in an entity ---- */
    guard(() => {
      for (const p of placed) {
        if (hasNonFinite(p.ent, new Set())) {
          add('error', 'non-finite-geometry',
            `${describe(p)} carries a NaN or infinite number in its data`,
            handleOf(p));
        }
      }
    });

    /* ---- empty-block: defined but drawing nothing. Layout blocks are
       containers whose content lives elsewhere in the model, so empty is
       their normal state and they are not reported. ---- */
    guard(() => {
      if (!d.blocks || typeof d.blocks !== 'object') return;
      for (const [name, def] of Object.entries(d.blocks)) {
        if (!def || typeof def !== 'object' || def.isLayout) continue;
        const n = Array.isArray(def.entities) ? def.entities.length : 0;
        if (n === 0) add('info', 'empty-block', `block "${name}" defines no entities`);
      }
    });

    /* ---- header extents: collapsed, or disagreeing with the model ---- */
    guard(() => {
      const min = pointOf(d.header?.extMin);
      const max = pointOf(d.header?.extMax);
      if (!min || !max) return;
      if (min.x === max.x && min.y === max.y && min.z === max.z) {
        add('info', 'zero-extent',
          `header extents collapse to the single point (${min.x}, ${min.y}, ${min.z})`);
      }
      const b = drawingBounds(d);
      if (!b) return;
      const eps = 1e-6;
      if (b.min.x < min.x - eps || b.min.y < min.y - eps
          || b.max.x > max.x + eps || b.max.y > max.y + eps) {
        const r = (n: number): string => String(Math.round(n * 1e6) / 1e6);
        add('info', 'header-extents-mismatch',
          `model geometry spans ${r(b.min.x)},${r(b.min.y)} .. ${r(b.max.x)},${r(b.max.y)}, `
          + `outside the header extents ${r(min.x)},${r(min.y)} .. ${r(max.x)},${r(max.y)}`);
      }
    });

    /* ---- duplicate-table-entry: one name, two records ---- */
    guard(() => {
      const tables: [string, unknown][] = [
        ['layer', d.layers], ['linetype', d.linetypes],
        ['text style', d.textStyles]
      ];
      for (const [label, table] of tables) {
        if (!Array.isArray(table)) continue;
        const counts = new Map<string, { display: string; n: number }>();
        for (const row of table) {
          const name = (row as { name?: unknown } | null)?.name;
          if (typeof name !== 'string' || !name) continue;
          const key = name.toLowerCase();
          const hit = counts.get(key);
          if (hit) hit.n++; else counts.set(key, { display: name, n: 1 });
        }
        for (const { display, n } of counts.values()) {
          if (n > 1) {
            add('warning', 'duplicate-table-entry',
              `the ${label} table lists "${display}" ${n} times`);
          }
        }
      }
    });

  } catch { /* even a hostile object yields a report, not a crash */ }

  /* Errors first, then warnings, then notes; sort is stable, so findings
     of one severity keep the order the checks produced them in. */
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return findings;
};
