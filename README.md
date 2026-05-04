# ddb-migrations

Stage-aware DynamoDB migrations for TypeScript projects.

A small, modern alternative to [`dynamo-data-migrations`](https://github.com/technogise/dynamo-data-migrations):

- AWS SDK v3 (the v2-based original is on an EOL SDK)
- Stage-based config (`dev` / `staging` / `prod`) instead of AWS credential profiles
- Per-stage ledger table (`${appName}-migrations-${stage}` by default)
- SHA-256 drift detection on every applied migration
- Resumable migrations via a `checkpoint()` helper on the ledger row
- TypeScript-native: writes `.ts` migration files and runs them via `tsx`'s ESM loader, no compile step

## Install

```bash
npm install --save-dev ddb-migrations
```

## Quick start

```bash
npx ddb-migrate init
# edit ddb-migrations.config.json
npx ddb-migrate create "add schema version to users"
npx ddb-migrate up     --stage dev
npx ddb-migrate status --stage dev
```

## Config

`ddb-migrations.config.json` (also accepts `.js`, `.mjs`, `.ts`):

```json
{
  "appName": "my-app",
  "migrationsDir": "migrations",
  "stages": {
    "dev": {
      "region": "us-east-1",
      "tablePrefix": "my-app-dev-"
    },
    "staging": {
      "region": "us-east-1",
      "tablePrefix": "my-app-staging-"
    },
    "prod": {
      "region": "us-east-1",
      "tablePrefix": "my-app-prod-"
    }
  }
}
```

| Field | Description |
| --- | --- |
| `appName` | Used to derive the default ledger table name. |
| `migrationsDir` | Directory holding migration files. Sorted alphabetically. |
| `stages.<name>.region` | AWS region. **Required.** |
| `stages.<name>.tablePrefix` | Prepended to logical table names from `ctx.tableName('users')`. |
| `stages.<name>.tables` | Logical → physical table name overrides (wins over `tablePrefix`). |
| `stages.<name>.ledgerTable` | Override the default ledger table name. |
| `stages.<name>.endpoint` | AWS endpoint override (for ddb-local / testcontainers). |

Credentials come from the default AWS SDK credential chain: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars, IAM role, or `~/.aws/credentials`. Set `AWS_PROFILE` if you need a specific shared profile.

## Migration anatomy

For more patterns — idempotent backfills, expand-and-contract renames, parallel scans with checkpoints, GSI adds — see [`examples/`](./examples/).

```ts
// migrations/2026-05-04-113000-backfill-schema-version.ts
import type { MigrationContext } from 'ddb-migrations';

export const description = 'Backfill schemaVersion=1 on User items';

export async function up(ctx: MigrationContext): Promise<void> {
  const Users = ctx.tableName('users'); // → 'my-app-dev-users'

  let cursor = (await ctx.getCheckpoint<{ lastKey?: Record<string, unknown> }>())?.lastKey;
  do {
    const page = await ctx.ddb.send(new ScanCommand({
      TableName: Users,
      ExclusiveStartKey: cursor,
      FilterExpression: 'attribute_not_exists(schemaVersion)',
    }));

    for (const item of page.Items ?? []) {
      if (ctx.dryRun) continue;
      await ctx.ddb.send(new UpdateCommand({
        TableName: Users,
        Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: 'SET schemaVersion = :v',
        ConditionExpression: 'attribute_not_exists(schemaVersion)',
        ExpressionAttributeValues: { ':v': 1 },
      }));
    }

    cursor = page.LastEvaluatedKey;
    await ctx.checkpoint({ lastKey: cursor });
  } while (cursor);
}

export async function down(ctx: MigrationContext): Promise<void> {
  // The inverse, or throw if not reversible.
  throw new Error('not reversible');
}
```

### Migration context

| Field | Description |
| --- | --- |
| `ddb` | `DynamoDBDocumentClient` (marshaled). Use for item reads/writes. |
| `ddbRaw` | `DynamoDBClient` (low-level). Use for table-level operations. |
| `tableName(logical)` | Resolves a logical name to its physical name for the active stage. |
| `stage` | The stage name. |
| `dryRun` | `true` when running with `--dry-run`. Migrations should branch on this. |
| `logger` | Prefixed logger; prefer this over `console.log`. |
| `checkpoint(value)` | Persist arbitrary JSON state on the ledger row for resume after a crash. |
| `getCheckpoint()` | Read the last checkpoint value. |

## CLI

```
ddb-migrate init
ddb-migrate create <description>
ddb-migrate status --stage <name>
ddb-migrate up     --stage <name> [--to <id>] [--dry-run]
ddb-migrate down   --stage <name> [--shift N] [--dry-run]
```

### Status values

| Status | Meaning |
| --- | --- |
| `pending` | File exists, no ledger entry. |
| `completed` | Applied successfully; checksum recorded. |
| `in_progress` | Started but never marked complete (likely interrupted). Rerunning `up` will retry it. |
| `failed` | Last run threw. Rerun after fixing or investigate. |
| `orphan` | Ledger entry whose file has been deleted from disk. |

### Drift detection

Each completed entry stores a SHA-256 of the file content. If the file changes after being applied, `up` refuses to run and reports the drifted id. Restore the original file or roll back before continuing.

### Dry-run semantics

`--dry-run` does two things:

1. Skips ledger writes (`markStart` / `markComplete` / `checkpoint`).
2. Sets `ctx.dryRun = true` so migration code can branch on it.

The framework can't know which calls inside a migration are side-effects, so **migrations are responsible for honoring `ctx.dryRun`**.

## Running TypeScript migrations

The CLI auto-registers `tsx`'s ESM loader before importing `.ts` migration files. As long as `tsx` is installed (it's a runtime dep of this package), `.ts` migrations Just Work — no compile step.

If you'd rather precompile, point `migrationsDir` at a directory of `.mjs` / `.js` files.

## Multi-stage promotion

Each stage has its own ledger table, so promotion looks like:

```bash
# developer iterating
ddb-migrate up --stage dev

# CI on merge
ddb-migrate up --stage staging

# CI on release (gated)
ddb-migrate up --stage prod
```

Files in `migrations/` are sorted lexicographically by id, so the timestamped prefix from `create` makes ordering deterministic across stages. Don't reorder or rename files after they've been applied somewhere — drift detection will trip.

## Why not `dynamo-data-migrations`?

| | `dynamo-data-migrations` | `ddb-migrations` |
| --- | --- | --- |
| AWS SDK | v2 (EOL) | v3 |
| Multi-env model | AWS profiles | Logical stages with table prefixes |
| Ledger table | One hard-coded name per account | One per stage |
| Drift detection | None | SHA-256 per applied entry |
| Resumable migrations | None | `ctx.checkpoint()` |
| TS migrations | Custom `ts-import` | `tsx` ESM loader |
| Last release | Mar 2024 | active |

The shape (timestamped files, ledger table, `up` / `down` / `status` CLI) is intentionally similar — that part of the design is well-trodden.

## License

MIT
