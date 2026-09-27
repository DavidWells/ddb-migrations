import { loadConfig, resolveStage } from '../config.js';
import { createClients } from '../ddb.js';
import { stageLedger } from '../ledger.js';

export type MarkInterruptedOptions = {
  stage: string;
  migrationId: string;
  message: string;
  cwd?: string;
};

export type MarkInterruptedResult = {
  stage: string;
  migrationId: string;
  marked: boolean;
};

export async function markInterrupted(
  opts: MarkInterruptedOptions,
): Promise<MarkInterruptedResult> {
  const cfg = await loadConfig(opts.cwd ?? process.cwd());
  const sc = resolveStage(cfg, opts.stage);
  const ledger = stageLedger(sc, createClients(sc));
  await ledger.ensureExists();
  const marked = await ledger.markInterrupted(opts.migrationId, opts.message);
  return {
    stage: opts.stage,
    migrationId: opts.migrationId,
    marked,
  };
}
