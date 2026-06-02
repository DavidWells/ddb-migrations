import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ledger } from '../../src/lib/ledger.js';

const ledgerRawSend = vi.fn();

vi.mock('../../src/lib/ddb.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/ddb.js')>('../../src/lib/ddb.js');
  return {
    ...actual,
    createClients: () => ({
      raw: { send: vi.fn() },
      doc: { send: vi.fn() },
      ledgerRaw: { send: ledgerRawSend },
      ledgerDoc: { send: vi.fn() },
    }),
  };
});

vi.mock('../../src/lib/aws-identity.js', () => ({
  getCallerIdentity: vi.fn().mockResolvedValue({ account: '123456789012', arn: 'arn:aws:iam::123456789012:user/test' }),
}));

let tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  ledgerRawSend.mockReset();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-doctor-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: 'doctor-test',
      migrationsDir: 'migrations',
      ledger: { tableName: 'doctor-ledger' },
      stages: {
        dev: { region: 'us-east-1', accountId: '123456789012' },
      },
    }),
  );
  mkdirSync(path.join(dir, 'migrations'));
  writeFileSync(path.join(dir, 'migrations', '2026-01-01_demo.mjs'), 'export async function up() {}');
  return dir;
}

describe('doctor', () => {
  it('returns passing health checks for a reachable configured project', async () => {
    const cwd = makeProject();
    vi.spyOn(Ledger.prototype, 'listAll').mockResolvedValue([]);
    ledgerRawSend.mockResolvedValue({});
    const { doctor } = await import('../../src/lib/actions/doctor.js');

    const result = await doctor({ cwd, stage: 'dev' });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual(
      expect.arrayContaining([
        ['config', 'pass'],
        ['ledger-table', 'pass'],
        ['aws-account', 'pass'],
        ['drift', 'pass'],
      ]),
    );
  });

  it('fails cleanly when no config exists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-no-config-'));
    tmpDirs.push(dir);
    const { doctor } = await import('../../src/lib/actions/doctor.js');

    const result = await doctor({ cwd: dir, stage: 'dev' });

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: 'config', status: 'fail' });
  });
});
