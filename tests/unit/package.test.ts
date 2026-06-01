import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  name?: string;
  files?: string[];
};

function packageJson(): PackageJson {
  return JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
}

describe('package manifest', () => {
  it('uses the publishable npm package name', () => {
    expect(packageJson().name).toBe('ddb-migration-tools');
  });

  it('ships the clean reference stack but not generated stack artifacts', () => {
    const files = packageJson().files ?? [];

    expect(files).toContain('stack/README.md');
    expect(files).toContain('stack/package.json');
    expect(files).toContain('stack/serverless.yml');
    expect(files).not.toContain('stack/**/*');
    expect(files).not.toContain('stack/serverless.js');
    expect(files).not.toContain('stack/stack.yml');
  });
});
