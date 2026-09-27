// Verifies up's structured result (results[], pending[]) and onEvent stream for an apply run
// with a failure, and for a dry-run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { up, type Config, type UpEvent } from '../../src/lib/index.js';
import {
  ENDPOINT,
  NOOP_MIGRATION,
  REGION,
  dropIfExists,
  makeMigrationsDir,
  removeDir,
  uniqueName,
} from './helpers.js';

const APP = uniqueName('ddbmig-result');
const LEDGER_TABLE = `${APP}-ledger`;
const FIRST = '2026-07-10_00-00-progress';
const SECOND = '2026-07-10_00-01-fails';
const THIRD = '2026-07-10_00-02-never-runs';

const PROGRESS_MIGRATION = `
export async function up(ctx) {
  ctx.progress({ phase: 'scan', scanned: 10 });
  await ctx.checkpoint({ page: 1 });
  ctx.progress({ phase: 'scan', scanned: 20, done: true });
}
`;

const config: Config = {
  appName: APP,
  migrationsDir: 'migrations',
  ledger: { tableName: LEDGER_TABLE },
  stages: { dev: { region: REGION, endpoint: ENDPOINT } },
};

let cwd: string;

beforeAll(async () => {
  cwd = makeMigrationsDir({
    [`${FIRST}.mjs`]: PROGRESS_MIGRATION,
    [`${SECOND}.mjs`]: 'export async function up() { throw new Error("intentional failure") }\n',
    [`${THIRD}.mjs`]: NOOP_MIGRATION,
  });
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  removeDir(cwd);
});

describe('up structured result', () => {
  it('reports each dry-run migration and leaves everything pending', async () => {
    const result = await up({ stage: 'dev', cwd, config, dryRun: true, to: FIRST });
    expect(result.results).toEqual([
      expect.objectContaining({ id: FIRST, status: 'dry-run', checksum: expect.any(String), durationMs: expect.any(Number) }),
    ]);
    expect(result.pending).toEqual([FIRST, SECOND, THIRD]);
  });

  it('reports applied and failed migrations, what is still pending, and emits events in order', async () => {
    const events: UpEvent[] = [];
    const result = await up({
      stage: 'dev',
      cwd,
      config,
      sdkStatsEnabled: false,
      onEvent: (event) => events.push(event),
    });

    expect(result.applied).toEqual([FIRST]);
    expect(result.failed).toMatchObject({ id: SECOND });
    expect(result.results).toEqual([
      {
        id: FIRST,
        checksum: expect.any(String),
        status: 'completed',
        durationMs: expect.any(Number),
        progress: { migrationId: FIRST, phase: 'scan', scanned: 20, done: true },
      },
      {
        id: SECOND,
        checksum: expect.any(String),
        status: 'failed',
        durationMs: expect.any(Number),
        error: 'intentional failure',
      },
    ]);
    expect(result.pending).toEqual([SECOND, THIRD]);

    expect(events.map((event) => `${event.type}:${event.id}`)).toEqual([
      `start:${FIRST}`,
      `progress:${FIRST}`,
      `checkpoint:${FIRST}`,
      `progress:${FIRST}`,
      `complete:${FIRST}`,
      `start:${SECOND}`,
      `fail:${SECOND}`,
    ]);
    expect(events[2]).toEqual({ type: 'checkpoint', id: FIRST, checkpoint: { page: 1 } });
    expect(events[4]).toMatchObject({ type: 'complete', status: 'completed' });
    expect(events[6]).toMatchObject({ type: 'fail', error: 'intentional failure' });
  });
});
