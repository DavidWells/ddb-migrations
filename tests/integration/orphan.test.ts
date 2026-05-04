import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down, status, up, type Config } from '../../src/lib/index.js';

const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= REGION;

const APP = `ddbmig-orphan-${Date.now()}`;
const LEDGER_TABLE = `${APP}-migrations-dev`;
const MIG_ID = '2026-07-01-000000-survivor';
const NOOP = `
export async function up() {}
export async function down() {}
`;

let tmpDir: string;
let migrationFile: string;
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
  tmpDir = mkdtempSync(path.join(tmpdir(), 'ddbmig-orphan-'));
  const config: Config = {
    appName: APP,
    migrationsDir: 'migrations',
    stages: { dev: { region: REGION, endpoint: ENDPOINT } },
  };
  writeFileSync(
    path.join(tmpDir, 'ddb-migrations.config.json'),
    JSON.stringify(config),
  );
  mkdirSync(path.join(tmpDir, 'migrations'));
  migrationFile = path.join(tmpDir, 'migrations', `${MIG_ID}.mjs`);
  writeFileSync(migrationFile, NOOP);

  raw = new DynamoDBClient({ region: REGION, endpoint: ENDPOINT });
  doc = DynamoDBDocumentClient.from(raw);
  await dropIfExists(LEDGER_TABLE);

  const r = await up({ stage: 'dev', cwd: tmpDir });
  if (r.failed) throw new Error(`setup up() failed: ${r.failed.message}`);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('orphan handling', () => {
  it('initially shows the migration as completed', async () => {
    const items = await status({ stage: 'dev', cwd: tmpDir });
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('completed');
  });

  it('reports orphan after the file is deleted', async () => {
    rmSync(migrationFile);
    const items = await status({ stage: 'dev', cwd: tmpDir });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(MIG_ID);
    expect(items[0]?.status).toBe('orphan');
    expect(items[0]?.fileName).toBe('<missing file>');
  });

  it('down fails with a clear error when the file is missing', async () => {
    const r = await down({ stage: 'dev', cwd: tmpDir });
    expect(r.rolledBack).toEqual([]);
    expect(r.failed).toBeDefined();
    expect(r.failed?.id).toBe(MIG_ID);
    expect(r.failed?.message).toMatch(/file not found/i);
  });
});
