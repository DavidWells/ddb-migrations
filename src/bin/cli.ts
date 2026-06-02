#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Command, Option } from 'commander';
import Table from 'cli-table3';
import pc from 'picocolors';
import {
  clearCheckpoint,
  create,
  createMigrationShutdownController,
  doctor,
  down,
  findConfig,
  init,
  markInterrupted,
  plan,
  showCheckpoint,
  status,
  up,
  type DoctorCheck,
} from '../lib/index.js';
import { createProgressPrinter } from '../lib/progress.js';
import { VERSION } from '../lib/version.js';

type GlobalOptions = {
  cwd?: string;
};

type JsonOption = {
  json?: boolean;
};

const shutdown = createMigrationShutdownController();
let activeCommand: Promise<unknown> | undefined;
let activeInterruptTarget:
  | {
    cwd: string;
    stage: string;
    migrationId: string;
  }
  | undefined;
let signalCount = 0;

installSignalHandlers();

const program = new Command();
program
  .name('ddb-migrate')
  .description('Stage-aware DynamoDB migrations.')
  .version(VERSION)
  .option('-C, --cwd <path>', 'Project directory containing ddb-migrations.config.*')
  .showHelpAfterError();

const stageOpt = new Option('-s, --stage <name>', 'Stage to operate on').makeOptionMandatory(true);

program
  .command('current')
  .description('Print the resolved CLI context.')
  .option('--json', 'Print JSON output.', false)
  .action(async (opts: JsonOption) => {
    const cwd = resolveCwd();
    const result = {
      cwd,
      configPath: await findConfig(cwd).catch(() => undefined),
      version: VERSION,
      bin: process.argv[1],
      node: process.version,
    };
    printCurrent(result, !!opts.json);
  });

program
  .command('init')
  .description('Scaffold ddb-migrations.config.json and a migrations/ directory.')
  .action(async () => {
    const r = await init(resolveCwd());
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
    const file = await create(desc, { cwd: resolveCwd(), format: opts.flat ? 'file' : 'directory' });
    console.log(pc.green(`Created ${file}`));
  });

program
  .command('status')
  .addOption(stageOpt)
  .option('--json', 'Print JSON output.', false)
  .description('Print the migration ledger for a stage.')
  .action(async (opts: { stage: string } & JsonOption) => {
    const items = await status({ stage: opts.stage, cwd: resolveCwd() });
    if (opts.json) {
      printJson(items);
      return;
    }
    printStatusTable(items);
  });

program
  .command('plan')
  .addOption(stageOpt)
  .option('--to <id>', 'Plan migrations only up to and including this id.')
  .option('--json', 'Print JSON output.', false)
  .description('Print the migration execution plan without running migration code.')
  .action(async (opts: { stage: string; to?: string } & JsonOption) => {
    const result = await plan({ stage: opts.stage, cwd: resolveCwd(), to: opts.to });
    if (opts.json) {
      printJson(result);
      return;
    }
    printPlan(result);
  });

program
  .command('doctor')
  .addOption(stageOpt)
  .option('--json', 'Print JSON output.', false)
  .description('Run config, ledger, AWS identity, and migration health checks.')
  .action(async (opts: { stage: string } & JsonOption) => {
    const result = await doctor({ stage: opts.stage, cwd: resolveCwd() });
    if (opts.json) {
      printJson(result);
    } else {
      printDoctor(result.checks);
    }
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('__mark-interrupted <migrationId>', { hidden: true })
  .addOption(stageOpt)
  .option('--message <message>', 'Interruption message.', 'forced shutdown')
  .action(async (migrationId: string, opts: { stage: string; message: string }) => {
    const result = await markInterrupted({
      cwd: resolveCwd(),
      stage: opts.stage,
      migrationId,
      message: opts.message,
    });
    if (!result.marked) process.exitCode = 2;
  });

program
  .command('up')
  .addOption(stageOpt)
  .option('--to <id>', 'Apply migrations only up to and including this id.')
  .option('--dry-run', "Don't write to the ledger; pass dryRun=true to migrations.", false)
  .option('--force', 'Bypass prod-stage non-dry-run safety guard.', false)
  .option('--capacity', 'Request ReturnConsumedCapacity=TOTAL on supported migration app-table commands.', false)
  .option('--no-sdk-stats', 'Disable SDK call stats for this run.')
  .option('--json', 'Print JSON output.', false)
  .description('Apply pending migrations.')
  .action(async (opts: {
    stage: string;
    to?: string;
    dryRun: boolean;
    force: boolean;
    capacity: boolean;
    sdkStats: boolean;
  } & JsonOption) => {
    requireForceForUp(opts.stage, opts.dryRun, opts.force);
    const progress = createProgressPrinter();
    const cwd = resolveCwd();
    const promise = up({
      stage: opts.stage,
      cwd,
      to: opts.to,
      dryRun: opts.dryRun,
      sdkStatsEnabled: opts.sdkStats,
      captureConsumedCapacity: opts.capacity,
      signal: shutdown.signal,
      onProgress: opts.json ? undefined : progress.print,
      onActiveMigration: opts.dryRun
        ? undefined
        : (migrationId) => {
          activeInterruptTarget = migrationId
            ? { cwd, stage: opts.stage, migrationId }
            : undefined;
        },
    });
    activeCommand = trackActive(promise);
    const result = await promise;
    progress.finish();
    if (opts.json) {
      printJson(result);
    } else {
      printUpResult(result, opts.to);
    }
    if (result.failed) process.exitCode = 1;
    if (result.interrupted) process.exitCode = 130;
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
  .option('--force', 'Required for non-dry-run rollback.', false)
  .option('--capacity', 'Request ReturnConsumedCapacity=TOTAL on supported migration app-table commands.', false)
  .option('--no-sdk-stats', 'Disable SDK call stats for this run.')
  .option('--json', 'Print JSON output.', false)
  .description('Roll back the last N completed migrations.')
  .action(async (opts: {
    stage: string;
    shift: number;
    dryRun: boolean;
    force: boolean;
    capacity: boolean;
    sdkStats: boolean;
  } & JsonOption) => {
    requireForceForDown(opts.dryRun, opts.force);
    const progress = createProgressPrinter();
    const promise = down({
      stage: opts.stage,
      cwd: resolveCwd(),
      shift: opts.shift,
      dryRun: opts.dryRun,
      sdkStatsEnabled: opts.sdkStats,
      captureConsumedCapacity: opts.capacity,
      signal: shutdown.signal,
      onProgress: opts.json ? undefined : progress.print,
    });
    activeCommand = trackActive(promise);
    const result = await promise;
    progress.finish();
    if (opts.json) {
      printJson(result);
    } else {
      printDownResult(result);
    }
    if (result.failed) process.exitCode = 1;
    if (result.interrupted) process.exitCode = 130;
  });

const checkpointCommand = program
  .command('checkpoint')
  .description('Inspect or clear a migration checkpoint.');

checkpointCommand
  .command('show <migrationId>')
  .addOption(stageOpt)
  .option('--json', 'Print JSON output.', false)
  .description('Print the saved checkpoint for a migration.')
  .action(async (migrationId: string, opts: { stage: string } & JsonOption) => {
    const result = await showCheckpoint({ stage: opts.stage, cwd: resolveCwd(), migrationId });
    if (opts.json) {
      printJson(result);
      return;
    }
    if (!result.found) {
      console.log(pc.gray(`No checkpoint found for ${migrationId}.`));
      return;
    }
    printJson(result.checkpoint);
  });

checkpointCommand
  .command('clear <migrationId>')
  .addOption(stageOpt)
  .option('--force', 'Required to clear a saved checkpoint.', false)
  .option('--json', 'Print JSON output.', false)
  .description('Remove the saved checkpoint for a migration.')
  .action(async (migrationId: string, opts: { stage: string; force: boolean } & JsonOption) => {
    if (!opts.force) throw new Error('checkpoint clear requires --force.');
    const result = await clearCheckpoint({ stage: opts.stage, cwd: resolveCwd(), migrationId });
    if (opts.json) {
      printJson(result);
      return;
    }
    console.log(result.cleared ? pc.green(`Cleared checkpoint for ${migrationId}.`) : pc.gray(`No checkpoint found for ${migrationId}.`));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(message));
  process.exit(1);
});

function resolveCwd(): string {
  const opts = program.opts<GlobalOptions>();
  return path.resolve(opts.cwd ?? process.env.DDB_MIGRATE_CWD ?? process.cwd());
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printStatusTable(items: Awaited<ReturnType<typeof status>>): void {
  if (items.length === 0) {
    console.log('No migrations found.');
    return;
  }
  const table = new Table({ head: ['Migration', 'Status', 'Applied At', 'Checksum'] });
  for (const it of items) {
    table.push([it.id, colorStatus(it.status), it.appliedAt ?? '-', colorChecksum(it.checksumMatch)]);
  }
  console.log(table.toString());
}

function printPlan(result: Awaited<ReturnType<typeof plan>>): void {
  console.log(pc.bold(`Plan for ${result.stage} (${result.region})`));
  console.log(`cwd: ${result.cwd}`);
  console.log(`ledger: ${result.ledgerTable} / ${result.ledgerScope}`);
  const table = new Table({ head: ['Migration', 'Status', 'Run', 'Reason'] });
  for (const migration of result.migrations) {
    table.push([
      migration.id,
      colorStatus(migration.status),
      migration.willRun ? pc.green('yes') : pc.gray('no'),
      migration.reason,
    ]);
  }
  console.log(table.toString());
}

function printDoctor(checks: DoctorCheck[]): void {
  const table = new Table({ head: ['Check', 'Status', 'Message'] });
  for (const check of checks) {
    table.push([check.name, colorCheck(check.status), check.message]);
  }
  console.log(table.toString());
}

function printUpResult(result: Awaited<ReturnType<typeof up>>, to?: string): void {
  for (const id of result.applied) console.log(pc.green(`✓ ${id}`));
  for (const id of result.skipped) console.log(pc.gray(`· ${id} (skipped${to ? `, --to=${to}` : ''})`));
  if (result.failed) console.error(pc.red(`✗ ${result.failed.id} — ${result.failed.message}`));
  else if (result.interrupted) {
    const prefix = result.interrupted.id ? `${result.interrupted.id} — ` : '';
    console.error(pc.yellow(`Interrupted: ${prefix}${result.interrupted.message}`));
  } else if (result.applied.length === 0) console.log(pc.gray('Nothing to apply.'));
}

function printDownResult(result: Awaited<ReturnType<typeof down>>): void {
  for (const id of result.rolledBack) console.log(pc.green(`↓ ${id}`));
  if (result.failed) console.error(pc.red(`✗ ${result.failed.id} — ${result.failed.message}`));
  else if (result.interrupted) {
    const prefix = result.interrupted.id ? `${result.interrupted.id} — ` : '';
    console.error(pc.yellow(`Interrupted: ${prefix}${result.interrupted.message}`));
  } else if (result.rolledBack.length === 0) console.log(pc.gray('Nothing to roll back.'));
}

function printCurrent(
  result: { cwd: string; configPath?: string; version: string; bin: string | undefined; node: string },
  json: boolean,
): void {
  if (json) {
    printJson(result);
    return;
  }
  console.log(`cwd: ${result.cwd}`);
  console.log(`config: ${result.configPath ?? '<not found>'}`);
  console.log(`version: ${result.version}`);
  console.log(`bin: ${result.bin ?? '<unknown>'}`);
  console.log(`node: ${result.node}`);
}

function colorStatus(status: string): string {
  if (status === 'completed') return pc.green(status);
  if (status === 'pending') return pc.yellow(status);
  if (status === 'in_progress') return pc.cyan(status);
  if (status === 'interrupted') return pc.yellow(status);
  if (status === 'failed' || status === 'orphan') return pc.red(status);
  return status;
}

function colorChecksum(match: boolean | null): string {
  if (match === true) return pc.green('match');
  if (match === false) return pc.red('DRIFT');
  return pc.gray('-');
}

function colorCheck(status: DoctorCheck['status']): string {
  if (status === 'pass') return pc.green(status);
  if (status === 'warn') return pc.yellow(status);
  if (status === 'fail') return pc.red(status);
  return pc.gray(status);
}

function requireForceForUp(stage: string, dryRun: boolean, force: boolean): void {
  if (dryRun || force || !isProdLike(stage)) return;
  throw new Error(`Non-dry-run up for stage '${stage}' requires --force.`);
}

function requireForceForDown(dryRun: boolean, force: boolean): void {
  if (dryRun || force) return;
  throw new Error('Non-dry-run down requires --force.');
}

function isProdLike(stage: string): boolean {
  return stage.toLowerCase().includes('prod');
}

function trackActive<T>(promise: Promise<T>): Promise<undefined> {
  return promise
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      activeCommand = undefined;
    });
}

function installSignalHandlers(): void {
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
      console.error(pc.red(`Received ${event} again; forcing exit after interruption persistence attempt.`));
      void forceExitAfterInterruptPersistence();
    });
  }
}

async function forceExitAfterInterruptPersistence(): Promise<void> {
  if (activeCommand) {
    await Promise.race([
      activeCommand.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
  runSynchronousInterruptFallback();
  process.exit(130);
}

function runSynchronousInterruptFallback(): void {
  if (!activeInterruptTarget) return;
  const result = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      process.argv[1] ?? '',
      '--cwd',
      activeInterruptTarget.cwd,
      '__mark-interrupted',
      activeInterruptTarget.migrationId,
      '--stage',
      activeInterruptTarget.stage,
      '--message',
      'forced shutdown after second signal',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
      env: process.env,
    },
  );
  if (result.status === 0 || result.status === 2) return;
  const detail = result.error?.message || result.stderr?.toString().trim();
  console.error(pc.red(`Failed to persist interrupted status before force exit${detail ? `: ${detail}` : '.'}`));
}
