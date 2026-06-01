import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/lib/version.js';

type PackageJson = {
  version: string;
};

function packageJson(): PackageJson {
  return JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
}

describe('VERSION', () => {
  it('matches package.json so the CLI reports the published version', () => {
    expect(VERSION).toBe(packageJson().version);
  });
});
