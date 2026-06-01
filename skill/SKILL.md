---
name: ddb-migration-tools
description: Use ddb-migration-tools to add, configure, write, review, or run stage-aware DynamoDB migrations in TypeScript projects. Use when working with DynamoDB migration ledgers, ddb-migrations.config files, ddb-migrate CLI commands, migration safety, dry runs, checkpoints, multi-stage promotion, or the reusable Serverless ledger stack.
---

# ddb-migration-tools

Use `ddb-migration-tools` for TypeScript DynamoDB schema/data migrations that need stage-aware configuration, checksum drift detection, resumable checkpoints, and a shared per-account/per-region ledger table.

## Start Here

1. Inspect the target project before editing:
   - `package.json`
   - existing `ddb-migrations.config.*`
   - `migrations/`
   - deployment docs or stack definitions for DynamoDB table names
2. Install the library if missing:
   ```bash
   npm install --save-dev ddb-migration-tools
   ```
3. Initialize only when no config exists:
   ```bash
   npx ddb-migrate init
   ```
4. Prefer directory migrations for non-trivial work:
   ```bash
   npx ddb-migrate create "seed counter metadata"
   ```

## Configuration Pattern

Use one ledger table per AWS account and region. Do not put `accountId` in the ledger primary key; the account is implied by the table being written to.

Recommended shape:

```json
{
  "appName": "my-app",
  "migrationsDir": "migrations",
  "ledger": {
    "tableName": "ddb-migrations-ledger"
  },
  "stages": {
    "dev": {
      "region": "us-east-1",
      "tablePrefix": "my-app-dev-"
    },
    "staging": {
      "region": "us-east-1",
      "accountId": "123456789012",
      "tablePrefix": "my-app-staging-"
    },
    "prod": {
      "region": "us-east-1",
      "accountId": "210987654321",
      "tablePrefix": "my-app-prod-"
    }
  }
}
```

Use `tables` overrides when table names do not share a prefix. Use `ledger.scope` only when multiple apps intentionally share a ledger namespace.

If app tables span multiple regions but the project wants one shared ledger, set `ledger.region` to where the ledger table lives. Each stage still talks to its app tables in `stage.region`; ledger reads/writes route to `ledger.region`. Per-stage `ledgerRegion` / `ledgerEndpoint` override the global value. Only reach for this when stages actually use different regions — for single-region projects the default (ledger follows stage) is correct.

## Writing Migrations

Import the context type from the package:

```ts
import type { MigrationContext } from 'ddb-migration-tools';

export const description = 'Backfill schemaVersion on User items';

export async function up(ctx: MigrationContext): Promise<void> {
  const Users = ctx.tableName('users');
  ctx.logger.info(`Using ${Users}`);
}
```

Use `ctx.ddb` for item operations and `ctx.ddbRaw` for table-level operations such as GSI changes. Resolve all table names through `ctx.tableName(logical)`.

Honor dry-run explicitly:

```ts
if (ctx.dryRun) {
  ctx.logger.info('would update item X');
  return;
}
```

For long scans or backfills, use checkpoints:

```ts
const checkpoint = await ctx.getCheckpoint<{ lastKey?: Record<string, unknown> }>();
await ctx.checkpoint({ lastKey: page.LastEvaluatedKey });
```

## Safety Rules

- Make migrations idempotent. Use conditional writes or filters so reruns do not corrupt data.
- Treat `down()` as optional. Throw `down() not implemented` when rollback would be unsafe or fake.
- Never edit, reorder, or rename a migration after it has been applied to any shared environment; checksum drift should block that.
- Prefer forward-only repair migrations over mutating old migration files.
- Avoid DynamoDB scans unless the migration is explicitly a controlled backfill. For scans, page results, checkpoint, and consider segmented scans.
- Do not print secrets or full customer records in migration logs.
- Check production credentials/profile selection before running `up --stage prod`.

## Runbook

Before applying:

```bash
npx ddb-migrate status --stage staging
npx ddb-migrate up --stage staging --dry-run
```

Apply:

```bash
npx ddb-migrate up --stage staging
npx ddb-migrate status --stage staging
```

Rollback only when `down()` is intentionally implemented and safe:

```bash
npx ddb-migrate down --stage staging --shift 1 --dry-run
npx ddb-migrate down --stage staging --shift 1
```

Use `--to <migrationId>` to stop at a specific migration during staged rollout. Use `--shift N` to roll back the newest `N` completed migrations.

## Ledger Stack

If the project needs a ledger table, use the included `stack/` reference stack from this repo. Deploy one stack per account/region with Serverless Framework. Prefer `osls` when the project standard requires it.

Do not remove ledger stacks unless the user explicitly asks. The reference stack retains the DynamoDB table on stack deletion, but removal is still an operational action.
