import pc from 'picocolors';
import type { MigrationProgressEvent } from './types.js';
import type { DdbSdkStatsSnapshot } from './sdk-stats.js';

export type ProgressStream = {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
};

export type ProgressPrinter = {
  print(event: MigrationProgressEvent): void;
  finish(): void;
};

type ProgressTiming = {
  startedAt: number;
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
  'sdk',
  'done',
  'checkpointed',
] as const;

export function createProgressPrinter(stream: ProgressStream = process.stderr): ProgressPrinter {
  const isTty = stream.isTTY === true;
  const timings = new Map<string, ProgressTiming>();
  let activeRows = 0;

  return {
    print(event) {
      if (!isTty) {
        const line = formatProgressEvent(event);
        if (line.length === 0) return;
        stream.write(`${pc.gray(line)}\n`);
        return;
      }

      const columns = Math.max((stream.columns ?? 100) - 1, 20);
      const lines = formatTtyProgressEvent(event, timings).map((line) => truncate(line, columns));
      if (lines.length === 0) return;
      clearActiveRows(stream, activeRows);
      if (isDurableTtyEvent(event)) {
        stream.write(`${pc.gray(lines.join('\n'))}\n`);
        activeRows = 0;
        return;
      }
      stream.write(pc.gray(lines.join('\n')));
      activeRows = lines.length;
      if (event.done === true) this.finish();
    },
    finish() {
      if (!isTty || activeRows === 0) return;
      stream.write('\n');
      activeRows = 0;
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
  const sdk = sdkStats(event.sdk);
  if (sdk) details.push(...formatSdkDetails(sdk, 'sdk.'));

  for (const key of orderedKeys(event)) {
    if (
      key === 'migrationId' ||
      key === 'message' ||
      key === 'phase' ||
      key === 'operation' ||
      key === 'table' ||
      key === 'sdk'
    ) {
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

export function formatTtyProgressEvent(
  event: MigrationProgressEvent,
  timings = new Map<string, ProgressTiming>(),
): string[] {
  const prefix = `[${event.migrationId ?? 'migration'}]`;
  if (event.message) return formatTtyMessage(prefix, event.message);

  const labels = [event.phase, event.operation, event.table]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const processed = progressProcessed(event);
  const total = typeof event.total === 'number' && event.total > 0 ? event.total : undefined;
  const remaining = progressRemaining(event, processed, total);
  const etaSeconds = progressEtaSeconds(event, timings, processed, total, remaining);

  const summary: string[] = [prefix, ...labels];
  if (processed !== undefined && total !== undefined) {
    summary.push(`${processed}/${total}`, formatPercent(processed, total));
  } else if (typeof event.scanned === 'number') {
    summary.push(`scanned=${event.scanned}`);
  }
  if (remaining !== undefined) summary.push(`rem=${remaining}`);
  if (etaSeconds !== undefined) summary.push(`eta=${formatDuration(etaSeconds)}`);
  if (event.done === true) summary.push('done=true');

  const metrics: string[] = [];
  for (const key of ['written', 'updated', 'deleted', 'skipped', 'checkpointed'] as const) {
    const value = event[key];
    if (value !== undefined) metrics.push(`${key}=${String(value)}`);
  }

  const sdk = sdkStats(event.sdk);
  const sdkLine = sdk ? [`  sdk ${formatSdkDetails(sdk).join(' ')}`] : [];

  return metrics.length > 0
    ? [summary.join(' '), ...sdkLine, `  ${metrics.join(' ')}`]
    : [summary.join(' '), ...sdkLine];
}

function formatTtyMessage(prefix: string, message: string): string[] {
  const lines = message.split('\n');
  if (lines.length === 1) return [`${prefix} ${message}`];
  return [`${prefix} ${lines[0]}`, ...lines.slice(1)];
}

function isDurableTtyEvent(event: MigrationProgressEvent): boolean {
  return event.done === true || (typeof event.message === 'string' && event.message.includes('\n'));
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

function clearActiveRows(stream: ProgressStream, rows: number): void {
  if (rows === 0) return;
  stream.write('\r\u001b[2K');
  for (let i = 1; i < rows; i += 1) {
    stream.write('\u001b[1A\r\u001b[2K');
  }
}

function progressProcessed(event: MigrationProgressEvent): number | undefined {
  if (typeof event.applied === 'number') return event.applied;
  if (typeof event.scanned === 'number' && typeof event.total === 'number') return event.scanned;
  return undefined;
}

function progressRemaining(
  event: MigrationProgressEvent,
  processed: number | undefined,
  total: number | undefined,
): number | undefined {
  if (typeof event.remaining === 'number') return event.remaining;
  if (processed !== undefined && total !== undefined) return Math.max(total - processed, 0);
  return undefined;
}

function progressEtaSeconds(
  event: MigrationProgressEvent,
  timings: Map<string, ProgressTiming>,
  processed: number | undefined,
  total: number | undefined,
  remaining: number | undefined,
): number | undefined {
  if (typeof event.etaSeconds === 'number') return event.etaSeconds;
  if (processed === undefined || total === undefined || remaining === undefined || processed <= 0) {
    return undefined;
  }

  const key = progressTimingKey(event);
  const now = Date.now();
  const timing = timings.get(key) ?? { startedAt: now };
  timings.set(key, timing);
  const elapsedSeconds = Math.max((now - timing.startedAt) / 1000, 0);
  if (elapsedSeconds <= 0) return undefined;
  return (elapsedSeconds / processed) * remaining;
}

function progressTimingKey(event: MigrationProgressEvent): string {
  return [
    event.migrationId ?? 'migration',
    event.phase ?? '',
    event.operation ?? '',
    event.table ?? '',
  ].join('|');
}

function formatPercent(processed: number, total: number): string {
  return `${((processed / total) * 100).toFixed(1)}%`;
}

function sdkStats(value: unknown): DdbSdkStatsSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.calls === 'number' &&
    typeof value.reads === 'number' &&
    typeof value.writes === 'number' &&
    typeof value.pages === 'number' &&
    typeof value.itemsReturned === 'number'
    ? value as DdbSdkStatsSnapshot
    : undefined;
}

function formatSdkDetails(stats: DdbSdkStatsSnapshot, prefix = ''): string[] {
  const details = [
    `${prefix}calls=${stats.calls}`,
    `${prefix}reads=${stats.reads}`,
    `${prefix}writes=${stats.writes}`,
    `${prefix}pages=${stats.pages}`,
    `${prefix}items=${stats.itemsReturned}`,
  ];
  if (stats.consumedCapacity > 0) details.push(`${prefix}cu=${round(stats.consumedCapacity)}`);
  if (stats.failed > 0) details.push(`${prefix}errors=${stats.failed}`);
  if (stats.throttles > 0) details.push(`${prefix}throttles=${stats.throttles}`);
  return details;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
