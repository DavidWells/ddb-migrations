import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down, status, up, type Config } from '../../src/lib/index.js';

const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const REGION = 'us-east-1';

// ddb-local doesn't validate creds but the SDK requires them to be set.
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= REGION;

const APP = `ddbmig-test-${Date.now()}`;
const TEST_TABLE = `${APP}-dev-widgets`;
const LEDGER_TABLE = `${APP}-migrations-dev`;
const MIG_ID = '2026-05-04-000000-add-schema-version';

const MIGRATION_BODY = `
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const description = 'Add schemaVersion=1 to widgets';

export async function up(ctx) {
  const T = ctx.tableName('widgets');
  const cp = (await ctx.getCheckpoint()) ?? { touched: 0 };
  await ctx.checkpoint(cp);
  const resp = await ctx.ddb.send(new ScanCommand({ TableName: T }));
  for (const item of resp.Items ?? []) {
    if (ctx.dryRun) continue;
    await ctx.ddb.send(new UpdateCommand({
      TableName: T,
      Key: { pk: item.pk },
      UpdateExpression: 'SET schemaVersion = :v',
      ExpressionAttributeValues: { ':v': 1 },
    }));
    cp.touched += 1;
    await ctx.checkpoint(cp);
  }
}

export async function down(ctx) {
  const T = ctx.tableName('widgets');
  const resp = await ctx.ddb.send(new ScanCommand({ TableName: T }));
  for (const item of resp.Items ?? []) {
    await ctx.ddb.send(new UpdateCommand({
      TableName: T,
      Key: { pk: item.pk },
      UpdateExpression: 'REMOVE schemaVersion',
    }));
  }
}
`;

let tmpDir: string;
let raw: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let migrationFile: string;

async function dropIfExists(name: string) {
  try {
    await raw.send(new DeleteTableCommand({ TableName: name }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'ddbmig-it-'));
  const config: Config = {
    appName: APP,
    migrationsDir: 'migrations',
    ledger: { tableName: LEDGER_TABLE },
    stages: {
      dev: { region: REGION, tablePrefix: `${APP}-dev-`, endpoint: ENDPOINT },
    },
  };
  writeFileSync(
    path.join(tmpDir, 'ddb-migrations.config.json'),
    JSON.stringify(config, null, 2),
  );
  mkdirSync(path.join(tmpDir, 'migrations'));
  migrationFile = path.join(tmpDir, 'migrations', `${MIG_ID}.mjs`);
  writeFileSync(migrationFile, MIGRATION_BODY);

  raw = new DynamoDBClient({ region: REGION, endpoint: ENDPOINT });
  doc = DynamoDBDocumentClient.from(raw);

  await dropIfExists(TEST_TABLE);
  await dropIfExists(LEDGER_TABLE);

  await raw.send(
    new CreateTableCommand({
      TableName: TEST_TABLE,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  await doc.send(new PutCommand({ TableName: TEST_TABLE, Item: { pk: 'a' } }));
  await doc.send(new PutCommand({ TableName: TEST_TABLE, Item: { pk: 'b' } }));
});

afterAll(async () => {
  await dropIfExists(TEST_TABLE);
  await dropIfExists(LEDGER_TABLE);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('round-trip against ddb-local', () => {
  it('dry-run does not modify items or write to the ledger', async () => {
    const r = await up({ stage: 'dev', cwd: tmpDir, dryRun: true });
    expect(r.applied).toEqual([MIG_ID]);
    expect(r.failed).toBeUndefined();

    const items = (await doc.send(new ScanCommand({ TableName: TEST_TABLE }))).Items ?? [];
    expect(items.some((i) => 'schemaVersion' in i)).toBe(false);

    const ledgerItems = (await doc.send(new ScanCommand({ TableName: LEDGER_TABLE }))).Items ?? [];
    expect(ledgerItems).toHaveLength(0);
  });

  it('up applies the migration and seeds the ledger', async () => {
    const r = await up({ stage: 'dev', cwd: tmpDir });
    expect(r.applied).toEqual([MIG_ID]);
    expect(r.failed).toBeUndefined();

    const items = (await doc.send(new ScanCommand({ TableName: TEST_TABLE }))).Items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((i) => i.schemaVersion === 1)).toBe(true);
  });

  it('status reports completed with checksum match and a saved checkpoint', async () => {
    const items = await status({ stage: 'dev', cwd: tmpDir });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('completed');
    expect(items[0].checksumMatch).toBe(true);

    const ledgerItems = (await doc.send(new ScanCommand({ TableName: LEDGER_TABLE }))).Items ?? [];
    expect(ledgerItems).toHaveLength(1);
    expect(ledgerItems[0].checkpoint).toMatchObject({ touched: 2 });
  });

  it('a second up is a no-op when nothing is pending', async () => {
    const r = await up({ stage: 'dev', cwd: tmpDir });
    expect(r.applied).toEqual([]);
  });

  it('refuses to run up when the file has drifted', async () => {
    const orig = readFileSync(migrationFile);
    writeFileSync(migrationFile, Buffer.concat([Buffer.from('// drift\n'), orig]));
    try {
      await expect(up({ stage: 'dev', cwd: tmpDir })).rejects.toThrow(/drift/i);
    } finally {
      writeFileSync(migrationFile, orig);
    }
  });

  it('status flags drift as DRIFT', async () => {
    const orig = readFileSync(migrationFile);
    writeFileSync(migrationFile, Buffer.concat([Buffer.from('// drift\n'), orig]));
    try {
      const items = await status({ stage: 'dev', cwd: tmpDir });
      expect(items[0].checksumMatch).toBe(false);
    } finally {
      writeFileSync(migrationFile, orig);
    }
  });

  it('down rolls back and clears schemaVersion', async () => {
    const r = await down({ stage: 'dev', cwd: tmpDir });
    expect(r.rolledBack).toEqual([MIG_ID]);
    expect(r.failed).toBeUndefined();

    const items = (await doc.send(new ScanCommand({ TableName: TEST_TABLE }))).Items ?? [];
    expect(items.some((i) => 'schemaVersion' in i)).toBe(false);
  });

  it('after down, status reports pending again', async () => {
    const items = await status({ stage: 'dev', cwd: tmpDir });
    expect(items[0].status).toBe('pending');
  });
});
