import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { status, up, type Config } from '../../src/lib/index.js';

const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= REGION;

const APP = `ddbmig-failure-${Date.now()}`;
const LEDGER_TABLE = `${APP}-migrations-dev`;
const MIG_ID = '2026-06-01-000000-doomed';

const FAILING_MIGRATION = `
export const description = 'Always throws';
export async function up() {
  throw new Error('intentional failure for test');
}
export async function down() {}
`;

let tmpDir: string;
let raw: DynamoDBClient;
let doc: DynamoDBDocumentClient;

async function dropIfExists(name: string) {
  try {
    await raw.send(new DeleteTableCommand({ TableName: name }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'ddbmig-fail-'));
  const config: Config = {
    appName: APP,
    migrationsDir: 'migrations',
    ledger: { tableName: LEDGER_TABLE },
    stages: { dev: { region: REGION, endpoint: ENDPOINT } },
  };
  writeFileSync(
    path.join(tmpDir, 'ddb-migrations.config.json'),
    JSON.stringify(config),
  );
  mkdirSync(path.join(tmpDir, 'migrations'));
  writeFileSync(
    path.join(tmpDir, 'migrations', `${MIG_ID}.mjs`),
    FAILING_MIGRATION,
  );

  raw = new DynamoDBClient({ region: REGION, endpoint: ENDPOINT });
  doc = DynamoDBDocumentClient.from(raw);
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('failure path', () => {
  it('returns the failed migration in the up result', async () => {
    const r = await up({ stage: 'dev', cwd: tmpDir });
    expect(r.applied).toEqual([]);
    expect(r.failed).toBeDefined();
    expect(r.failed?.id).toBe(MIG_ID);
    expect(r.failed?.message).toMatch(/intentional failure/);
  });

  it('persists status=failed and the error message on the ledger row', async () => {
    const items = (await doc.send(new ScanCommand({ TableName: LEDGER_TABLE }))).Items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.migrationId).toBe(MIG_ID);
    expect(items[0]?.status).toBe('failed');
    expect(items[0]?.errorMessage).toMatch(/intentional failure/);
  });

  it('status() reports failed (not pending)', async () => {
    const items = await status({ stage: 'dev', cwd: tmpDir });
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('failed');
    expect(items[0]?.checksumMatch).toBe(true);
  });
});
