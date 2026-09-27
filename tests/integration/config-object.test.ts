// Verifies options.config: up/plan/status/doctor run from a passed config object
// and never read a config file from cwd.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { doctor, plan, status, up, type Config } from '../../src/lib/index.js';
import {
  ENDPOINT,
  NOOP_MIGRATION,
  REGION,
  dropIfExists,
  makeMigrationsDir,
  removeDir,
  uniqueName,
} from './helpers.js';

const APP = uniqueName('ddbmig-cfgobj');
const LEDGER_TABLE = `${APP}-ledger`;
const MIG_ID = '2026-07-01_00-00-noop';

const config: Config = {
  appName: APP,
  migrationsDir: 'migrations',
  ledger: { tableName: LEDGER_TABLE },
  stages: { dev: { region: REGION, endpoint: ENDPOINT } },
};

let cwd: string;

beforeAll(async () => {
  cwd = makeMigrationsDir({ [`${MIG_ID}.mjs`]: NOOP_MIGRATION });
  // A broken config file in cwd proves the passed object wins and nothing in cwd is loaded.
  writeFileSync(path.join(cwd, 'ddb-migrations.config.json'), '{ not json');
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  removeDir(cwd);
});

describe('options.config', () => {
  it('up applies migrations from cwd/migrationsDir using the passed config', async () => {
    const result = await up({ stage: 'dev', cwd, config });
    expect(result.applied).toEqual([MIG_ID]);
  });

  it('status reads the ledger named by the passed config', async () => {
    const items = await status({ stage: 'dev', cwd, config });
    expect(items.map((item) => [item.id, item.status])).toEqual([[MIG_ID, 'completed']]);
  });

  it('plan reports nothing to run and marks the config as passed in', async () => {
    const result = await plan({ stage: 'dev', cwd, config });
    expect(result.run).toEqual([]);
    expect(result.ledgerTable).toBe(LEDGER_TABLE);
    expect(result.configPath).toBe('<options.config>');
  });

  it('doctor passes the config checks without a config file', async () => {
    const result = await doctor({ stage: 'dev', cwd, config });
    expect(result.checks.find((check) => check.name === 'config')?.status).toBe('pass');
    expect(result.checks.find((check) => check.name === 'config-load')?.status).toBe('pass');
    expect(result.checks.find((check) => check.name === 'ledger-table')?.status).toBe('pass');
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid passed config with the file validation errors', async () => {
    const invalid = { ...config, migrationsDir: undefined } as unknown as Config;
    await expect(up({ stage: 'dev', cwd, config: invalid })).rejects.toThrow(/migrationsDir is required/);
  });
});
