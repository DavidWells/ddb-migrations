import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plan } from '../../src/lib/actions/plan.js';
import { Ledger } from '../../src/lib/ledger.js';
import type { LedgerEntry } from '../../src/lib/types.js';

let tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-plan-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: 'plan-test',
      migrationsDir: 'migrations',
      ledger: { tableName: 'plan-ledger' },
      stages: { dev: { region: 'us-east-1', tablePrefix: 'plan-dev-' } },
    }),
  );
  mkdirSync(path.join(dir, 'migrations'));
  writeFileSync(path.join(dir, 'migrations', '2026-01-01_first.mjs'), 'export async function up() {}');
  writeFileSync(path.join(dir, 'migrations', '2026-01-02_second.mjs'), 'export async function up() {}');
  writeFileSync(path.join(dir, 'migrations', '2026-01-03_third.mjs'), 'export async function up() {}');
  return dir;
}

function entry(migrationId: string, overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    pk: 'SCOPE#plan-test#STAGE#dev',
    sk: `MIGRATION#${migrationId}`,
    scope: 'plan-test',
    stage: 'dev',
    migrationId,
    appliedAt: '2026-01-01T00:00:00.000Z',
    checksum: 'not-the-file-checksum',
    status: 'completed',
    ...overrides,
  };
}

describe('plan', () => {
  it('plans runnable migrations without executing migration code', async () => {
    const cwd = makeProject();
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([
      entry('2026-01-01_first', { status: 'completed' }),
      entry('2025-12-31_orphaned', { status: 'completed' }),
    ]);

    const result = await plan({ cwd, stage: 'dev', to: '2026-01-02_second' });

    expect(result.stage).toBe('dev');
    expect(result.ledgerTable).toBe('plan-ledger');
    expect(result.run).toEqual(['2026-01-02_second']);
    expect(result.orphaned).toEqual(['2025-12-31_orphaned']);
    expect(result.drifted).toEqual(['2026-01-01_first']);
    expect(result.migrations.find((migration) => migration.id === '2026-01-03_third')?.willRun).toBe(false);
  });

  it('marks failed, in-progress, and interrupted ledger rows as blocked', async () => {
    const cwd = makeProject();
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([
      entry('2026-01-01_first', { status: 'failed' }),
      entry('2026-01-02_second', { status: 'in_progress' }),
      entry('2026-01-03_third', { status: 'interrupted' }),
    ]);

    const result = await plan({ cwd, stage: 'dev' });

    expect(result.blocked).toEqual(['2026-01-01_first', '2026-01-02_second', '2026-01-03_third']);
  });

  it('lists pending migrations with checksum and path, without importing them by default', async () => {
    const cwd = makeProject();
    writeFileSync(path.join(cwd, 'migrations', '2026-01-04_throws-on-import.mjs'), 'throw new Error("imported")');
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([]);

    const result = await plan({ cwd, stage: 'dev' });

    expect(result.pending.map((migration) => migration.id)).toEqual([
      '2026-01-01_first',
      '2026-01-02_second',
      '2026-01-03_third',
      '2026-01-04_throws-on-import',
    ]);
    expect(result.pending[0]).toEqual({
      id: '2026-01-01_first',
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      path: path.join(cwd, 'migrations', '2026-01-01_first.mjs'),
    });
  });

  it('reads the non-function exports of pending migrations with includeMeta', async () => {
    const cwd = makeProject();
    writeFileSync(
      path.join(cwd, 'migrations', '2026-01-02_second.mjs'),
      [
        "export const description = 'Strip ttl'",
        "export const phase = 'post-deploy'",
        'export const destructive = true',
        "export const tables = ['access']",
        'export async function up() {}',
        'export function helper() {}',
      ].join('\n'),
    );
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([
      entry('2026-01-01_first', { status: 'completed' }),
    ]);

    const result = await plan({ cwd, stage: 'dev', includeMeta: true });

    expect(result.pending.map((migration) => migration.id)).toEqual(['2026-01-02_second', '2026-01-03_third']);
    expect(result.pending[0]?.meta).toEqual({
      description: 'Strip ttl',
      phase: 'post-deploy',
      destructive: true,
      tables: ['access'],
    });
    expect(result.pending[1]?.meta).toEqual({});
  });
});

