import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMigrationFiles } from '../../src/lib/migrations.js';
import type { Config } from '../../src/lib/types.js';

let dir: string;
const cfg: Config = {
  appName: 'test',
  migrationsDir: 'migrations',
  stages: { dev: { region: 'us-east-1' } },
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-files-'));
  mkdirSync(path.join(dir, 'migrations'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listMigrationFiles', () => {
  it('lists flat files and directory migrations in lexical order', async () => {
    writeFileSync(path.join(dir, 'migrations', '2026-01-02_flat.ts'), 'export async function up() {}');
    mkdirSync(path.join(dir, 'migrations', '2026-01-01_dir'));
    writeFileSync(path.join(dir, 'migrations', '2026-01-01_dir', 'index.ts'), 'export async function up() {}');
    writeFileSync(path.join(dir, 'migrations', '2026-01-01_dir', 'fixture.json'), '{}');

    const files = await listMigrationFiles(cfg, dir);

    expect(files.map((file) => [file.id, file.fileName, file.kind])).toEqual([
      ['2026-01-01_dir', '2026-01-01_dir/', 'directory'],
      ['2026-01-02_flat', '2026-01-02_flat.ts', 'file'],
    ]);
    expect(files[0]?.fullPath).toBe(path.join(dir, 'migrations', '2026-01-01_dir', 'index.ts'));
  });

  it('rejects migration directories without an index entrypoint', async () => {
    mkdirSync(path.join(dir, 'migrations', '2026-01-01_missing_index'));
    writeFileSync(path.join(dir, 'migrations', '2026-01-01_missing_index', 'helper.ts'), '');

    await expect(listMigrationFiles(cfg, dir)).rejects.toThrow(/must contain one of/i);
  });
});
