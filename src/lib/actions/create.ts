import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';

const TEMPLATE = `import type { MigrationContext } from 'ddb-migrations';

export const description = '__DESCRIPTION__';

export async function up(ctx: MigrationContext): Promise<void> {
  // const Users = ctx.tableName('users');
  // ...
}

export async function down(ctx: MigrationContext): Promise<void> {
  // Inverse of up(), or throw if not reversible.
  throw new Error('down() not implemented');
}
`;

export async function create(
  description: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const cfg = await loadConfig(cwd);
  const slug = slugify(description);
  if (!slug) throw new Error('Description must contain at least one alphanumeric character.');
  const id = `${timestamp()}-${slug}`;
  const fileName = `${id}.ts`;
  const dir = path.resolve(cwd, cfg.migrationsDir);
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, fileName);
  const body = TEMPLATE.replace('__DESCRIPTION__', description.replace(/'/g, "\\'"));
  await fs.writeFile(fullPath, body);
  return path.relative(cwd, fullPath);
}

export function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-` +
    `${pad(date.getUTCMonth() + 1)}-` +
    `${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
