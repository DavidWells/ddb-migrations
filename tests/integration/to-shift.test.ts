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

const APP = `ddbmig-toshift-${Date.now()}`;
const LEDGER_TABLE = `${APP}-migrations-dev`;
const M1 = '2026-06-01-000000-first';
const M2 = '2026-06-02-000000-second';
const M3 = '2026-06-03-000000-third';
const NOOP = `
export async function up() {}
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

function statusById(items: Awaited<ReturnType<typeof status>>) {
  return Object.fromEntries(items.map((i) => [i.id, i.status] as const));
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'ddbmig-toshift-'));
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
  const dir = path.join(tmpDir, 'migrations');
  mkdirSync(dir);
  for (const id of [M1, M2, M3]) {
    writeFileSync(path.join(dir, `${id}.mjs`), NOOP);
  }

  raw = new DynamoDBClient({ region: REGION, endpoint: ENDPOINT });
  doc = DynamoDBDocumentClient.from(raw);
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('--to slicing', () => {
  it('applies only up to and including the named id', async () => {
    const r = await up({ stage: 'dev', cwd: tmpDir, to: M2 });
    expect(r.applied).toEqual([M1, M2]);
    expect(r.skipped).toEqual([M3]);
    expect(r.failed).toBeUndefined();

    expect(statusById(await status({ stage: 'dev', cwd: tmpDir }))).toEqual({
      [M1]: 'completed',
      [M2]: 'completed',
      [M3]: 'pending',
    });
  });

  it('rejects --to for a migration that is not pending', async () => {
    // M2 is already completed at this point.
    await expect(up({ stage: 'dev', cwd: tmpDir, to: M2 })).rejects.toThrow(/not pending/i);
  });

  it('a follow-up up() with no --to applies the rest', async () => {
    const r = await up({ stage: 'dev', cwd: tmpDir });
    expect(r.applied).toEqual([M3]);
    expect(statusById(await status({ stage: 'dev', cwd: tmpDir }))).toEqual({
      [M1]: 'completed',
      [M2]: 'completed',
      [M3]: 'completed',
    });
  });
});

describe('--shift rollback', () => {
  it('rolls back the last N completed migrations newest-first', async () => {
    const r = await down({ stage: 'dev', cwd: tmpDir, shift: 2 });
    expect(r.rolledBack).toEqual([M3, M2]);
    expect(r.failed).toBeUndefined();

    expect(statusById(await status({ stage: 'dev', cwd: tmpDir }))).toEqual({
      [M1]: 'completed',
      [M2]: 'pending',
      [M3]: 'pending',
    });
  });

  it('--shift 0 rolls back everything that remains', async () => {
    const r = await down({ stage: 'dev', cwd: tmpDir, shift: 0 });
    expect(r.rolledBack).toEqual([M1]);
    expect(statusById(await status({ stage: 'dev', cwd: tmpDir }))).toEqual({
      [M1]: 'pending',
      [M2]: 'pending',
      [M3]: 'pending',
    });
  });
});
