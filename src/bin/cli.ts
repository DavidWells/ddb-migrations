#!/usr/bin/env node
import { Command, Option } from 'commander';
import Table from 'cli-table3';
import pc from 'picocolors';
import { onShutdown, onShutdownError } from '@davidwells/graceful-exit';
import {
  create,
  createMigrationShutdownController,
  down,
  init,
  status,
  up,
} from '../lib/index.js';
import { VERSION } from '../lib/version.js';

const shutdown = createMigrationShutdownController();
let activeCommand: Promise<unknown> | undefined;
let signalCount = 0;

installSignalHandlers();

const program = new Command();
program
  .name('ddb-migrate')
  .description('Stage-aware DynamoDB migrations.')
  .version(VERSION);

const stageOpt = new Option('-s, --stage <name>', 'Stage to operate on').makeOptionMandatory(true);

program
  .command('init')
  .description('Scaffold ddb-migrations.config.json and a migrations/ directory.')
  .action(async () => {
    const r = await init();
    console.log(pc.green(`Created ${r.configPath}`));
    console.log(pc.green(`Created ${r.migrationsDir}/`));
    console.log('Next: edit ddb-migrations.config.json, then run `ddb-migrate create "<description>"`.');
  });

program
  .command('create <description...>')
  .description('Create a new migration file with a timestamped id.')
  .option('--flat', 'Create a single migration file instead of a migration directory.', false)
  .action(async (parts: string[], opts: { flat: boolean }) => {
    const desc = parts.join(' ');
    const file = await create(desc, { format: opts.flat ? 'file' : 'directory' });
    console.log(pc.green(`Created ${file}`));
  });

program
  .command('status')
  .addOption(stageOpt)
  .description('Print the migration ledger for a stage.')
  .action(async (opts: { stage: string }) => {
    const items = await status({ stage: opts.stage });
    if (items.length === 0) {
      console.log('No migrations found.');
      return;
    }
    const table = new Table({ head: ['Migration', 'Status', 'Applied At', 'Checksum'] });
    for (const it of items) {
      const statusCell =
        it.status === 'completed'
          ? pc.green('completed')
          : it.status === 'pending'
            ? pc.yellow('pending')
            : it.status === 'in_progress'
              ? pc.cyan('in_progress')
              : it.status === 'failed'
                ? pc.red('failed')
                : pc.red('orphan');
      const ck =
        it.checksumMatch === true
          ? pc.green('match')
          : it.checksumMatch === false
            ? pc.red('DRIFT')
            : pc.gray('-');
      table.push([it.id, statusCell, it.appliedAt ?? '-', ck]);
    }
    console.log(table.toString());
  });

program
  .command('up')
  .addOption(stageOpt)
  .option('--to <id>', 'Apply migrations only up to and including this id.')
  .option('--dry-run', "Don't write to the ledger; pass dryRun=true to migrations.", false)
  .description('Apply pending migrations.')
  .action(async (opts: { stage: string; to?: string; dryRun: boolean }) => {
    const promise = up({
      stage: opts.stage,
      to: opts.to,
      dryRun: opts.dryRun,
      signal: shutdown.signal,
    });
    activeCommand = promise
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        activeCommand = undefined;
      });
    const result = await promise;
    for (const id of result.applied) console.log(pc.green(`✓ ${id}`));
    for (const id of result.skipped) console.log(pc.gray(`· ${id} (skipped, --to=${opts.to})`));
    if (result.failed) {
      console.error(pc.red(`✗ ${result.failed.id} — ${result.failed.message}`));
      process.exitCode = 1;
    } else if (result.interrupted) {
      const prefix = result.interrupted.id ? `${result.interrupted.id} — ` : '';
      console.error(pc.yellow(`Interrupted: ${prefix}${result.interrupted.message}`));
      process.exitCode = 130;
    } else if (result.applied.length === 0) {
      console.log(pc.gray('Nothing to apply.'));
    }
  });

program
  .command('down')
  .addOption(stageOpt)
  .option(
    '--shift <n>',
    'How many migrations to roll back. 0 means roll back everything. Default: 1.',
    (v) => Number.parseInt(v, 10),
    1,
  )
  .option('--dry-run', "Don't write to the ledger; pass dryRun=true to migrations.", false)
  .description('Roll back the last N completed migrations.')
  .action(async (opts: { stage: string; shift: number; dryRun: boolean }) => {
    const result = await down({ stage: opts.stage, shift: opts.shift, dryRun: opts.dryRun });
    for (const id of result.rolledBack) console.log(pc.green(`↓ ${id}`));
    if (result.failed) {
      console.error(pc.red(`✗ ${result.failed.id} — ${result.failed.message}`));
      process.exitCode = 1;
    } else if (result.rolledBack.length === 0) {
      console.log(pc.gray('Nothing to roll back.'));
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(message));
  process.exit(1);
});

function installSignalHandlers(): void {
  onShutdown('ddb-migrate-active-command', async () => {
    shutdown.request('process shutdown requested');
    if (activeCommand) {
      console.error(pc.yellow('Shutdown requested; waiting for the active migration to finish or checkpoint.'));
      await activeCommand.catch(() => undefined);
    }
    if (shutdown.isRequested()) process.exit(130);
  });

  onShutdownError((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`Shutdown failed: ${message}`));
  });

  for (const event of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
    process.on(event, () => {
      signalCount += 1;
      if (signalCount === 1) {
        shutdown.request(`received ${event}`);
        console.error(
          pc.yellow(
            `Received ${event}; waiting for the current migration page/checkpoint. Press Ctrl-C again to force exit.`,
          ),
        );
        return;
      }
      console.error(pc.red(`Received ${event} again; forcing exit.`));
      process.exit(130);
    });
  }
}
