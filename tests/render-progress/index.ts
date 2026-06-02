#!/usr/bin/env tsx
import { createProgressPrinter, formatTtyProgressEvent, type ProgressStream } from '../../src/lib/progress.js';
import type { MigrationProgressEvent } from '../../src/lib/types.js';

class CaptureStream implements ProgressStream {
  isTTY = true;
  columns: number;
  output = '';

  constructor(columns: number) {
    this.columns = columns;
  }

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
}

const migrationId = '2026-06-02_00-13_ksf_full_cleanup';
const columns = Number.parseInt(process.argv[2] ?? '', 10) || process.stdout.columns || 100;
const delayMs = Number.parseInt(process.argv[3] ?? '', 10) || 250;
const stepSize = Number.parseInt(process.argv[4] ?? '', 10) || 250;
const totalDeletes = Number.parseInt(process.argv[5] ?? '', 10) || 16100;

const preludeEvents: MigrationProgressEvent[] = [
  {
    migrationId,
    phase: 'scan',
    table: 'contacts',
    scanned: 35616,
    checkpointed: true,
    done: true,
  },
  {
    migrationId,
    phase: 'scan',
    table: 'system',
    scanned: 150,
    checkpointed: true,
    done: true,
  },
  {
    migrationId,
    phase: 'apply-plan',
    message: JSON.stringify({
      phase: 'apply-plan',
      dryRun: false,
      planned: {
        puts: 0,
        updates: 0,
        deletes: 16100,
        total: 16100,
      },
    }, null, 2),
  },
];

const applyEvents = buildApplyEvents(totalDeletes, stepSize, delayMs);
const events = [...preludeEvents, ...sampleApplyEvents(applyEvents)];

console.log(`columns=${columns} delayMs=${delayMs} stepSize=${stepSize} total=${totalDeletes}`);
console.log('\nTTY formatter snapshots:\n');
for (const event of events) {
  for (const line of formatTtyProgressEvent(event)) {
    console.log(line);
  }
  console.log('---');
}

console.log('\nCaptured TTY escape transcript:\n');
const capture = new CaptureStream(columns);
const capturePrinter = createProgressPrinter(capture);
for (const event of events) capturePrinter.print(event);
capturePrinter.finish();
console.log(visibleEscapes(capture.output));

console.log('\nLive TTY demo:\n');
const livePrinter = createProgressPrinter(process.stderr);
for (const event of preludeEvents) {
  livePrinter.print(event);
  await sleep(450);
}
for (const event of applyEvents) {
  livePrinter.print(event);
  await sleep(delayMs);
}
livePrinter.finish();

function visibleEscapes(value: string): string {
  return value
    .replaceAll('\u001b', '<ESC>')
    .replaceAll('\r', '<CR>')
    .replaceAll('\n', '<NL>\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildApplyEvents(total: number, step: number, delay: number): MigrationProgressEvent[] {
  const frameCount = Math.ceil(total / step);
  const estimatedTotalSeconds = Math.ceil((frameCount * delay) / 1000);
  const out: MigrationProgressEvent[] = [];

  for (let applied = step; applied < total; applied += step) {
    const remaining = Math.max(total - applied, 0);
    out.push(applyEvent(applied, total, remaining, Math.ceil((remaining / total) * estimatedTotalSeconds), false));
  }
  out.push(applyEvent(total, total, 0, 0, true));
  return out;
}

function sampleApplyEvents(events: MigrationProgressEvent[]): MigrationProgressEvent[] {
  if (events.length <= 3) return events;
  return [
    events[Math.min(5, events.length - 1)],
    events[Math.floor(events.length / 2)],
    events[events.length - 1],
  ];
}

function applyEvent(
  applied: number,
  total: number,
  remaining: number,
  etaSeconds: number,
  done: boolean,
): MigrationProgressEvent {
  const scanPages = 120;
  return {
    migrationId,
    phase: 'apply',
    operation: 'delete',
    applied,
    written: 0,
    updated: 0,
    deleted: applied,
    skipped: 0,
    total,
    remaining,
    etaSeconds,
    checkpointed: done,
    sdk: {
      calls: scanPages + applied,
      reads: scanPages,
      writes: applied,
      controls: 0,
      unknown: 0,
      succeeded: scanPages + applied,
      failed: 0,
      throttles: 0,
      pages: scanPages,
      itemsReturned: 12000,
      consumedCapacity: 0,
      lastEvaluatedKeyCount: Math.max(scanPages - 1, 0),
      commands: {
        ScanCommand: { attempted: scanPages, succeeded: scanPages, failed: 0 },
        DeleteCommand: { attempted: applied, succeeded: applied, failed: 0 },
      },
      bySource: {
        app: {
          calls: scanPages + applied,
          reads: scanPages,
          writes: applied,
          controls: 0,
          unknown: 0,
          succeeded: scanPages + applied,
          failed: 0,
          pages: scanPages,
          itemsReturned: 12000,
          consumedCapacity: 0,
          lastEvaluatedKeyCount: Math.max(scanPages - 1, 0),
        },
      },
      errorsByName: {},
    },
    ...(done ? { done: true } : {}),
  };
}
