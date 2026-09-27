// Verifies the lease lock on DynamoDB Local: acquire/heartbeat/release semantics, expired-lease
// takeover, two concurrent `up` runs, and `held` mode verification.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LockHeldError,
  LockLostError,
  acquireLock,
  heartbeatLock,
  lockKey,
  releaseLock,
  up,
  type Config,
} from '../../src/lib/index.js';
import { Ledger, ledgerPk, ledgerSk } from '../../src/lib/ledger.js';
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

const APP = uniqueName('ddbmig-lock');
const LEDGER_TABLE = `${APP}-ledger`;

const SLOW_MIGRATION = `
export async function up(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await ctx.checkpoint({ page: 1 });
}
`;

let dirs: string[] = [];

function config(appName: string): Config {
  return {
    appName,
    migrationsDir: 'migrations',
    ledger: { tableName: LEDGER_TABLE },
    stages: { dev: { region: REGION, endpoint: ENDPOINT } },
  };
}

function project(files: Record<string, string>): string {
  const dir = makeMigrationsDir(files);
  dirs.push(dir);
  return dir;
}

async function lockRow(scope: string): Promise<Record<string, unknown> | undefined> {
  const resp = await doc.send(new GetCommand({ TableName: LEDGER_TABLE, Key: lockKey(scope, 'dev') }));
  return resp.Item;
}

function params(scope: string, owner: string) {
  return { ledgerClient: doc, tableName: LEDGER_TABLE, scope, stage: 'dev', owner };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (err: unknown) => err);
}

beforeAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  await new Ledger(raw, doc, { tableName: LEDGER_TABLE, scope: APP, stage: 'dev' }).ensureExists();
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  for (const dir of dirs) removeDir(dir);
  dirs = [];
});

describe('lock primitives', () => {
  const scope = `${APP}-primitives`;

  it('acquires, refuses another owner, heartbeats and releases without deleting', async () => {
    const acquired = await acquireLock({ ...params(scope, 'runner-a'), ttlSeconds: 60 });
    expect(acquired).toMatchObject({ owner: 'runner-a', takeover: false });

    const held = await rejection(acquireLock({ ...params(scope, 'runner-b'), ttlSeconds: 60 }));
    expect(held).toBeInstanceOf(LockHeldError);
    expect(held).toMatchObject({ code: 'LOCK_HELD', holder: 'runner-a', expiresAt: acquired.expiresAt });

    // Re-acquire by the same owner is idempotent.
    await acquireLock({ ...params(scope, 'runner-a'), ttlSeconds: 60 });

    const beat = await heartbeatLock({ ...params(scope, 'runner-a'), ttlSeconds: 120 });
    expect(beat.expiresAt).toBeGreaterThan(acquired.expiresAt);
    expect(await rejection(heartbeatLock({ ...params(scope, 'runner-b'), ttlSeconds: 60 }))).toMatchObject({
      code: 'LOCK_LOST',
    });
    expect(await rejection(releaseLock(params(scope, 'runner-b')))).toBeInstanceOf(LockLostError);

    await releaseLock(params(scope, 'runner-a'));
    const row = await lockRow(scope);
    expect(row).toMatchObject({ owner: 'runner-a', expiresAt: 0 });
    expect(typeof row?.releasedAt).toBe('string');

    // A released lease cannot be heartbeated back to life.
    expect(await rejection(heartbeatLock({ ...params(scope, 'runner-a'), ttlSeconds: 60 }))).toBeInstanceOf(
      LockLostError,
    );
  });

  it('acquires a released lease without calling it a takeover', async () => {
    const takeovers: unknown[] = [];
    const acquired = await acquireLock({
      ...params(scope, 'runner-b'),
      ttlSeconds: 60,
      onTakeover: (previous) => takeovers.push(previous),
    });
    expect(acquired.takeover).toBe(false);
    expect(takeovers).toEqual([]);
    expect(await lockRow(scope)).toMatchObject({ owner: 'runner-b', previousOwner: 'runner-a' });
    expect((await lockRow(scope))?.releasedAt).toBeUndefined();
    await releaseLock(params(scope, 'runner-b'));
  });

  it('takes over an expired lease and reports the previous holder', async () => {
    const expiring = `${APP}-expiring`;
    await acquireLock({ ...params(expiring, 'crashed-runner'), ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const takeovers: Array<{ owner: string }> = [];
    const acquired = await acquireLock({
      ...params(expiring, 'rescue-runner'),
      ttlSeconds: 60,
      onTakeover: (previous) => takeovers.push(previous),
    });
    expect(acquired).toMatchObject({ takeover: true, previousOwner: 'crashed-runner' });
    expect(takeovers).toMatchObject([{ owner: 'crashed-runner' }]);
    expect(await lockRow(expiring)).toMatchObject({ owner: 'rescue-runner', previousOwner: 'crashed-runner' });

    expect(await rejection(heartbeatLock({ ...params(expiring, 'crashed-runner'), ttlSeconds: 60 }))).toBeInstanceOf(
      LockLostError,
    );
  });
});

describe('up with a lock', () => {
  it('lets only one of two concurrent runs proceed', async () => {
    const appName = `${APP}-concurrent`;
    const cwd = project({ '2026-07-07_00-00-slow.mjs': SLOW_MIGRATION });
    const run = (owner: string) =>
      up({ stage: 'dev', cwd, config: config(appName), lock: { owner, ttlSeconds: 60 } });

    const results = await Promise.allSettled([run('runner-a'), run('runner-b')]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(LockHeldError);
    expect((fulfilled[0] as PromiseFulfilledResult<{ applied: string[] }>).value.applied).toEqual([
      '2026-07-07_00-00-slow',
    ]);

    const row = await lockRow(appName);
    expect(row?.expiresAt).toBe(0);
    expect(typeof row?.heartbeatAt).toBe('string');
    expect(row?.heartbeatAt).not.toBe(row?.acquiredAt);
  });

  it('releases the lock when a migration fails', async () => {
    const appName = `${APP}-failing`;
    const cwd = project({ '2026-07-07_00-01-boom.mjs': 'export async function up() { throw new Error("boom") }\n' });
    const result = await up({ stage: 'dev', cwd, config: config(appName), lock: { owner: 'runner-a', ttlSeconds: 60 } });
    expect(result.failed?.id).toBe('2026-07-07_00-01-boom');
    expect(result.lock).toEqual({ owner: 'runner-a', takeover: false, released: true });
    expect((await lockRow(appName))?.expiresAt).toBe(0);
  });

  it('stops at the next checkpoint once the lease is taken over, leaving the row resumable', async () => {
    const appName = `${APP}-takenover`;
    const migrationId = '2026-07-07_00-04-outlives-lease';
    const cwd = project({
      [`${migrationId}.mjs`]: `
export async function up(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 3500));
  await ctx.checkpoint({ page: 1 });
}
`,
    });
    const running = up({ stage: 'dev', cwd, config: config(appName), lock: { owner: 'slow-runner', ttlSeconds: 1 } });
    // Expiry has one-second resolution, so the 1s lease is free to take within ~2s; the
    // migration checkpoints at 3.5s, well after the takeover.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await vi.waitFor(
      () => acquireLock({ ...params(appName, 'rescue-runner'), ttlSeconds: 60 }),
      { timeout: 2400, interval: 100 },
    );

    const result = await running;
    expect(result.failed).toMatchObject({ id: migrationId, message: expect.stringMatching(/not held by 'slow-runner'/) });
    const row = await doc.send(
      new GetCommand({ TableName: LEDGER_TABLE, Key: { pk: ledgerPk(appName, 'dev'), sk: ledgerSk(migrationId) } }),
    );
    expect(row.Item?.status).toBe('in_progress');
    expect(result.lock).toMatchObject({ owner: 'slow-runner', released: false });
    expect(await lockRow(appName)).toMatchObject({ owner: 'rescue-runner' });
  });

  it('held mode verifies ownership and never writes the lock in a dry-run', async () => {
    const appName = `${APP}-held`;
    const cwd = project({ '2026-07-07_00-02-slow.mjs': SLOW_MIGRATION });

    const missing = await rejection(
      up({ stage: 'dev', cwd, config: config(appName), dryRun: true, lock: { owner: 'parent', held: true } }),
    );
    expect(missing).toBeInstanceOf(LockLostError);

    await acquireLock({ ...params(appName, 'parent'), ttlSeconds: 60 });
    const before = await lockRow(appName);

    const other = await rejection(
      up({ stage: 'dev', cwd, config: config(appName), dryRun: true, lock: { owner: 'intruder', held: true } }),
    );
    expect(other).toMatchObject({ code: 'LOCK_LOST', holder: 'parent' });

    const ledger = recordingClient();
    const result = await up({
      stage: 'dev',
      cwd,
      config: config(appName),
      dryRun: true,
      clients: { ledger: { raw: ledger.client } },
      lock: { owner: 'parent', held: true, ttlSeconds: 60 },
    });
    expect(result.applied).toEqual(['2026-07-07_00-02-slow']);
    const writes = ledger.calls.filter((call) => !['GetItemCommand', 'QueryCommand', 'DescribeTableCommand'].includes(call.command));
    expect(writes).toEqual([]);
    expect(await lockRow(appName)).toEqual(before);
  });

  it('refuses a lock without ttlSeconds unless it is held', async () => {
    const cwd = project({ '2026-07-07_00-03-noop.mjs': 'export async function up() {}\n' });
    await expect(
      up({ stage: 'dev', cwd, config: config(`${APP}-nottl`), lock: { owner: 'runner-a' } }),
    ).rejects.toThrow(/ttlSeconds/);
  });
});
