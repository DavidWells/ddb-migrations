import { loadConfig, resolveStage } from '../config.js';
import { createClients } from '../ddb.js';
import { Ledger } from '../ledger.js';
import { listMigrationFiles } from '../migrations.js';
import { makeLogger } from '../logger.js';
import { loadMigration, makeContext } from '../runner.js';
import { assertConfiguredAccount } from '../aws-identity.js';
import type { MigrationProgressEvent } from '../types.js';
import { isMigrationInterruptedError } from '../shutdown.js';

export type DownOptions = {
  stage: string;
  /** Number of migrations to roll back. 0 = all. Default: 1. */
  shift?: number;
  /** Run with ctx.dryRun=true and skip ledger writes. */
  dryRun?: boolean;
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (event: MigrationProgressEvent) => void;
  checkAccount?: boolean;
};

export type DownResult = {
  rolledBack: string[];
  failed?: { id: string; message: string };
  interrupted?: { id?: string; message: string };
};

export async function down(opts: DownOptions): Promise<DownResult> {
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
  const filesById = new Map(files.map((f) => [f.id, f]));
  const completed = (await ledger.listAll()).filter((e) => e.status === 'completed');

  const shift = opts.shift ?? 1;
  const target = shift === 0 ? completed.slice() : completed.slice(-shift);
  const ordered = target.reverse();

  const rolledBack: string[] = [];
  for (const e of ordered) {
    const log = makeLogger(`[${e.migrationId}]`);
    const file = filesById.get(e.migrationId);
    if (!file) {
      const message = 'cannot roll back: migration file not found in migrationsDir';
      log.error(message);
      return { rolledBack, failed: { id: e.migrationId, message } };
    }
    const mod = await loadMigration(file.fullPath);
    if (!mod.down) {
      const message = "cannot roll back: migration has no exported 'down' function";
      log.error(message);
      return { rolledBack, failed: { id: e.migrationId, message } };
    }
    const ctx = makeContext({
      cfg,
      stage: opts.stage,
      migrationId: e.migrationId,
      ledger,
      clients,
      logger: log,
      dryRun: !!opts.dryRun,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    log.info(opts.dryRun ? 'rolling back (dry-run)' : 'rolling back');
    try {
      await mod.down(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMigrationInterruptedError(err)) {
        log.warn(message);
        return { rolledBack, interrupted: { id: e.migrationId, message } };
      }
      log.error(`down failed: ${message}`);
      return { rolledBack, failed: { id: e.migrationId, message } };
    }
    if (!opts.dryRun) await ledger.remove(e.migrationId);
    rolledBack.push(e.migrationId);
  }
  return { rolledBack };
}
