// Verifies options.clients: an injected ledger client receives every ledger command and
// the injected app client receives every migration command, with no cross-over.
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plan, status, up, type Config } from '../../src/lib/index.js';
import {
  ENDPOINT,
  REGION,
  doc,
  dropIfExists,
  makeMigrationsDir,
  raw,
  recordingClient,
  removeDir,
  uniqueName,
} from './helpers.js';

const APP = uniqueName('ddbmig-clients');
const LEDGER_TABLE = `${APP}-ledger`;
const APP_TABLE = `${APP}-widgets`;
const MIG_ID = '2026-07-02_00-00-put-widget';

const MIGRATION = `
import { PutCommand } from '@aws-sdk/lib-dynamodb';
export async function up(ctx) {
  await ctx.checkpoint({ step: 1 });
  await ctx.ddb.send(new PutCommand({ TableName: ctx.tableName('widgets'), Item: { pk: 'w1' } }));
}
`;

// A bogus default-chain endpoint: any client the library builds itself fails loudly.
const config: Config = {
  appName: APP,
  migrationsDir: 'migrations',
  ledger: { tableName: LEDGER_TABLE },
  stages: {
    dev: {
      region: REGION,
      endpoint: 'http://127.0.0.1:9',
      tables: { widgets: APP_TABLE },
    },
  },
};

let cwd: string;

beforeAll(async () => {
  cwd = makeMigrationsDir({ [`${MIG_ID}.mjs`]: MIGRATION });
  await dropIfExists(LEDGER_TABLE);
  await dropIfExists(APP_TABLE);
  await raw.send(
    new CreateTableCommand({
      TableName: APP_TABLE,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  await dropIfExists(APP_TABLE);
  removeDir(cwd);
});

describe('options.clients', () => {
  it('routes ledger writes to the ledger client and migration writes to the app client', async () => {
    const app = recordingClient();
    const ledger = recordingClient();

    const result = await up({
      stage: 'dev',
      cwd,
      config,
      clients: { app: { raw: app.client }, ledger: { raw: ledger.client } },
    });

    expect(result.applied).toEqual([MIG_ID]);
    expect(ledger.calls.length).toBeGreaterThan(0);
    expect(ledger.calls.every((call) => call.table === LEDGER_TABLE)).toBe(true);
    expect(ledger.calls.map((call) => call.command)).toEqual(
      expect.arrayContaining(['CreateTableCommand', 'QueryCommand', 'UpdateItemCommand']),
    );
    expect(app.calls).toEqual([{ command: 'PutItemCommand', table: APP_TABLE }]);

    const widget = await doc.send(new GetCommand({ TableName: APP_TABLE, Key: { pk: 'w1' } }));
    expect(widget.Item).toEqual({ pk: 'w1' });
  });

  it('status and plan read the ledger through the injected ledger client', async () => {
    const ledger = recordingClient();
    const clients = { ledger: { raw: ledger.client } };

    const items = await status({ stage: 'dev', cwd, config, clients });
    expect(items.map((item) => item.status)).toEqual(['completed']);

    const result = await plan({ stage: 'dev', cwd, config, clients });
    expect(result.run).toEqual([]);
    expect(ledger.calls.every((call) => call.table === LEDGER_TABLE)).toBe(true);
    expect(ledger.calls.filter((call) => call.command === 'QueryCommand')).toHaveLength(2);
  });
});
