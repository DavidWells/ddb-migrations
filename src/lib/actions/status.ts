import { resolveConfig, resolveStage } from '../config.js';
import { createClients, type InjectedClients } from '../ddb.js';
import { stageLedger } from '../ledger.js';
import { listMigrationFiles } from '../migrations.js';
import type { Config, LedgerStatus } from '../types.js';

export type StatusItem = {
  id: string;
  fileName: string;
  appliedAt: string | null;
  status: LedgerStatus | 'pending' | 'orphan';
  checksumMatch: boolean | null;
};

export type StatusOptions = {
  stage: string;
  cwd?: string;
  /** Config object used instead of the cwd config file. `cwd` still sets the base for migrationsDir. */
  config?: Config;
  /** Caller-built ledger client that replaces the default-chain one. */
  clients?: InjectedClients;
};

export async function status(opts: StatusOptions): Promise<StatusItem[]> {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = await resolveConfig(cwd, opts.config);
  const sc = resolveStage(cfg, opts.stage);
  const ledger = stageLedger(sc, createClients(sc, opts.clients));
  await ledger.ensureExists();

  const files = await listMigrationFiles(cfg, cwd);
  const entries = await ledger.listAll();
  const entriesById = new Map(entries.map((e) => [e.migrationId, e]));

  const out: StatusItem[] = files.map((f) => {
    const e = entriesById.get(f.id);
    if (!e) {
      return {
        id: f.id,
        fileName: f.fileName,
        appliedAt: null,
        status: 'pending',
        checksumMatch: null,
      };
    }
    return {
      id: f.id,
      fileName: f.fileName,
      appliedAt: e.appliedAt,
      status: e.status,
      checksumMatch: e.checksum === f.checksum,
    };
  });

  const fileIds = new Set(files.map((f) => f.id));
  for (const e of entries) {
    if (!fileIds.has(e.migrationId)) {
      out.push({
        id: e.migrationId,
        fileName: '<missing file>',
        appliedAt: e.appliedAt,
        status: 'orphan',
        checksumMatch: null,
      });
    }
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}
