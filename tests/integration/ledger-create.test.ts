// Verifies config.ledger.create: false — a missing ledger table fails with LEDGER_MISSING
// and is never created; an existing one is used as normal.
import { CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerMissingError, status, up, type Config } from '../../src/lib/index.js';
import {
  ENDPOINT,
  NOOP_MIGRATION,
  REGION,
  dropIfExists,
  makeMigrationsDir,
  raw,
  recordingClient,
  removeDir,
  uniqueName,
} from './helpers.js';

const APP = uniqueName('ddbmig-nocreate');
const LEDGER_TABLE = `${APP}-ledger`;
const MIG_ID = '2026-07-03_00-00-noop';

const config: Config = {
  appName: APP,
  migrationsDir: 'migrations',
  ledger: { tableName: LEDGER_TABLE, create: false },
  stages: { dev: { region: REGION, endpoint: ENDPOINT } },
};

let cwd: string;

async function tableExists(name: string): Promise<boolean> {
  try {
    await raw.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  cwd = makeMigrationsDir({ [`${MIG_ID}.mjs`]: NOOP_MIGRATION });
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  removeDir(cwd);
});

describe('ledger.create: false', () => {
  it('up throws LEDGER_MISSING and never calls CreateTable', async () => {
    const ledger = recordingClient();
    const err = await up({ stage: 'dev', cwd, config, clients: { ledger: { raw: ledger.client } } })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerMissingError);
    expect(err).toMatchObject({ code: 'LEDGER_MISSING', tableName: LEDGER_TABLE });
    expect(ledger.calls.map((call) => call.command)).toEqual(['DescribeTableCommand']);
    expect(await tableExists(LEDGER_TABLE)).toBe(false);
  });

  it('status throws LEDGER_MISSING too', async () => {
    await expect(status({ stage: 'dev', cwd, config })).rejects.toMatchObject({ code: 'LEDGER_MISSING' });
    expect(await tableExists(LEDGER_TABLE)).toBe(false);
  });

  it('uses an existing ledger table as normal', async () => {
    await raw.send(
      new CreateTableCommand({
        TableName: LEDGER_TABLE,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    const result = await up({ stage: 'dev', cwd, config });
    expect(result.applied).toEqual([MIG_ID]);
  });
});
