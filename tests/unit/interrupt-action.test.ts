import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markInterrupted } from '../../src/lib/actions/interrupt.js';
import { Ledger } from '../../src/lib/ledger.js';

let tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-interrupt-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: 'interrupt-action-test',
      migrationsDir: 'migrations',
      stages: { dev: { region: 'us-east-1' } },
    }),
  );
  mkdirSync(path.join(dir, 'migrations'));
  return dir;
}

describe('markInterrupted action', () => {
  it('marks a ledger row interrupted using the configured stage ledger', async () => {
    const cwd = makeProject();
    const markInterruptedSpy = vi.spyOn(Ledger.prototype, 'markInterrupted').mockResolvedValue(true);
    vi.spyOn(Ledger.prototype, 'ensureExists').mockResolvedValue();

    await expect(
      markInterrupted({
        cwd,
        stage: 'dev',
        migrationId: '2026-01-01_demo',
        message: 'forced shutdown',
      }),
    ).resolves.toEqual({
      stage: 'dev',
      migrationId: '2026-01-01_demo',
      marked: true,
    });

    expect(markInterruptedSpy).toHaveBeenCalledWith('2026-01-01_demo', 'forced shutdown');
  });
});
