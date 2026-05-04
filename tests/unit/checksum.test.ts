import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checksumFile } from '../../src/lib/checksum.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-cks-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('checksumFile', () => {
  it('returns a stable sha256 hex digest', async () => {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'hello');
    const a = await checksumFile(f);
    const b = await checksumFile(f);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when contents change', async () => {
    const f = path.join(dir, 'b.txt');
    writeFileSync(f, 'one');
    const before = await checksumFile(f);
    writeFileSync(f, 'two');
    const after = await checksumFile(f);
    expect(after).not.toBe(before);
  });
});
