#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
writeFileSync(
  new URL('../src/lib/version.ts', import.meta.url),
  `export const VERSION = '${pkg.version}';\n`,
);
