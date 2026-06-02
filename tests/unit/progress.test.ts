import { describe, expect, it } from 'vitest';
import {
  createProgressPrinter,
  formatProgressEvent,
  formatTtyProgressEvent,
  type ProgressStream,
} from '../../src/lib/progress.js';

function createStream(isTTY: boolean, columns = 120): ProgressStream & { output: string } {
  return {
    isTTY,
    columns,
    output: '',
    write(chunk: string) {
      this.output += chunk;
      return true;
    },
  };
}

describe('progress rendering', () => {
  it('formats scan and apply progress with phase labels and ETA', () => {
    expect(
      formatProgressEvent({
        migrationId: '2026-01-01_demo',
        phase: 'scan',
        table: 'contacts',
        scanned: 9700,
        done: false,
      }),
    ).toBe('[2026-01-01_demo] scan contacts scanned=9700 done=false');

    expect(
      formatProgressEvent({
        migrationId: '2026-01-01_demo',
        phase: 'apply',
        operation: 'delete',
        applied: 1200,
        total: 16100,
        remaining: 14900,
        etaSeconds: 125,
        deleted: 1200,
        skipped: 0,
      }),
    ).toBe('[2026-01-01_demo] apply delete 1200/16100 deleted=1200 skipped=0 total=16100 remaining=14900 eta=2m5s');
  });

  it('prints durable newline progress for non-TTY streams', () => {
    const stream = createStream(false);
    const printer = createProgressPrinter(stream);

    printer.print({ migrationId: 'm1', phase: 'scan', table: 'contacts', scanned: 100 });
    printer.print({ migrationId: 'm1', phase: 'scan', table: 'contacts', scanned: 200 });
    printer.finish();

    expect(stream.output).toContain('[m1] scan contacts scanned=100');
    expect(stream.output).toContain('[m1] scan contacts scanned=200');
    expect(stream.output.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('updates one terminal line for TTY streams and finishes with a newline', () => {
    const stream = createStream(true);
    const printer = createProgressPrinter(stream);

    printer.print({ migrationId: 'm1', phase: 'apply', operation: 'put', applied: 1, total: 2 });
    printer.print({ migrationId: 'm1', phase: 'apply', operation: 'put', applied: 2, total: 2 });
    printer.finish();

    expect(stream.output).toContain('\r\u001b[2K');
    expect(stream.output).toContain('[m1] apply put 2/2 100.0% rem=0');
    expect(stream.output.endsWith('\n')).toBe(true);
  });

  it('formats TTY apply progress as a compact two-line block', () => {
    expect(
      formatTtyProgressEvent({
        migrationId: '2026-01-01_demo',
        phase: 'apply',
        operation: 'delete',
        applied: 1500,
        total: 16100,
        remaining: 14600,
        etaSeconds: 305,
        written: 0,
        updated: 0,
        deleted: 1500,
        skipped: 0,
        checkpointed: false,
      }),
    ).toEqual([
      '[2026-01-01_demo] apply delete 1500/16100 9.3% rem=14600 eta=5m5s',
      '  written=0 updated=0 deleted=1500 skipped=0 checkpointed=false',
    ]);
  });

  it('formats TTY progress with compact SDK stats on a separate line', () => {
    expect(
      formatTtyProgressEvent({
        migrationId: '2026-01-01_demo',
        phase: 'apply',
        operation: 'delete',
        applied: 1500,
        total: 16100,
        remaining: 14600,
        etaSeconds: 305,
        written: 0,
        updated: 0,
        deleted: 1500,
        skipped: 0,
        sdk: {
          calls: 1620,
          reads: 120,
          writes: 1500,
          controls: 0,
          unknown: 0,
          succeeded: 1620,
          failed: 0,
          throttles: 0,
          pages: 120,
          itemsReturned: 12000,
          consumedCapacity: 0,
          lastEvaluatedKeyCount: 119,
          commands: {},
          bySource: {},
          errorsByName: {},
        },
      }),
    ).toEqual([
      '[2026-01-01_demo] apply delete 1500/16100 9.3% rem=14600 eta=5m5s',
      '  sdk calls=1620 reads=120 writes=1500 pages=120 items=12000',
      '  written=0 updated=0 deleted=1500 skipped=0',
    ]);
  });

  it('formats non-TTY progress with compact SDK fields', () => {
    expect(
      formatProgressEvent({
        migrationId: '2026-01-01_demo',
        phase: 'apply',
        operation: 'delete',
        applied: 1,
        total: 2,
        sdk: {
          calls: 3,
          reads: 1,
          writes: 2,
          controls: 0,
          unknown: 0,
          succeeded: 2,
          failed: 1,
          throttles: 1,
          pages: 2,
          itemsReturned: 10,
          consumedCapacity: 2.5,
          lastEvaluatedKeyCount: 1,
          commands: { DeleteCommand: { attempted: 2, succeeded: 1, failed: 1 } },
          bySource: {},
          errorsByName: { ThrottlingException: 1 },
        },
      }),
    ).toBe(
      '[2026-01-01_demo] apply delete 1/2 sdk.calls=3 sdk.reads=1 sdk.writes=2 sdk.pages=2 sdk.items=10 sdk.cu=2.5 sdk.errors=1 sdk.throttles=1 total=2',
    );
  });

  it('ends a TTY progress block when an event is done', () => {
    const stream = createStream(true);
    const printer = createProgressPrinter(stream);

    printer.print({ migrationId: 'm1', phase: 'scan', table: 'system', scanned: 150, done: true });
    stream.write('[m1] apply-plan\n');

    expect(stream.output).toContain('[m1] scan system scanned=150 done=true\n[m1] apply-plan');
  });

  it('prints multiline TTY messages as durable log output', () => {
    const stream = createStream(true);
    const printer = createProgressPrinter(stream);

    printer.print({ migrationId: 'm1', phase: 'apply', operation: 'delete', applied: 1, total: 2 });
    printer.print({ migrationId: 'm1', message: '{\n  "phase": "apply-plan"\n}' });
    printer.print({ migrationId: 'm1', phase: 'apply', operation: 'delete', applied: 2, total: 2 });

    expect(stream.output).toContain('[m1] {\n  "phase": "apply-plan"\n}\n');
    expect(stream.output).toContain('[m1] apply delete 2/2 100.0% rem=0');
  });
});
