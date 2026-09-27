import { describe, expect, it } from 'vitest';
import { makeContext } from '../../src/lib/runner.js';
import type { Clients } from '../../src/lib/ddb.js';
import type { Config, MigrationProgressEvent } from '../../src/lib/types.js';
import type { Ledger } from '../../src/lib/ledger.js';

class QueryCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown> = {}) {
    this.input = input;
  }
}

class FakeClient {
  config = { region: 'us-east-1' };

  async send(_command: unknown): Promise<unknown> {
    return { Items: [{ id: 1 }] };
  }
}

function cfg(observability: Config['observability'] = {}): Config {
  return {
    appName: 'runner-test',
    migrationsDir: 'migrations',
    observability,
    stages: { dev: { region: 'us-east-1' } },
  };
}

function clients(): Clients {
  const raw = new FakeClient();
  const doc = new FakeClient();
  return {
    raw,
    doc,
    ledgerRaw: raw,
    ledgerDoc: doc,
  } as unknown as Clients;
}

function ledger(): Ledger {
  return {
    setCheckpoint: async () => undefined,
    getCheckpoint: async () => undefined,
  } as unknown as Ledger;
}

describe('makeContext SDK stats integration', () => {
  it('counts ctx.ddb sends and enriches progress events by default', async () => {
    const events: MigrationProgressEvent[] = [];
    const ctx = makeContext({
      cfg: cfg(),
      stage: 'dev',
      migrationId: '2026-01-01_demo',
      ledger: ledger(),
      clients: clients(),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      dryRun: false,
      onProgress: (event) => events.push(event),
    });

    await (ctx.ddb as unknown as { send(command: unknown): Promise<unknown> }).send(new QueryCommand());
    ctx.progress({ phase: 'scan' });

    expect(ctx.sdkStats.snapshot().calls).toBe(1);
    expect(events[0]?.migrationId).toBe('2026-01-01_demo');
    expect(events[0]?.sdk?.calls).toBe(1);
  });

  it('can disable client wrapping entirely', async () => {
    const events: MigrationProgressEvent[] = [];
    const ctx = makeContext({
      cfg: cfg({ sdkStatsEnabled: false }),
      stage: 'dev',
      migrationId: '2026-01-01_demo',
      ledger: ledger(),
      clients: clients(),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      dryRun: false,
      onProgress: (event) => events.push(event),
    });

    await (ctx.ddb as unknown as { send(command: unknown): Promise<unknown> }).send(new QueryCommand());
    ctx.progress({ phase: 'scan' });

    expect(ctx.sdkStats.snapshot().calls).toBe(0);
    expect(events[0]?.sdk).toBeUndefined();
  });
});

describe('makeContext params', () => {
  const base = {
    cfg: cfg(),
    stage: 'dev',
    migrationId: '2026-01-01_demo',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
  };

  it('exposes a frozen shallow copy of the passed params', () => {
    const params = { tenant: 't1', nested: { a: 1 } };
    const ctx = makeContext({ ...base, ledger: ledger(), clients: clients(), params });

    expect(ctx.params).toEqual(params);
    expect(ctx.params).not.toBe(params);
    expect(Object.isFrozen(ctx.params)).toBe(true);
    params.tenant = 'changed';
    expect(ctx.params.tenant).toBe('t1');
  });

  it('defaults to an empty frozen object', () => {
    const ctx = makeContext({ ...base, ledger: ledger(), clients: clients() });
    expect(ctx.params).toEqual({});
    expect(Object.isFrozen(ctx.params)).toBe(true);
  });
});
