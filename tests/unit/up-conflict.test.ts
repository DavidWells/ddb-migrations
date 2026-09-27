// Verifies a superseded run: when a ledger write conflicts mid-migration, up reports the
// migration failed and does not try to mark the other run's row failed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { up } from '../../src/lib/actions/up.js';
import { LedgerConflictError } from '../../src/lib/errors.js';
import { Ledger } from '../../src/lib/ledger.js';

let tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-up-conflict-'));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, 'migrations'));
  writeFileSync(
    path.join(dir, 'migrations', '2026-01-01_checkpointing.mjs'),
    'export async function up(ctx) { await ctx.checkpoint({ page: 1 }) }\n',
  );
  return dir;
}

describe('up with a superseded ledger row', () => {
  it('returns failed without calling markFailed', async () => {
    const cwd = makeProject();
    vi.spyOn(Ledger.prototype, 'ensureExists').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([]);
    vi.spyOn(Ledger.prototype, 'markStart').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'setCheckpoint').mockRejectedValue(
      new LedgerConflictError('2026-01-01_checkpointing', 'setCheckpoint'),
    );
    const markFailed = vi.spyOn(Ledger.prototype, 'markFailed').mockResolvedValue();
    const markComplete = vi.spyOn(Ledger.prototype, 'markComplete').mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await up({
      cwd,
      stage: 'dev',
      checkAccount: false,
      config: { appName: 'conflict-test', migrationsDir: 'migrations', stages: { dev: { region: 'us-east-1' } } },
    });

    expect(result.failed).toMatchObject({ id: '2026-01-01_checkpointing', message: expect.stringMatching(/rejected/) });
    expect(markFailed).not.toHaveBeenCalled();
    expect(markComplete).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed: Ledger setCheckpoint'));
  });
});
