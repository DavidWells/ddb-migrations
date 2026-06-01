import { describe, expect, it } from 'vitest';
import { resolveStage, resolveTableName } from '../../src/lib/config.js';
import type { Config } from '../../src/lib/types.js';

const cfg: Config = {
  appName: 'myapp',
  migrationsDir: 'migrations',
  ledger: { tableName: 'shared-ledger', scope: 'shared-scope' },
  stages: {
    dev: { region: 'us-east-1', tablePrefix: 'myapp-dev-' },
    prod: {
      region: 'us-west-2',
      tables: { users: 'override-users' },
      ledgerTable: 'custom-ledger',
    },
    bare: { region: 'us-east-1' },
  },
};

const localStage: Config = {
  appName: 'myapp',
  migrationsDir: 'migrations',
  stages: {
    dev: { region: 'us-east-1', endpoint: 'http://localhost:8000' },
  },
};

describe('resolveStage', () => {
  it('uses an explicit ledgerTable when provided', () => {
    expect(resolveStage(cfg, 'prod').ledgerTable).toBe('custom-ledger');
  });

  it('falls back to the default ledger table name', () => {
    expect(resolveStage({ ...cfg, ledger: undefined }, 'dev').ledgerTable).toBe('ddb-migrations-ledger');
  });

  it('uses the top-level shared ledger table when configured', () => {
    expect(resolveStage(cfg, 'dev').ledgerTable).toBe('shared-ledger');
  });

  it('resolves the ledger scope from config or appName', () => {
    expect(resolveStage(cfg, 'dev').ledgerScope).toBe('shared-scope');
    expect(resolveStage({ ...cfg, ledger: undefined }, 'dev').ledgerScope).toBe('myapp');
  });

  it('throws for an unknown stage', () => {
    expect(() => resolveStage(cfg, 'staging')).toThrow(/unknown stage/i);
  });

  it('defaults ledgerRegion to stage.region when no override set', () => {
    expect(resolveStage(cfg, 'dev').ledgerRegion).toBe('us-east-1');
    expect(resolveStage(cfg, 'prod').ledgerRegion).toBe('us-west-2');
  });

  it('uses ledger.region over stage.region for the ledger', () => {
    const withLedgerRegion: Config = {
      ...cfg,
      ledger: { ...cfg.ledger, region: 'us-east-1' },
    };
    expect(resolveStage(withLedgerRegion, 'prod').region).toBe('us-west-2');
    expect(resolveStage(withLedgerRegion, 'prod').ledgerRegion).toBe('us-east-1');
  });

  it('stage.ledgerRegion wins over ledger.region', () => {
    const withBoth: Config = {
      ...cfg,
      ledger: { ...cfg.ledger, region: 'us-east-1' },
      stages: {
        ...cfg.stages,
        prod: { ...cfg.stages.prod, ledgerRegion: 'eu-west-1' },
      },
    };
    expect(resolveStage(withBoth, 'prod').ledgerRegion).toBe('eu-west-1');
  });

  it('inherits stage.endpoint for the ledger when ledger region matches stage region', () => {
    const r = resolveStage(localStage, 'dev');
    expect(r.ledgerRegion).toBe('us-east-1');
    expect(r.ledgerEndpoint).toBe('http://localhost:8000');
  });

  it('does NOT inherit stage.endpoint when ledger region diverges from stage region', () => {
    const splitRegion: Config = {
      ...localStage,
      ledger: { region: 'us-west-2' },
    };
    const r = resolveStage(splitRegion, 'dev');
    expect(r.ledgerRegion).toBe('us-west-2');
    expect(r.ledgerEndpoint).toBeUndefined();
  });

  it('explicit ledger.endpoint always wins over inheritance', () => {
    const explicit: Config = {
      ...localStage,
      ledger: { region: 'us-west-2', endpoint: 'http://ledger.local:9000' },
    };
    expect(resolveStage(explicit, 'dev').ledgerEndpoint).toBe('http://ledger.local:9000');
  });

  it('stage.ledgerEndpoint wins over ledger.endpoint', () => {
    const withBoth: Config = {
      ...localStage,
      ledger: { region: 'us-west-2', endpoint: 'http://global-ledger.local:9000' },
      stages: {
        dev: {
          ...localStage.stages.dev,
          ledgerEndpoint: 'http://stage-ledger.local:9001',
        },
      },
    };
    expect(resolveStage(withBoth, 'dev').ledgerEndpoint).toBe('http://stage-ledger.local:9001');
  });
});

describe('resolveTableName', () => {
  it('uses tablePrefix to compose physical table names', () => {
    expect(resolveTableName(cfg, 'dev', 'users')).toBe('myapp-dev-users');
  });

  it('honors per-table overrides over tablePrefix', () => {
    expect(resolveTableName(cfg, 'prod', 'users')).toBe('override-users');
  });

  it('returns the logical name when no prefix or override is set', () => {
    expect(resolveTableName(cfg, 'bare', 'users')).toBe('users');
  });
});
