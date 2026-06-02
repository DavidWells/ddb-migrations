import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { findConfig, loadConfig, resolveStage } from '../config.js';
import { createClients } from '../ddb.js';
import { Ledger } from '../ledger.js';
import { listMigrationFiles } from '../migrations.js';
import type { LedgerEntry, LedgerStatus } from '../types.js';

export type PlanMigration = {
  id: string;
  fileName: string;
  status: LedgerStatus | 'pending' | 'orphan';
  checksumMatch: boolean | null;
  willRun: boolean;
  reason: string;
};

export type PlanResult = {
  cwd: string;
  configPath: string;
  stage: string;
  region: string;
  accountId?: string;
  ledgerTable: string;
  ledgerScope: string;
  migrations: PlanMigration[];
  run: string[];
  skipped: string[];
  drifted: string[];
  blocked: string[];
  orphaned: string[];
};

export type PlanOptions = {
  stage: string;
  cwd?: string;
  to?: string;
};

export async function plan(opts: PlanOptions): Promise<PlanResult> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = await findConfig(cwd);
  const cfg = await loadConfig(cwd);
  const sc = resolveStage(cfg, opts.stage);
  const { ledgerRaw, ledgerDoc } = createClients(sc);
  const ledger = new Ledger(ledgerRaw, ledgerDoc, {
    tableName: sc.ledgerTable,
    scope: sc.ledgerScope,
    stage: opts.stage,
    accountId: sc.accountId,
    region: sc.region,
  });

  const files = await listMigrationFiles(cfg, cwd);
  const entries = await listLedgerEntriesIfPresent(ledger);
  const entriesById = new Map(entries.map((entry) => [entry.migrationId, entry]));
  const fileIds = new Set(files.map((file) => file.id));

  const pending = files.filter((file) => entriesById.get(file.id)?.status !== 'completed');
  let runnable = pending;
  if (opts.to) {
    const idx = pending.findIndex((file) => file.id === opts.to);
    if (idx === -1) {
      throw new Error(`Migration '${opts.to}' is not pending (not found, or already completed).`);
    }
    runnable = pending.slice(0, idx + 1);
  }
  const runnableIds = new Set(runnable.map((file) => file.id));

  const migrations: PlanMigration[] = files.map((file) => {
    const entry = entriesById.get(file.id);
    const status = entry?.status ?? 'pending';
    const checksumMatch = entry ? entry.checksum === file.checksum : null;
    const willRun = runnableIds.has(file.id);
    return {
      id: file.id,
      fileName: file.fileName,
      status,
      checksumMatch,
      willRun,
      reason: reasonForFile(status, checksumMatch, willRun, opts.to),
    };
  });

  for (const entry of entries) {
    if (!fileIds.has(entry.migrationId)) {
      migrations.push({
        id: entry.migrationId,
        fileName: '<missing file>',
        status: 'orphan',
        checksumMatch: null,
        willRun: false,
        reason: 'ledger entry has no matching migration file',
      });
    }
  }

  migrations.sort((a, b) => a.id.localeCompare(b.id));

  return {
    cwd,
    configPath,
    stage: opts.stage,
    region: sc.region,
    accountId: sc.accountId,
    ledgerTable: sc.ledgerTable,
    ledgerScope: sc.ledgerScope,
    migrations,
    run: migrations.filter((migration) => migration.willRun).map((migration) => migration.id),
    skipped: migrations
      .filter((migration) => !migration.willRun && migration.status !== 'orphan')
      .map((migration) => migration.id),
    drifted: migrations
      .filter((migration) => migration.checksumMatch === false)
      .map((migration) => migration.id),
    blocked: migrations
      .filter((migration) => migration.status === 'failed' || migration.status === 'in_progress' || migration.status === 'interrupted')
      .map((migration) => migration.id),
    orphaned: migrations
      .filter((migration) => migration.status === 'orphan')
      .map((migration) => migration.id),
  };
}

async function listLedgerEntriesIfPresent(ledger: Ledger): Promise<LedgerEntry[]> {
  try {
    return await ledger.listAll();
  } catch (err) {
    if (err instanceof ResourceNotFoundException || hasName(err, 'ResourceNotFoundException')) {
      return [];
    }
    throw err;
  }
}

function hasName(err: unknown, name: string): boolean {
  return !!err && typeof err === 'object' && 'name' in err && err.name === name;
}

function reasonForFile(
  status: PlanMigration['status'],
  checksumMatch: boolean | null,
  willRun: boolean,
  to?: string,
): string {
  if (checksumMatch === false) return 'checksum drift; up will refuse to continue';
  if (willRun) return 'pending and selected for execution';
  if (status === 'completed') return 'already completed';
  if (status === 'failed') return 'previous run failed; up will retry unless drifted';
  if (status === 'in_progress') return 'previous run interrupted; up will resume/retry';
  if (status === 'interrupted') return 'previous run was interrupted; up will resume/retry';
  if (to) return `pending but outside --to ${to} slice`;
  return 'pending';
}
