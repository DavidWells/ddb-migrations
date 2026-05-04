import { describe, expect, it } from 'vitest';
import { resolveStage, resolveTableName } from '../../src/lib/config.js';
import type { Config } from '../../src/lib/types.js';

const cfg: Config = {
  appName: 'myapp',
  migrationsDir: 'migrations',
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

describe('resolveStage', () => {
  it('uses an explicit ledgerTable when provided', () => {
    expect(resolveStage(cfg, 'prod').ledgerTable).toBe('custom-ledger');
  });

  it('falls back to the default ledger table name', () => {
    expect(resolveStage(cfg, 'dev').ledgerTable).toBe('myapp-migrations-dev');
  });

  it('throws for an unknown stage', () => {
    expect(() => resolveStage(cfg, 'staging')).toThrow(/unknown stage/i);
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
