import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-cli-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'ddb-migrations.config.json'),
    JSON.stringify({
      appName: 'cli-test',
      migrationsDir: 'migrations',
      stages: {
        dev: { region: 'us-east-1' },
        prod: { region: 'us-east-1' },
      },
    }),
  );
  return dir;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', 'src/bin/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('ddb-migrate CLI', () => {
  it('prints current context as JSON and honors --cwd', () => {
    const cwd = makeProject();
    const result = runCli(['--cwd', cwd, 'current', '--json']);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { cwd: string; configPath: string };
    expect(parsed.cwd).toBe(cwd);
    expect(parsed.configPath).toBe(path.join(cwd, 'ddb-migrations.config.json'));
  });

  it('guards non-dry-run prod up behind --force before loading config', () => {
    const result = runCli(['up', '--stage', 'prod']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires --force/);
  });

  it('guards non-dry-run down behind --force before loading config', () => {
    const result = runCli(['down', '--stage', 'dev']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires --force/);
  });

  it('guards checkpoint clear behind --force', () => {
    const result = runCli(['checkpoint', 'clear', '2026-01-01_demo', '--stage', 'dev']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires --force/);
  });
});
