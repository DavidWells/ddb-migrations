import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTableName } from './config.js';
import type { Clients } from './ddb.js';
import type { Ledger } from './ledger.js';
import type {
  Config,
  Logger,
  MigrationContext,
  MigrationModule,
  MigrationProgressEvent,
} from './types.js';
import { createDdbSdkStats, wrapCountingDdbClient } from './sdk-stats.js';
import {
  createMigrationShutdownController,
  type MigrationShutdownController,
} from './shutdown.js';

/**
 * Register tsx's ESM loader so `await import('foo.ts')` works in-process.
 * Safe to call even if tsx isn't installed; we just skip TS support.
 */
let tsRegistered = false;
export async function ensureTsLoader(): Promise<void> {
  if (tsRegistered) return;
  try {
    const api = await import('tsx/esm/api');
    api.register();
    tsRegistered = true;
  } catch {
    // tsx not present; .ts migrations will fail at import time with a clear error.
  }
}

export async function loadMigration(fullPath: string): Promise<MigrationModule> {
  if (path.extname(fullPath) === '.ts' || path.extname(fullPath) === '.mts') {
    await ensureTsLoader();
  }
  const mod = await import(pathToFileURL(fullPath).href);
  if (typeof mod.up !== 'function') {
    throw new Error(`Migration ${fullPath} must export an 'up' function.`);
  }
  return {
    description: typeof mod.description === 'string' ? mod.description : undefined,
    up: mod.up,
    down: typeof mod.down === 'function' ? mod.down : undefined,
  };
}

/**
 * Imports a migration and returns its non-function exports (description, phase, destructive, ...).
 * Importing runs the module's top level, so migrations must keep it free of side effects.
 */
export async function loadMigrationMeta(fullPath: string): Promise<Record<string, unknown>> {
  if (path.extname(fullPath) === '.ts' || path.extname(fullPath) === '.mts') {
    await ensureTsLoader();
  }
  const mod = (await import(pathToFileURL(fullPath).href)) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(mod).filter(([name, value]) => name !== 'default' && typeof value !== 'function'),
  );
}

export type ContextOpts = {
  cfg: Config;
  stage: string;
  migrationId: string;
  ledger: Ledger;
  clients: Clients;
  logger: Logger;
  dryRun: boolean;
  shutdown?: MigrationShutdownController;
  signal?: AbortSignal;
  onProgress?: (event: MigrationProgressEvent) => void;
  sdkStatsEnabled?: boolean;
  captureConsumedCapacity?: boolean;
  params?: Record<string, unknown>;
  /** Runs before every ctx.checkpoint, dry-run included (e.g. a lock heartbeat). */
  beforeCheckpoint?: () => Promise<void>;
};

export function makeContext(opts: ContextOpts): MigrationContext {
  const { cfg, stage, migrationId, ledger, clients, logger, dryRun } = opts;
  const shutdown =
    opts.shutdown ?? createMigrationShutdownController(opts.signal);
  const sdkStats = createDdbSdkStats();
  const sdkStatsEnabled = opts.sdkStatsEnabled ?? cfg.observability?.sdkStatsEnabled ?? true;
  const captureConsumedCapacity =
    opts.captureConsumedCapacity ?? cfg.observability?.captureConsumedCapacity ?? false;
  const ddb = sdkStatsEnabled
    ? wrapCountingDdbClient(clients.doc, {
      stats: sdkStats,
      source: 'app',
      captureConsumedCapacity,
    })
    : clients.doc;
  const ddbRaw = sdkStatsEnabled
    ? wrapCountingDdbClient(clients.raw, {
      stats: sdkStats,
      source: 'appRaw',
      captureConsumedCapacity,
    })
    : clients.raw;
  return {
    ddb,
    ddbRaw,
    tableName: (logical) => resolveTableName(cfg, stage, logical),
    stage,
    dryRun,
    params: Object.freeze({ ...opts.params }),
    logger,
    signal: shutdown.signal,
    shouldStop: () => shutdown.isRequested(),
    throwIfStopped: () => shutdown.throwIfRequested(),
    progress: (event) => {
      const enriched = sdkStatsEnabled
        ? { migrationId, sdk: sdkStats.snapshot(), ...event }
        : { migrationId, ...event };
      opts.onProgress?.(enriched);
    },
    sdkStats,
    checkpoint: async (value) => {
      await opts.beforeCheckpoint?.();
      if (dryRun) {
        logger.debug(`(dry-run) skipping checkpoint write: ${JSON.stringify(value)}`);
        return;
      }
      await ledger.setCheckpoint(migrationId, value);
    },
    getCheckpoint: async () => ledger.getCheckpoint(migrationId),
  };
}
