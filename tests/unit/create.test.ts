import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { create, slugify, timestamp } from '../../src/lib/actions/create.js';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-create-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: 'test',
      migrationsDir: 'migrations',
      stages: { dev: { region: 'us-east-1' } },
    }),
  );
  return dir;
}

describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics into dashes', () => {
    expect(slugify('Add User Schema!')).toBe('add-user-schema');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('  hello  world  ')).toBe('hello-world');
  });

  it('caps slug length at 60 characters', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  it('returns empty string for input with no alphanumerics', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('timestamp', () => {
  it('formats UTC date as YYYY-MM-DD_HH-MM', () => {
    const t = timestamp(new Date(Date.UTC(2026, 4, 4, 11, 30, 45)));
    expect(t).toBe('2026-05-04_11-30');
  });

  it('zero-pads single-digit components', () => {
    const t = timestamp(new Date(Date.UTC(2026, 0, 1, 1, 2, 3)));
    expect(t).toBe('2026-01-01_01-02');
  });
});

describe('create', () => {
  it('creates directory migrations by default', async () => {
    const cwd = makeProject();

    const relativePath = await create('Add User Schema!', { cwd });
    const fullPath = path.join(cwd, relativePath);

    expect(relativePath).toMatch(
      /^migrations\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_add-user-schema\/index\.ts$/,
    );
    expect(existsSync(fullPath)).toBe(true);
    expect(readFileSync(fullPath, 'utf8')).toContain(
      "export const description = 'Add User Schema!';",
    );
  });

  it('creates flat migration files when requested', async () => {
    const cwd = makeProject();

    const relativePath = await create('Add User Schema!', { cwd, format: 'file' });

    expect(relativePath).toMatch(
      /^migrations\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_add-user-schema\.ts$/,
    );
    expect(existsSync(path.join(cwd, relativePath))).toBe(true);
  });
});
