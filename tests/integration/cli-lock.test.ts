// Verifies `ddb-migrate up --lock-owner` takes and releases the lease on DynamoDB Local,
// and exits non-zero with the holder when another owner holds it.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireLock, lockKey } from '../../src/lib/index.js';
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

const APP = uniqueName('ddbmig-clilock');
const LEDGER_TABLE = `${APP}-ledger`;

let cwd: string;

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', 'src/bin/cli.ts', '--cwd', cwd, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
}

beforeAll(async () => {
  cwd = makeMigrationsDir({ '2026-07-08_00-00-noop.mjs': NOOP_MIGRATION });
  writeFileSync(
    path.join(cwd, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: APP,
      migrationsDir: 'migrations',
      ledger: { tableName: LEDGER_TABLE },
      stages: { dev: { region: REGION, endpoint: ENDPOINT } },
    }),
  );
  await dropIfExists(LEDGER_TABLE);
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  removeDir(cwd);
});

describe('ddb-migrate up --lock-owner', () => {
  it('applies under the lease and releases it', async () => {
    const result = runCli(['up', '--stage', 'dev', '--lock-owner', 'ci:job-1', '--lock-ttl', '120', '--json']);
    expect(result.status).toBe(0);
    // Migration log lines share stdout with --json output; the JSON object starts on its own line.
    const json = result.stdout.slice(result.stdout.indexOf('\n{') + 1);
    expect(JSON.parse(json)).toMatchObject({
      applied: ['2026-07-08_00-00-noop'],
      lock: { owner: 'ci:job-1', takeover: false, released: true },
    });

    const row = await doc.send(new GetCommand({ TableName: LEDGER_TABLE, Key: lockKey(APP, 'dev') }));
    expect(row.Item).toMatchObject({ owner: 'ci:job-1', expiresAt: 0 });
  });

  it('exits 1 and names the holder when another owner holds the lease', async () => {
    await acquireLock({
      ledgerClient: doc,
      tableName: LEDGER_TABLE,
      scope: APP,
      stage: 'dev',
      owner: 'ci:job-2',
      ttlSeconds: 120,
    });
    const result = runCli(['up', '--stage', 'dev', '--lock-owner', 'ci:job-3']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/held by 'ci:job-2'/);
  });
});
