import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checksumFile } from './checksum.js';
import type { Config, MigrationFile } from './types.js';

const VALID_EXT = new Set(['.ts', '.mts', '.mjs', '.js', '.cjs']);

export async function listMigrationFiles(
  cfg: Config,
  cwd: string = process.cwd(),
): Promise<MigrationFile[]> {
  const dir = path.resolve(cwd, cfg.migrationsDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = entries
    .filter((f) => !f.startsWith('.'))
    .filter((f) => !f.endsWith('.d.ts'))
    .filter((f) => VALID_EXT.has(path.extname(f)))
    .sort();
  const out: MigrationFile[] = [];
  for (const f of files) {
    const fullPath = path.join(dir, f);
    const id = path.basename(f, path.extname(f));
    const checksum = await checksumFile(fullPath);
    out.push({ id, fileName: f, fullPath, checksum });
  }
  return out;
}
