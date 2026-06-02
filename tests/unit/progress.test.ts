import { describe, expect, it } from 'vitest';
import { createProgressPrinter, formatProgressEvent, type ProgressStream } from '../../src/lib/progress.js';

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
    expect(stream.output).toContain('[m1] apply put 2/2 total=2');
    expect(stream.output.endsWith('\n')).toBe(true);
  });
});
