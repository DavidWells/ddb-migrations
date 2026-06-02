import pc from 'picocolors';
import type { MigrationProgressEvent } from './types.js';

export type ProgressStream = {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
};

export type ProgressPrinter = {
  print(event: MigrationProgressEvent): void;
  finish(): void;
};

const PRIORITY_KEYS = [
  'phase',
  'operation',
  'table',
  'scanned',
  'applied',
  'written',
  'updated',
  'deleted',
  'skipped',
  'total',
  'remaining',
  'etaSeconds',
  'done',
  'checkpointed',
] as const;

export function createProgressPrinter(stream: ProgressStream = process.stderr): ProgressPrinter {
  const isTty = stream.isTTY === true;
  let activeLine = false;

  return {
    print(event) {
      const line = formatProgressEvent(event);
      if (line.length === 0) return;

      if (!isTty) {
        stream.write(`${pc.gray(line)}\n`);
        return;
      }

      const columns = Math.max((stream.columns ?? 100) - 1, 20);
      stream.write(`\r\u001b[2K${pc.gray(truncate(line, columns))}`);
      activeLine = true;
    },
    finish() {
      if (!isTty || !activeLine) return;
      stream.write('\n');
      activeLine = false;
    },
  };
}

export function formatProgressEvent(event: MigrationProgressEvent): string {
  const prefix = `[${event.migrationId ?? 'migration'}]`;
  if (event.message) return `${prefix} ${event.message}`;

  const labels: string[] = [];
  if (typeof event.phase === 'string' && event.phase.length > 0) labels.push(event.phase);
  if (typeof event.operation === 'string' && event.operation.length > 0) labels.push(event.operation);
  if (typeof event.table === 'string' && event.table.length > 0) labels.push(event.table);

  const details: string[] = [];
  if (typeof event.applied === 'number' && typeof event.total === 'number') {
    details.push(`${event.applied}/${event.total}`);
  }

  for (const key of orderedKeys(event)) {
    if (key === 'migrationId' || key === 'message' || key === 'phase' || key === 'operation' || key === 'table') {
      continue;
    }
    if (key === 'applied' && typeof event.total === 'number') continue;
    if (key === 'etaSeconds' && typeof event.etaSeconds === 'number') {
      details.push(`eta=${formatDuration(event.etaSeconds)}`);
      continue;
    }
    const value = event[key];
    if (value === undefined) continue;
    details.push(`${key}=${String(value)}`);
  }

  return [prefix, ...labels, ...details].join(' ');
}

function orderedKeys(event: MigrationProgressEvent): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of PRIORITY_KEYS) {
    if (key in event) {
      keys.push(key);
      seen.add(key);
    }
  }
  for (const key of Object.keys(event).sort()) {
    if (!seen.has(key)) keys.push(key);
  }
  return keys;
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const remainingSeconds = whole % 60;
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
}

function truncate(value: string, columns: number): string {
  if (value.length <= columns) return value;
  if (columns <= 1) return value.slice(0, columns);
  return `${value.slice(0, columns - 1)}…`;
}
