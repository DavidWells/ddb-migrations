import { describe, expect, it } from 'vitest';
import {
  MigrationInterruptedError,
  createMigrationShutdownController,
  isMigrationInterruptedError,
} from '../../src/lib/shutdown.js';

describe('migration shutdown controller', () => {
  it('tracks cooperative shutdown requests', () => {
    const shutdown = createMigrationShutdownController();

    expect(shutdown.isRequested()).toBe(false);
    expect(shutdown.signal.aborted).toBe(false);

    shutdown.request('received SIGINT');

    expect(shutdown.isRequested()).toBe(true);
    expect(shutdown.signal.aborted).toBe(true);
    expect(shutdown.reason()).toBe('received SIGINT');
    expect(() => shutdown.throwIfRequested()).toThrow(MigrationInterruptedError);
  });

  it('follows a parent AbortSignal', () => {
    const parent = new AbortController();
    const shutdown = createMigrationShutdownController(parent.signal);

    parent.abort('operator stop');

    expect(shutdown.isRequested()).toBe(true);
    expect(shutdown.reason()).toBe('operator stop');
    try {
      shutdown.throwIfRequested();
      throw new Error('expected throwIfRequested to throw');
    } catch (err) {
      expect(isMigrationInterruptedError(err)).toBe(true);
      expect((err as Error).message).toContain('operator stop');
    }
  });
});
