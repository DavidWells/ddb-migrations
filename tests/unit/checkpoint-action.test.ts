import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCheckpoint, showCheckpoint } from '../../src/lib/actions/checkpoint.js';
import { Ledger } from '../../src/lib/ledger.js';

let tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-checkpoint-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: 'checkpoint-test',
      migrationsDir: 'migrations',
      stages: { dev: { region: 'us-east-1' } },
    }),
  );
  mkdirSync(path.join(dir, 'migrations'));
  return dir;
}

describe('checkpoint actions', () => {
  it('shows saved checkpoints', async () => {
    const cwd = makeProject();
    vi.spyOn(Ledger.prototype, 'ensureExists').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'get').mockResolvedValue({
      pk: 'SCOPE#checkpoint-test#STAGE#dev',
      sk: 'MIGRATION#2026-01-01_demo',
      scope: 'checkpoint-test',
      stage: 'dev',
      migrationId: '2026-01-01_demo',
      appliedAt: '2026-01-01T00:00:00.000Z',
      checksum: 'abc',
      status: 'in_progress',
      checkpoint: { page: 4 },
    });

    await expect(showCheckpoint({ cwd, stage: 'dev', migrationId: '2026-01-01_demo' })).resolves.toMatchObject({
      found: true,
      checkpoint: { page: 4 },
    });
  });

  it('clears checkpoints only when one exists', async () => {
    const cwd = makeProject();
    const clearSpy = vi.spyOn(Ledger.prototype, 'clearCheckpoint').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'ensureExists').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'get').mockResolvedValue({
      pk: 'SCOPE#checkpoint-test#STAGE#dev',
      sk: 'MIGRATION#2026-01-01_demo',
      scope: 'checkpoint-test',
      stage: 'dev',
      migrationId: '2026-01-01_demo',
      appliedAt: '2026-01-01T00:00:00.000Z',
      checksum: 'abc',
      status: 'in_progress',
      checkpoint: { page: 4 },
    });

    const result = await clearCheckpoint({ cwd, stage: 'dev', migrationId: '2026-01-01_demo' });

    expect(result.cleared).toBe(true);
    expect(clearSpy).toHaveBeenCalledWith('2026-01-01_demo');
  });
});
