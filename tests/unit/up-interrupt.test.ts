import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { up } from '../../src/lib/actions/up.js';
import { Ledger } from '../../src/lib/ledger.js';

let tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-up-interrupt-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: 'interrupt-test',
      migrationsDir: 'migrations',
      stages: { dev: { region: 'us-east-1' } },
    }),
  );
  mkdirSync(path.join(dir, 'migrations'));
  writeFileSync(
    path.join(dir, 'migrations', '2026-01-01_wait.mjs'),
    `
      export async function up(ctx) {
        while (!ctx.shouldStop()) await new Promise((resolve) => setTimeout(resolve, 1))
        ctx.throwIfStopped()
      }
    `,
  );
  return dir;
}

describe('up interruption persistence', () => {
  it('marks the active migration interrupted when the abort signal fires', async () => {
    const cwd = makeProject();
    const controller = new AbortController();
    const markInterrupted = vi.spyOn(Ledger.prototype, 'markInterrupted').mockResolvedValue(true);
    const markComplete = vi.spyOn(Ledger.prototype, 'markComplete').mockResolvedValue();
    const markFailed = vi.spyOn(Ledger.prototype, 'markFailed').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'ensureExists').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([]);
    const markStart = vi.spyOn(Ledger.prototype, 'markStart').mockResolvedValue();

    const pending = up({
      cwd,
      stage: 'dev',
      signal: controller.signal,
      checkAccount: false,
    });
    // Abort only once the migration is running; a fixed delay races config/file loading.
    await vi.waitFor(() => expect(markStart).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort('received SIGINT');

    await expect(pending).resolves.toMatchObject({
      interrupted: {
        id: '2026-01-01_wait',
      },
    });
    expect(markInterrupted).toHaveBeenCalledWith('2026-01-01_wait', expect.stringContaining('received SIGINT'));
    expect(markComplete).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('reports the interrupted migration in results and emits an interrupt event', async () => {
    const cwd = makeProject();
    const controller = new AbortController();
    vi.spyOn(Ledger.prototype, 'markInterrupted').mockResolvedValue(true);
    vi.spyOn(Ledger.prototype, 'ensureExists').mockResolvedValue();
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([]);
    const markStart = vi.spyOn(Ledger.prototype, 'markStart').mockResolvedValue();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: string[] = [];

    const pending = up({
      cwd,
      stage: 'dev',
      signal: controller.signal,
      checkAccount: false,
      onEvent: (event) => events.push(event.type),
    });
    await vi.waitFor(() => expect(markStart).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort('received SIGINT');

    const result = await pending;
    expect(result.results).toMatchObject([{ id: '2026-01-01_wait', status: 'interrupted' }]);
    expect(result.pending).toEqual(['2026-01-01_wait']);
    expect(events).toEqual(['start', 'interrupt']);
  });
});

