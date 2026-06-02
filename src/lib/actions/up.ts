import os from 'node:os';
import { loadConfig, resolveStage } from '../config.js';
import { createClients } from '../ddb.js';
import { Ledger } from '../ledger.js';
import { listMigrationFiles } from '../migrations.js';
import { makeLogger } from '../logger.js';
import { loadMigration, makeContext } from '../runner.js';
import {
  createMigrationShutdownController,
  isMigrationInterruptedError,
} from '../shutdown.js';
import { assertConfiguredAccount } from '../aws-identity.js';
import type { MigrationProgressEvent } from '../types.js';

export type UpOptions = {
  stage: string;
  /** Apply migrations only up to and including this id. */
  to?: string;
  /** Run with ctx.dryRun=true and skip ledger writes. */
  dryRun?: boolean;
  cwd?: string;
  /** Cooperative shutdown signal. The current migration can stop at a page boundary. */
  signal?: AbortSignal;
  /** Structured progress callback for long-running migrations. */
  onProgress?: (event: MigrationProgressEvent) => void;
  /** Notifies the caller when the active migration changes. Intended for CLI shutdown fallback. */
  onActiveMigration?: (migrationId: string | undefined) => void;
  /** Validate configured accountId before non-dry-run writes. */
  checkAccount?: boolean;
};

export type UpResult = {
  applied: string[];
  skipped: string[];
  failed?: { id: string; message: string };
  interrupted?: { id?: string; message: string };
};

export async function up(opts: UpOptions): Promise<UpResult> {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = await loadConfig(cwd);
  const sc = resolveStage(cfg, opts.stage);
  if (!opts.dryRun && opts.checkAccount !== false) await assertConfiguredAccount(sc);
  const clients = createClients(sc);
  const ledger = new Ledger(clients.ledgerRaw, clients.ledgerDoc, {
    tableName: sc.ledgerTable,
    scope: sc.ledgerScope,
    stage: opts.stage,
    accountId: sc.accountId,
    region: sc.region,
  });
  await ledger.ensureExists();

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
  if (opts.to) {
    const idx = pending.findIndex((p) => p.id === opts.to);
    if (idx === -1) {
      throw new Error(`Migration '${opts.to}' is not pending (not found, or already completed).`);
    }
    slice = pending.slice(0, idx + 1);
  }

  const applied: string[] = [];
  const skipped: string[] = pending.filter((p) => !slice.includes(p)).map((p) => p.id);
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
        applied,
        skipped,
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
    if (!opts.dryRun) {
      await ledger.markStart({
        migrationId: f.id,
        checksum: f.checksum,
        appliedBy: `${os.userInfo().username}@${os.hostname()}`,
      });
    }
    activeMigrationId = f.id;
    opts.onActiveMigration?.(f.id);
    const ctx = makeContext({
      cfg,
      stage: opts.stage,
      migrationId: f.id,
      ledger,
      clients,
      logger: log,
      dryRun: !!opts.dryRun,
      shutdown,
      onProgress: opts.onProgress,
    });
    const start = Date.now();
    try {
      await mod.up(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMigrationInterruptedError(err)) {
        await markActiveInterrupted(message);
        log.warn(message);
        return { applied, skipped, interrupted: { id: f.id, message } };
      }
      if (!opts.dryRun) await ledger.markFailed(f.id, message);
      log.error(`failed: ${message}`);
      return { applied, skipped, failed: { id: f.id, message } };
    }
    const dur = Date.now() - start;
    if (shutdown.isRequested()) {
      const message = shutdown.reason() ?? 'Shutdown requested after migration returned';
      await markActiveInterrupted(message);
      log.warn(message);
      return { applied, skipped, interrupted: { id: f.id, message } };
    }
    if (!opts.dryRun) await ledger.markComplete(f.id, dur);
    log.info(`done in ${dur}ms${opts.dryRun ? ' (dry-run)' : ''}`);
    applied.push(f.id);
    activeMigrationId = undefined;
    opts.onActiveMigration?.(undefined);

    if (shutdown.isRequested()) {
      await markActiveInterrupted(shutdown.reason() ?? 'Shutdown requested; stopped before next migration');
      return {
        applied,
        skipped,
        interrupted: {
          message: shutdown.reason() ?? 'Shutdown requested; stopped before next migration',
        },
      };
    }
  }
  return { applied, skipped };
}
