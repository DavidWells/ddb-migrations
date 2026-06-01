import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function checksumFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function checksumDirectory(dirPath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const files = await listFiles(dirPath);

  for (const filePath of files) {
    const relativePath = path.relative(dirPath, filePath).split(path.sep).join('/');
    const buf = await fs.readFile(filePath);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(buf.byteLength));
    hash.update('\0');
    hash.update(buf);
    hash.update('\0');
  }

  return hash.digest('hex');
}

async function listFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile() && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
