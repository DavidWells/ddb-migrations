# CLAUDE.md

Notes for AI agents working on this repo.

## Layout

- `src/lib/` — library code, importable as `ddb-migration-tools`
  - `types.ts` — public types (Config, MigrationContext, LedgerEntry)
  - `config.ts` — config loader, stage / table-name resolution
  - `ddb.ts` — SDK v3 client factory
  - `ledger.ts` — `Ledger` class wrapping the migrations table (CRUD + checksum + checkpoint)
  - `migrations.ts` — file discovery + checksum
  - `runner.ts` — dynamic import of migration files (registers `tsx/esm` for `.ts`), context builder
  - `actions/` — one file per CLI verb (init, create, status, up, down)
  - `index.ts` — public entry point
- `src/bin/cli.ts` — commander wrapper around the actions
- `dist/` — `tsc` output (gitignored)

## Conventions

- ESM only (`"type": "module"`). All internal imports use `.js` extensions in source — TS resolves them, Node runs the compiled `.js`.
- Migration ids are timestamped. Current `create` output uses `YYYY-MM-DD_HH-MM-<slug>`. Lexicographic sort = chronological order.
- Ledger table primary key is stage-scoped: `pk = SCOPE#<scope>#STAGE#<stage>`, `sk = MIGRATION#<migrationId>`.
- Drift detection: SHA-256 of the migration file at apply time, compared on each `status` / `up`.
- `createClients` returns two pairs: `{raw, doc}` for app tables and `{ledgerRaw, ledgerDoc}` for the ledger. They are the same instance when `stage.ledgerRegion`/`ledgerEndpoint` match `stage.region`/`endpoint`. The `Ledger` class is always constructed with the ledger pair; migration code (via `ctx.ddb` / `ctx.ddbRaw`) always sees the app pair. The `region` attribute on a `LedgerEntry` records the **app** region (where side effects landed), not the ledger region.

## Adding a new CLI verb

1. Add a function in `src/lib/actions/<verb>.ts` that takes options + returns a result object.
2. Re-export from `src/lib/index.ts`.
3. Wire it up in `src/bin/cli.ts` with commander.

## Testing locally without real DynamoDB

Use [DynamoDB local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html) and add `endpoint: "http://localhost:8000"` to a stage in your config.

## Things deliberately not done yet

- No distributed lock for concurrent `up` runs against the same stage. Coordinate at the CI level.
- No parallel-scan helper. Migrations roll their own; the README example shows the pattern.
- No `--from` flag. Replays from the start of pending; use `--to` to bound the upper end.
