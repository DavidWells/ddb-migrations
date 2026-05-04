import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

export async function checksumFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}
