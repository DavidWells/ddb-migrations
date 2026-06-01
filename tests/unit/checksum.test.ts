import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checksumDirectory, checksumFile } from '../../src/lib/checksum.js';

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

describe('checksumDirectory', () => {
  it('returns a stable digest over nested files', async () => {
    const d = path.join(dir, 'nested-migration');
    mkdirSync(path.join(d, 'fixtures'), { recursive: true });
    writeFileSync(path.join(d, 'index.ts'), 'export async function up() {}');
    writeFileSync(path.join(d, 'fixtures', 'data.json'), '{"ok":true}');

    const a = await checksumDirectory(d);
    const b = await checksumDirectory(d);

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any nested file changes', async () => {
    const d = path.join(dir, 'driftable-migration');
    mkdirSync(d, { recursive: true });
    const fixture = path.join(d, 'fixture.json');
    writeFileSync(path.join(d, 'index.ts'), 'export async function up() {}');
    writeFileSync(fixture, '{"version":1}');

    const before = await checksumDirectory(d);
    writeFileSync(fixture, '{"version":2}');
    const after = await checksumDirectory(d);

    expect(after).not.toBe(before);
  });
});
