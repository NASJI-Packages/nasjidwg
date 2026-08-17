/* nasjidwg — command line tools. */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDrawing, runCli } from '../src/cli.js';
import { readDwg } from '../src/dwg/reader.js';

const OUT = mkdtempSync(join(tmpdir(), 'nasjidwg-cli-'));

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/** Run the CLI, capturing what it wrote to stdout/stderr. */
const run = (...args: string[]) => {
  let out = '', err = '';
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out += String(c);
    return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err += String(c);
    return true;
  });
  try {
    const code = runCli(args);
    return { code, out, err };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
};

describe('nasjidwg help', () => {
  it('prints usage for --help and for an unknown command', () => {
    expect(run('--help').out).toContain('nasjidwg info');
    expect(run('nonsense').code).toBe(2);
  });
});
