import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config, ResolvedStage } from './types.js';

const CONFIG_FILES = [
  'ddb-migrations.config.json',
  'ddb-migrations.config.js',
  'ddb-migrations.config.mjs',
  'ddb-migrations.config.ts',
];

export async function findConfig(cwd: string = process.cwd()): Promise<string> {
  for (const name of CONFIG_FILES) {
    const p = path.join(cwd, name);
    try {
      await fs.access(p);
      return p;
    } catch {
      // try next
    }
  }
  throw new Error(
    `No config file found. Expected one of: ${CONFIG_FILES.join(', ')} in ${cwd}. ` +
      `Run 'ddb-migrate init' to scaffold one.`,
  );
}

export async function loadConfig(cwd: string = process.cwd()): Promise<Config> {
  const file = await findConfig(cwd);
  if (file.endsWith('.json')) {
    const raw = await fs.readFile(file, 'utf8');
    return validate(JSON.parse(raw));
  }
  const mod = await import(pathToFileURL(file).href);
  const candidate = mod.default ?? mod.config ?? mod;
  return validate(candidate);
}

function validate(cfg: unknown): Config {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('Config must be an object.');
  }
  const c = cfg as Partial<Config>;
  if (!c.appName || typeof c.appName !== 'string') {
    throw new Error('Config.appName is required (string).');
  }
  if (!c.migrationsDir || typeof c.migrationsDir !== 'string') {
    throw new Error('Config.migrationsDir is required (string).');
  }
  if (!c.stages || typeof c.stages !== 'object') {
    throw new Error('Config.stages is required (object keyed by stage name).');
  }
  for (const [stage, sc] of Object.entries(c.stages)) {
    if (!sc || typeof sc !== 'object') {
      throw new Error(`Config.stages.${stage} must be an object.`);
    }
    if (!sc.region || typeof sc.region !== 'string') {
      throw new Error(`Config.stages.${stage}.region is required (string).`);
    }
  }
  return c as Config;
}

export function resolveStage(cfg: Config, stage: string): ResolvedStage {
  const sc = cfg.stages[stage];
  if (!sc) {
    throw new Error(
      `Unknown stage '${stage}'. Available stages: ${Object.keys(cfg.stages).join(', ')}.`,
    );
  }
  return {
    ...sc,
    stage,
    ledgerTable: sc.ledgerTable ?? cfg.ledger?.tableName ?? 'ddb-migrations-ledger',
    ledgerScope: cfg.ledger?.scope ?? cfg.appName,
  };
}

export function resolveTableName(cfg: Config, stage: string, logical: string): string {
  const sc = cfg.stages[stage];
  if (!sc) throw new Error(`Unknown stage '${stage}'.`);
  if (sc.tables?.[logical]) return sc.tables[logical];
  if (sc.tablePrefix) return `${sc.tablePrefix}${logical}`;
  return logical;
}
