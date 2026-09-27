import { loadConfig, resolveStage } from '../config.js';
import { createClients } from '../ddb.js';
import { stageLedger, type Ledger } from '../ledger.js';

export type CheckpointShowOptions = {
  stage: string;
  migrationId: string;
  cwd?: string;
};

export type CheckpointShowResult = {
  stage: string;
  migrationId: string;
  found: boolean;
  checkpoint?: Record<string, unknown>;
};

export type CheckpointClearOptions = CheckpointShowOptions;

export type CheckpointClearResult = CheckpointShowResult & {
  cleared: boolean;
};

export async function showCheckpoint(
  opts: CheckpointShowOptions,
): Promise<CheckpointShowResult> {
  const ledger = await ledgerFor(opts.cwd, opts.stage);
  const entry = await ledger.get(opts.migrationId);
  return {
    stage: opts.stage,
    migrationId: opts.migrationId,
    found: !!entry?.checkpoint,
    checkpoint: entry?.checkpoint,
  };
}

export async function clearCheckpoint(
  opts: CheckpointClearOptions,
): Promise<CheckpointClearResult> {
  const ledger = await ledgerFor(opts.cwd, opts.stage);
  const entry = await ledger.get(opts.migrationId);
  if (entry?.checkpoint) await ledger.clearCheckpoint(opts.migrationId);
  return {
    stage: opts.stage,
    migrationId: opts.migrationId,
    found: !!entry?.checkpoint,
    checkpoint: entry?.checkpoint,
    cleared: !!entry?.checkpoint,
  };
}

async function ledgerFor(cwd: string | undefined, stage: string): Promise<Ledger> {
  const cfg = await loadConfig(cwd ?? process.cwd());
  const sc = resolveStage(cfg, stage);
  const ledger = stageLedger(sc, createClients(sc));
  await ledger.ensureExists();
  return ledger;
}
