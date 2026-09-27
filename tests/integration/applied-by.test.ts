// Verifies options.appliedBy replaces the default user@host on ledger rows,
// and that the default is unchanged when it is unset.
import os from 'node:os';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { up, type Config } from '../../src/lib/index.js';
import { ledgerPk, ledgerSk } from '../../src/lib/ledger.js';
import {
  ENDPOINT,
  NOOP_MIGRATION,
  REGION,
  doc,
  dropIfExists,
  makeMigrationsDir,
  removeDir,
  uniqueName,
} from './helpers.js';

const APP = uniqueName('ddbmig-appliedby');
const LEDGER_TABLE = `${APP}-ledger`;
const FIRST = '2026-07-04_00-00-first';
const SECOND = '2026-07-04_00-01-second';

const config: Config = {
  appName: APP,
  migrationsDir: 'migrations',
  ledger: { tableName: LEDGER_TABLE },
  stages: { dev: { region: REGION, endpoint: ENDPOINT } },
};

let cwd: string;

async function appliedBy(migrationId: string): Promise<unknown> {
  const resp = await doc.send(
    new GetCommand({
      TableName: LEDGER_TABLE,
      Key: { pk: ledgerPk(APP, 'dev'), sk: ledgerSk(migrationId) },
    }),
  );
  return resp.Item?.appliedBy;
}

beforeAll(async () => {
  cwd = makeMigrationsDir({ [`${FIRST}.mjs`]: NOOP_MIGRATION, [`${SECOND}.mjs`]: NOOP_MIGRATION });
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  removeDir(cwd);
});

describe('options.appliedBy', () => {
  it('defaults to user@host', async () => {
    await up({ stage: 'dev', cwd, config, to: FIRST });
    expect(await appliedBy(FIRST)).toBe(`${os.userInfo().username}@${os.hostname()}`);
  });

  it('records the passed identity instead', async () => {
    await up({ stage: 'dev', cwd, config, appliedBy: 'saaslayer-deployer:run-123' });
    expect(await appliedBy(SECOND)).toBe('saaslayer-deployer:run-123');
  });
});
