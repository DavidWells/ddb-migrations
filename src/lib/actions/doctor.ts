import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DescribeTableCommand, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { findConfig, loadConfig, resolveStage } from '../config.js';
import { createClients } from '../ddb.js';
import { getCallerIdentity, type AwsCallerIdentity } from '../aws-identity.js';
import { plan } from './plan.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message: string;
};

export type DoctorResult = {
  ok: boolean;
  cwd: string;
  configPath?: string;
  stage: string;
  region?: string;
  accountId?: string;
  callerIdentity?: AwsCallerIdentity;
  checks: DoctorCheck[];
};

export type DoctorOptions = {
  stage: string;
  cwd?: string;
};

export async function doctor(opts: DoctorOptions): Promise<DoctorResult> {
  const cwd = opts.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  let configPath: string | undefined;
  let region: string | undefined;
  let accountId: string | undefined;
  let callerIdentity: AwsCallerIdentity | undefined;

  try {
    configPath = await findConfig(cwd);
    checks.push(pass('config', `found ${configPath}`));
  } catch (err) {
    checks.push(fail('config', messageOf(err)));
    return finish({ cwd, stage: opts.stage, checks });
  }

  let cfg;
  try {
    cfg = await loadConfig(cwd);
    checks.push(pass('config-load', 'config loaded and validated'));
  } catch (err) {
    checks.push(fail('config-load', messageOf(err)));
    return finish({ cwd, configPath, stage: opts.stage, checks });
  }

  let sc;
  try {
    sc = resolveStage(cfg, opts.stage);
    region = sc.region;
    accountId = sc.accountId;
    checks.push(pass('stage', `resolved ${opts.stage} in ${sc.region}`));
  } catch (err) {
    checks.push(fail('stage', messageOf(err)));
    return finish({ cwd, configPath, stage: opts.stage, checks });
  }

  try {
    await fs.access(path.resolve(cwd, cfg.migrationsDir));
    checks.push(pass('migrations-dir', `found ${cfg.migrationsDir}`));
  } catch {
    checks.push(fail('migrations-dir', `missing ${cfg.migrationsDir}`));
  }

  const clients = createClients(sc);
  try {
    await clients.ledgerRaw.send(new DescribeTableCommand({ TableName: sc.ledgerTable }));
    checks.push(pass('ledger-table', `reachable ${sc.ledgerTable}`));
  } catch (err) {
    if (err instanceof ResourceNotFoundException || hasName(err, 'ResourceNotFoundException')) {
      checks.push(fail('ledger-table', `missing ${sc.ledgerTable}`));
    } else {
      checks.push(fail('ledger-table', messageOf(err)));
    }
  }

  if (sc.endpoint) {
    checks.push(skip('aws-identity', 'skipped for endpoint-backed stage'));
  } else {
    try {
      callerIdentity = await getCallerIdentity(sc);
      if (sc.accountId && callerIdentity.account !== sc.accountId) {
        checks.push(
          fail(
            'aws-account',
            `expected ${sc.accountId}, got ${callerIdentity.account ?? 'unknown'}`,
          ),
        );
      } else if (sc.accountId) {
        checks.push(pass('aws-account', `matched ${sc.accountId}`));
      } else {
        checks.push(warn('aws-account', `caller account ${callerIdentity.account ?? 'unknown'}; no accountId configured`));
      }
    } catch (err) {
      checks.push(fail('aws-identity', messageOf(err)));
    }
  }

  try {
    const result = await plan({ stage: opts.stage, cwd });
    if (result.drifted.length > 0) checks.push(fail('drift', `${result.drifted.length} drifted migration(s)`));
    else checks.push(pass('drift', 'no checksum drift detected'));

    if (result.orphaned.length > 0) checks.push(warn('orphans', `${result.orphaned.length} orphaned ledger row(s)`));
    else checks.push(pass('orphans', 'no orphaned ledger rows'));

    if (result.blocked.length > 0) checks.push(warn('resumable', `${result.blocked.length} failed/in-progress migration(s)`));
    else checks.push(pass('resumable', 'no failed or in-progress migrations'));
  } catch (err) {
    checks.push(fail('plan', messageOf(err)));
  }

  return finish({ cwd, configPath, stage: opts.stage, region, accountId, callerIdentity, checks });
}

function finish(result: Omit<DoctorResult, 'ok'>): DoctorResult {
  return {
    ...result,
    ok: !result.checks.some((check) => check.status === 'fail'),
  };
}

function pass(name: string, message: string): DoctorCheck {
  return { name, status: 'pass', message };
}

function warn(name: string, message: string): DoctorCheck {
  return { name, status: 'warn', message };
}

function fail(name: string, message: string): DoctorCheck {
  return { name, status: 'fail', message };
}

function skip(name: string, message: string): DoctorCheck {
  return { name, status: 'skip', message };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasName(err: unknown, name: string): boolean {
  return !!err && typeof err === 'object' && 'name' in err && err.name === name;
}
