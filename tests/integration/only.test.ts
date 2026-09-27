// Verifies up({ only }): runs just the listed pending ids in lexical order and leaves the
// rest pending; ids that are not pending, and only combined with to, are errors.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { status, up, type Config } from '../../src/lib/index.js';
import {
  ENDPOINT,
  NOOP_MIGRATION,
  REGION,
  dropIfExists,
  makeMigrationsDir,
  removeDir,
  uniqueName,
} from './helpers.js';

const APP = uniqueName('ddbmig-only');
const LEDGER_TABLE = `${APP}-ledger`;
const FIRST = '2026-07-09_00-00-first';
const SECOND = '2026-07-09_00-01-second';
const THIRD = '2026-07-09_00-02-third';

const config: Config = {
  appName: APP,
  migrationsDir: 'migrations',
  ledger: { tableName: LEDGER_TABLE },
  stages: { dev: { region: REGION, endpoint: ENDPOINT } },
};

let cwd: string;

beforeAll(async () => {
  cwd = makeMigrationsDir({
    [`${FIRST}.mjs`]: NOOP_MIGRATION,
    [`${SECOND}.mjs`]: NOOP_MIGRATION,
    [`${THIRD}.mjs`]: NOOP_MIGRATION,
  });
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  removeDir(cwd);
});

describe('up({ only })', () => {
  it('runs only the listed ids, in lexical order', async () => {
    const result = await up({ stage: 'dev', cwd, config, only: [THIRD, FIRST] });
    expect(result.applied).toEqual([FIRST, THIRD]);
    expect(result.skipped).toEqual([SECOND]);

    const items = await status({ stage: 'dev', cwd, config });
    expect(items.map((item) => [item.id, item.status])).toEqual([
      [FIRST, 'completed'],
      [SECOND, 'pending'],
      [THIRD, 'completed'],
    ]);
  });

  it('rejects a listed id that is not pending', async () => {
    await expect(up({ stage: 'dev', cwd, config, only: [SECOND, FIRST] })).rejects.toThrow(
      `Migration '${FIRST}' is not pending`,
    );
    await expect(up({ stage: 'dev', cwd, config, only: ['2099-01-01_missing'] })).rejects.toThrow(
      /not pending \(not found, or already completed\)/,
    );
    expect((await status({ stage: 'dev', cwd, config })).find((item) => item.id === SECOND)?.status).toBe('pending');
  });

  it('refuses only together with to', async () => {
    await expect(up({ stage: 'dev', cwd, config, only: [SECOND], to: SECOND })).rejects.toThrow(
      /only and to cannot be combined/,
    );
  });
});
