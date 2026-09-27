import os from 'node:os';
import { resolveConfig, resolveStage } from '../config.js';
import { createClients, type Clients, type InjectedClients } from '../ddb.js';
import { stageLedger, type Ledger } from '../ledger.js';
import { openRunLock, type RunLock, type RunLockInfo, type RunLockOptions } from '../lock.js';
import { listMigrationFiles } from '../migrations.js';
import { makeLogger } from '../logger.js';
import { loadMigration, makeContext } from '../runner.js';
import {
  createMigrationShutdownController,
  isMigrationInterruptedError,
} from '../shutdown.js';
import { assertConfiguredAccount } from '../aws-identity.js';
import { LedgerConflictError, LockLostError } from '../errors.js';
import type { Config, MigrationProgressEvent } from '../types.js';
import type { DdbSdkStatsSnapshot } from '../sdk-stats.js';

export type UpOptions = {
  stage: string;
  /** Apply migrations only up to and including this id. */
  to?: string;
  /** Apply only these pending ids, in lexical order; the rest stay pending. Cannot be combined with `to`. */
  only?: string[];
  /** Run with ctx.dryRun=true and skip ledger writes. */
  dryRun?: boolean;
  cwd?: string;
  /** Config object used instead of the cwd config file. `cwd` still sets the base for migrationsDir. */
  config?: Config;
  /** Caller-built app/ledger clients that replace the default-chain ones. */
  clients?: InjectedClients;
  /** Identity recorded as appliedBy on ledger rows. Defaults to user@host. */
  appliedBy?: string;
  /** Run parameters exposed to migrations as a frozen shallow copy on ctx.params. */
  params?: Record<string, unknown>;
  /**
   * Lease lock for this scope+stage. Acquired before reading the ledger, heartbeated before each
   * migration and on each ctx.checkpoint, released when up finishes. With `held: true` the caller
   * already holds it: up only verifies ownership, never releases, and skips heartbeats in a dry-run.
   */
  lock?: RunLockOptions;
  /** Cooperative shutdown signal. The current migration can stop at a page boundary. */
  signal?: AbortSignal;
  /** Structured progress callback for long-running migrations. */
  onProgress?: (event: MigrationProgressEvent) => void;
  /** Lifecycle events for each migration: start, progress, checkpoint, complete, fail, interrupt. */
  onEvent?: (event: UpEvent) => void;
  /** Notifies the caller when the active migration changes. Intended for CLI shutdown fallback. */
  onActiveMigration?: (migrationId: string | undefined) => void;
  /** Validate configured accountId before non-dry-run writes. */
  checkAccount?: boolean;
  /** Wrap migration app clients and collect SDK send() stats. Defaults to config or true. */
  sdkStatsEnabled?: boolean;
  /** Request ReturnConsumedCapacity=TOTAL on supported migration app commands. Defaults to config or false. */
  captureConsumedCapacity?: boolean;
};

export type UpMigrationStatus = 'completed' | 'dry-run' | 'failed' | 'interrupted';

/** One migration this run executed. */
export type UpMigrationResult = {
  id: string;
  checksum: string;
  status: UpMigrationStatus;
  durationMs: number;
  /** Per-migration SDK stats, when SDK stats are enabled. */
  sdkStats?: DdbSdkStatsSnapshot;
  /** The last ctx.progress event, when the migration emitted any. */
  progress?: MigrationProgressEvent;
  /** Error message for failed and interrupted migrations. */
  error?: string;
};

export type UpEvent =
  | { type: 'start'; id: string; checksum: string; dryRun: boolean }
  | { type: 'progress'; id: string; progress: MigrationProgressEvent }
  | { type: 'checkpoint'; id: string; checkpoint: Record<string, unknown> }
  | { type: 'complete'; id: string; status: 'completed' | 'dry-run'; durationMs: number }
  | { type: 'fail'; id: string; error: string; durationMs: number }
  | { type: 'interrupt'; id: string; error: string; durationMs: number };

export type UpResult = {
  applied: string[];
  skipped: string[];
  /** Every migration this run executed, in order, with its outcome. */
  results: UpMigrationResult[];
  /** Ids still not completed after this run, in lexical order. A dry-run completes nothing. */
  pending: string[];
  sdkStats?: { byMigration: Record<string, DdbSdkStatsSnapshot> };
  failed?: { id: string; message: string };
  interrupted?: { id?: string; message: string };
  /** Present when options.lock was used. `released` is false when the lease was lost or held by the caller. */
  lock?: RunLockInfo & { released: boolean };
};

export async function up(opts: UpOptions): Promise<UpResult> {
  if (opts.only && opts.to) throw new Error('up options only and to cannot be combined.');
  const cwd = opts.cwd ?? process.cwd();
  const cfg = await resolveConfig(cwd, opts.config);
  const sc = resolveStage(cfg, opts.stage);
  const clients = createClients(sc, opts.clients);
  if (!opts.dryRun && opts.checkAccount !== false) {
    await assertConfiguredAccount(sc, opts.clients?.app ? clients.raw.config.credentials : undefined);
  }
  const ledger = stageLedger(sc, clients);
  await ledger.ensureExists();

  const lock = opts.lock
    ? await openRunLock({
      ledgerClient: clients.ledgerDoc,
      tableName: sc.ledgerTable,
      scope: sc.ledgerScope,
      stage: opts.stage,
      lock: opts.lock,
      dryRun: !!opts.dryRun,
    })
    : undefined;

  let result: UpResult;
  try {
    result = await applyPending({ opts, cfg, cwd, clients, ledger, lock });
  } catch (err) {
    // The original error matters more than a failed release; the lease expires on its own.
    await lock?.release().catch(() => false);
    throw err;
  }
  if (!lock) return result;
  const released = await lock.release();
  return { ...result, lock: { ...lock.info, released } };
}

type ApplyPendingInput = {
  opts: UpOptions;
  cfg: Config;
  cwd: string;
  clients: Clients;
  ledger: Ledger;
  lock?: RunLock;
};

async function applyPending({ opts, cfg, cwd, clients, ledger, lock }: ApplyPendingInput): Promise<UpResult> {
  const files = await listMigrationFiles(cfg, cwd);
  const entries = await ledger.listAll();
  const entriesById = new Map(entries.map((e) => [e.migrationId, e]));

  // Drift detection on completed entries.
  for (const f of files) {
    const e = entriesById.get(f.id);
    if (e?.status === 'completed' && e.checksum !== f.checksum) {
      throw new Error(
        `Checksum drift on already-applied migration '${f.id}'. ` +
          `Stage: ${opts.stage}. The migration file has been modified since it was applied. ` +
          `Restore the original file or roll back before continuing.`,
      );
    }
  }

  const pending = files.filter((f) => {
    const e = entriesById.get(f.id);
    return !e || e.status !== 'completed';
  });

  let slice = pending;
  if (opts.only) {
    const pendingIds = new Set(pending.map((p) => p.id));
    const missing = opts.only.find((id) => !pendingIds.has(id));
    if (missing !== undefined) {
      throw new Error(`Migration '${missing}' is not pending (not found, or already completed).`);
    }
    const only = new Set(opts.only);
    slice = pending.filter((p) => only.has(p.id));
  } else if (opts.to) {
    const idx = pending.findIndex((p) => p.id === opts.to);
    if (idx === -1) {
      throw new Error(`Migration '${opts.to}' is not pending (not found, or already completed).`);
    }
    slice = pending.slice(0, idx + 1);
  }

  const applied: string[] = [];
  const skipped: string[] = pending.filter((p) => !slice.includes(p)).map((p) => p.id);
  const sdkStatsEnabled = opts.sdkStatsEnabled ?? cfg.observability?.sdkStatsEnabled ?? true;
  const sdkStatsByMigration: Record<string, DdbSdkStatsSnapshot> = {};
  const results: UpMigrationResult[] = [];
  const lastProgress = new Map<string, MigrationProgressEvent>();
  const resultBase = (): Pick<UpResult, 'applied' | 'skipped' | 'results' | 'pending' | 'sdkStats'> => ({
    applied,
    skipped,
    results,
    pending: pending
      .map((p) => p.id)
      .filter((id) => !(results.some((r) => r.id === id && r.status === 'completed'))),
    ...(sdkStatsEnabled ? { sdkStats: { byMigration: sdkStatsByMigration } } : {}),
  });
  const record = (
    f: { id: string; checksum: string },
    status: UpMigrationStatus,
    durationMs: number,
    error?: string,
  ): void => {
    const progress = lastProgress.get(f.id);
    results.push({
      id: f.id,
      checksum: f.checksum,
      status,
      durationMs,
      ...(sdkStatsByMigration[f.id] ? { sdkStats: sdkStatsByMigration[f.id] } : {}),
      ...(progress ? { progress } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    if (status === 'completed' || status === 'dry-run') {
      opts.onEvent?.({ type: 'complete', id: f.id, status, durationMs });
    } else {
      opts.onEvent?.({
        type: status === 'failed' ? 'fail' : 'interrupt',
        id: f.id,
        error: error ?? '',
        durationMs,
      });
    }
  };
  const shutdown = createMigrationShutdownController(opts.signal);
  let activeMigrationId: string | undefined;
  let interruptMarkedFor: string | undefined;
  let interruptMarkPromise: Promise<void> | undefined;

  const markActiveInterrupted = (message: string): Promise<void> => {
    if (opts.dryRun || !activeMigrationId) return Promise.resolve();
    if (interruptMarkedFor === activeMigrationId && interruptMarkPromise) return interruptMarkPromise;
    interruptMarkedFor = activeMigrationId;
    interruptMarkPromise = ledger.markInterrupted(activeMigrationId, message).then(() => undefined);
    return interruptMarkPromise;
  };

  shutdown.signal.addEventListener('abort', () => {
    const message = shutdown.reason() ?? 'Shutdown requested';
    interruptMarkPromise = markActiveInterrupted(message).catch(() => undefined);
  });

  for (const f of slice) {
    if (shutdown.isRequested()) {
      await markActiveInterrupted(shutdown.reason() ?? 'Shutdown requested before migration start');
      return {
        ...resultBase(),
        interrupted: {
          id: f.id,
          message: shutdown.reason() ?? 'Shutdown requested before migration start',
        },
      };
    }

    const log = makeLogger(`[${f.id}]`);
    log.info(opts.dryRun ? 'starting (dry-run)' : 'starting');
    const mod = await loadMigration(f.fullPath);
    interruptMarkedFor = undefined;
    interruptMarkPromise = undefined;
    await lock?.heartbeat();
    if (!opts.dryRun) {
      await ledger.markStart({
        migrationId: f.id,
        checksum: f.checksum,
        appliedBy: opts.appliedBy ?? `${os.userInfo().username}@${os.hostname()}`,
      });
    }
    activeMigrationId = f.id;
    opts.onActiveMigration?.(f.id);
    opts.onEvent?.({ type: 'start', id: f.id, checksum: f.checksum, dryRun: !!opts.dryRun });
    const ctx = makeContext({
      cfg,
      stage: opts.stage,
      migrationId: f.id,
      ledger,
      clients,
      logger: log,
      dryRun: !!opts.dryRun,
      shutdown,
      onProgress: (event) => {
        lastProgress.set(f.id, event);
        opts.onEvent?.({ type: 'progress', id: f.id, progress: event });
        opts.onProgress?.(event);
      },
      sdkStatsEnabled: opts.sdkStatsEnabled,
      captureConsumedCapacity: opts.captureConsumedCapacity,
      params: opts.params,
      beforeCheckpoint: lock?.heartbeat,
      afterCheckpoint: (checkpoint) => opts.onEvent?.({ type: 'checkpoint', id: f.id, checkpoint }),
    });
    const start = Date.now();
    try {
      await mod.up(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (sdkStatsEnabled) sdkStatsByMigration[f.id] = ctx.sdkStats.snapshot();
      if (isMigrationInterruptedError(err)) {
        await markActiveInterrupted(message);
        log.warn(message);
        record(f, 'interrupted', Date.now() - start, message);
        return { ...resultBase(), interrupted: { id: f.id, message } };
      }
      // A conflict or a lost lock means another run may own the row now; leave it to that run.
      const superseded = err instanceof LedgerConflictError || err instanceof LockLostError;
      if (!opts.dryRun && !superseded) await ledger.markFailed(f.id, message);
      log.error(`failed: ${message}`);
      record(f, 'failed', Date.now() - start, message);
      return { ...resultBase(), failed: { id: f.id, message } };
    }
    const dur = Date.now() - start;
    if (sdkStatsEnabled) sdkStatsByMigration[f.id] = ctx.sdkStats.snapshot();
    if (shutdown.isRequested()) {
      const message = shutdown.reason() ?? 'Shutdown requested after migration returned';
      await markActiveInterrupted(message);
      log.warn(message);
      record(f, 'interrupted', dur, message);
      return { ...resultBase(), interrupted: { id: f.id, message } };
    }
    if (!opts.dryRun) await ledger.markComplete(f.id, dur);
    log.info(`done in ${dur}ms${opts.dryRun ? ' (dry-run)' : ''}`);
    applied.push(f.id);
    record(f, opts.dryRun ? 'dry-run' : 'completed', dur);
    activeMigrationId = undefined;
    opts.onActiveMigration?.(undefined);

    if (shutdown.isRequested()) {
      await markActiveInterrupted(shutdown.reason() ?? 'Shutdown requested; stopped before next migration');
      return {
        ...resultBase(),
        interrupted: {
          message: shutdown.reason() ?? 'Shutdown requested; stopped before next migration',
        },
      };
    }
  }
  return resultBase();
}
