// Verifies options.params reaches migration code as ctx.params during up.
// The migration saves ctx.params as its checkpoint so the test can read it back.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { up, type Config } from '../../src/lib/index.js';
import { ledgerPk, ledgerSk } from '../../src/lib/ledger.js';
import {
  ENDPOINT,
  REGION,
  doc,
  dropIfExists,
  makeMigrationsDir,
  removeDir,
  uniqueName,
} from './helpers.js';

const APP = uniqueName('ddbmig-params');
const LEDGER_TABLE = `${APP}-ledger`;
const MIG_ID = '2026-07-05_00-00-record-params';

const MIGRATION = `
export async function up(ctx) {
  if (!Object.isFrozen(ctx.params)) throw new Error('ctx.params is not frozen');
  await ctx.checkpoint({ ...ctx.params });
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
  cwd = makeMigrationsDir({ [`${MIG_ID}.mjs`]: MIGRATION });
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  removeDir(cwd);
});

describe('options.params', () => {
  it('passes params to the migration as ctx.params', async () => {
    const result = await up({ stage: 'dev', cwd, config, params: { deploymentId: 'dep_1', batch: 25 } });
    expect(result.failed).toBeUndefined();

    const row = await doc.send(
      new GetCommand({ TableName: LEDGER_TABLE, Key: { pk: ledgerPk(APP, 'dev'), sk: ledgerSk(MIG_ID) } }),
    );
    expect(row.Item?.checkpoint).toEqual({ deploymentId: 'dep_1', batch: 25 });
  });
});
