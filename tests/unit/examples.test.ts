import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const EXAMPLE_FILES = [
  'examples/migrations/2026-01-01-000000-add-schema-version.ts',
  'examples/migrations/2026-01-02-000000-rename-status-to-state.ts',
  'examples/migrations/2026-01-03-000000-parallel-scan-with-checkpoints.ts',
  'examples/migrations/2026-01-04-000000-add-email-gsi.ts',
  'examples/migrations/2026-01-05-000000-remove-deprecated-status.ts',
];

describe('examples', () => {
  it.each(EXAMPLE_FILES)('%s is syntactically valid TypeScript', (file) => {
    const source = readFileSync(path.resolve(file), 'utf8');
    const result = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
      },
    });

    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    expect(errors.map((diagnostic) => diagnostic.messageText)).toEqual([]);
  });

  it.each(EXAMPLE_FILES)('%s exports the migration contract', (file) => {
    const source = readFileSync(path.resolve(file), 'utf8');

    expect(source).toMatch(/export const description = /);
    expect(source).toMatch(/export async function up\(ctx: MigrationContext\)/);
    expect(source).toMatch(/export async function down\(/);
  });
});
