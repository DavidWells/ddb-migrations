import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { checksumDirectory, checksumFile } from './checksum.js';
import type { Config, MigrationFile } from './types.js';

const VALID_EXT = new Set(['.ts', '.mts', '.mjs', '.js', '.cjs']);
const ENTRYPOINT_BASENAMES = ['index.ts', 'index.mts', 'index.mjs', 'index.js', 'index.cjs'];

export async function listMigrationFiles(
  cfg: Config,
  cwd: string = process.cwd(),
): Promise<MigrationFile[]> {
  const dir = path.resolve(cwd, cfg.migrationsDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: MigrationFile[] = [];
  const visibleEntries = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of visibleEntries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const fullPath = await findDirectoryEntrypoint(entryPath);
      if (!fullPath) {
        throw new Error(
          `Migration directory '${entry.name}' must contain one of: ${ENTRYPOINT_BASENAMES.join(', ')}.`,
        );
      }
      const checksum = await checksumDirectory(entryPath);
      out.push({
        id: entry.name,
        fileName: `${entry.name}/`,
        fullPath,
        checksum,
        kind: 'directory',
      });
      continue;
    }

    if (!entry.isFile() || entry.name.endsWith('.d.ts') || !VALID_EXT.has(path.extname(entry.name))) {
      continue;
    }

    const fullPath = entryPath;
    const id = path.basename(entry.name, path.extname(entry.name));
    const checksum = await checksumFile(fullPath);
    out.push({ id, fileName: entry.name, fullPath, checksum, kind: 'file' });
  }
  return out;
}

async function findDirectoryEntrypoint(dir: string): Promise<string | null> {
  for (const basename of ENTRYPOINT_BASENAMES) {
    const fullPath = path.join(dir, basename);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) return fullPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}
