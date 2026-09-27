<h1 align="center">ddb-migration-tools</h1>

<p align="center">
  <strong>Stage-aware DynamoDB migrations for TypeScript.</strong><br/>
  AWS SDK v3 · checksum drift detection · resumable checkpoints · cooperative Ctrl-C · shared per-account ledger.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ddb-migration-tools"><img alt="npm" src="https://img.shields.io/npm/v/ddb-migration-tools.svg"></a>
  <a href="https://github.com/DavidWells/ddb-migrations/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/DavidWells/ddb-migrations/actions/workflows/ci.yml/badge.svg?branch=master"></a>
  <a href="https://www.npmjs.com/package/ddb-migration-tools"><img alt="types" src="https://img.shields.io/npm/types/ddb-migration-tools.svg"></a>
  <img alt="node" src="https://img.shields.io/node/v/ddb-migration-tools.svg">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/ddb-migration-tools.svg"></a>
</p>

```bash
npm install --save-dev ddb-migration-tools
npx ddb-migrate init
```

---

## The problem

DynamoDB has no schema migrations. Most teams end up with:

- One-off backfill scripts nobody reruns or audits
- Hand-rolled per-stage ledgers that drift apart
- Half-finished migrations after a crash or Ctrl-C, with no record of what landed
- `dynamo-data-migrations` is stuck on AWS SDK v2 (EOL) and assumes one AWS profile per stage

## The solution

A small CLI + library that:

- Discovers timestamped `.ts` migrations in a directory and runs them in order
- Targets a stage (`dev` / `staging` / `prod`) with per-stage `tablePrefix` mapping
- Records each apply in one shared DynamoDB ledger table per AWS account/region
- Stores a SHA-256 of every applied migration so you can't silently rewrite history
- Persists per-migration checkpoint state so 10-million-item backfills survive crashes
- Translates Ctrl-C into a cooperative `interrupted` ledger row instead of an orphan

## Why use it

| You need | This gives you |
| --- | --- |
| Apply once, exactly once, per stage | Stage-scoped ledger rows: `pk = SCOPE#<app>#STAGE#<stage>` |
| Catch edited migrations | SHA-256 drift check on every `up` / `status` |
| Resume a 10M-row backfill | `ctx.checkpoint(state)` / `ctx.getCheckpoint()` |
| Stop a long migration cleanly | First Ctrl-C → cooperative `interrupted` row; second forces exit (130) |
| Pre-flight a prod rollout | `plan` (no code import) + `doctor` (config/ledger/AWS identity) + `up --dry-run` |
| No compile step | `tsx`'s ESM loader, auto-registered for `.ts` |
| AWS SDK v3 | Built on `@aws-sdk/lib-dynamodb` |
| One ledger across regions | Optional `ledger.region` override |
| Agent-driven ops | `--json` on every read command, deterministic exit codes |

---

## Quick example

```bash
# Pre-flight
npx ddb-migrate current                     # confirm cwd / config / version
npx ddb-migrate doctor --stage dev          # config + ledger + AWS identity + migration health
npx ddb-migrate plan   --stage dev          # what would run, with reasons (no code import)
npx ddb-migrate status --stage dev          # current ledger view
npx ddb-migrate up     --stage dev --dry-run

# Apply
npx ddb-migrate up     --stage dev
npx ddb-migrate status --stage dev

# Rollback (always requires --force for non-dry-run)
npx ddb-migrate down   --stage dev --shift 1 --dry-run
npx ddb-migrate down   --stage dev --shift 1 --force
```

Prod-like stages (`prod` in the name) require `--force` for non-dry-run `up`:

```bash
npx ddb-migrate up --stage prod --dry-run
npx ddb-migrate up --stage prod --force
```

---

## vs `dynamo-data-migrations`

The CLI shape (timestamped files, ledger table, `up` / `down` / `status`) is intentionally similar — that part of the design is well-trodden.

| | `dynamo-data-migrations` | `ddb-migration-tools` |
| --- | --- | --- |
| AWS SDK | v2 (EOL) | v3 |
| Multi-env model | AWS profiles | Logical stages with table prefixes |
| Ledger table | One hard-coded name per account | One shared table per account/region, scoped by app/stage keys |
| Drift detection | None | SHA-256 per applied entry |
| Resumable migrations | None | `ctx.checkpoint()` |
| Cooperative shutdown | None | `ctx.signal` / `ctx.throwIfStopped()` |
| Structured progress | None | `ctx.progress()` events |
| TS migrations | Custom `ts-import` | `tsx` ESM loader |
| Pre-flight tools | — | `plan`, `doctor`, `current` |
| Last release | Mar 2024 | active |

---

## Install

```bash
npm install --save-dev ddb-migration-tools
# or
pnpm add -D ddb-migration-tools
# or
yarn add -D ddb-migration-tools
```

Requires Node `>= 20`. Credentials come from the default AWS SDK credential chain: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars, IAM role, or `~/.aws/credentials`. Set `AWS_PROFILE` for a specific shared profile.

### Companion agent skill

For Claude Code, Codex, Cursor, and other Agent Skills-compatible tools:

```bash
npx skills add DavidWells/ddb-migrations
```

The skill teaches the agent the config layout, safety rules, and CLI workflow so it can write and run migrations without re-reading this README every session.

---

## Configuration

`ddb-migrations.config.json` (also accepts `.js`, `.mjs`, `.ts`):

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
| `appName` | Default app/scope namespace for ledger rows. |
| `migrationsDir` | Directory holding migration files. Sorted alphabetically. |
| `ledger.tableName` | Shared migration ledger table. Defaults to `ddb-migrations-ledger`. Deploy one per AWS account/region. |
| `ledger.scope` | Optional namespace for ledger rows. Defaults to `appName`. |
| `ledger.region` | Region the ledger table lives in. Defaults to the active stage's `region`. Set this to centralize the ledger when app tables span regions. |
| `ledger.endpoint` | AWS endpoint override for the ledger client only (e.g. for a local ledger). |
| `ledger.create` | Create the ledger table when it is missing. Defaults to `true`. With `false`, commands that need it throw `LedgerMissingError` (`code: 'LEDGER_MISSING'`) and never call `CreateTable`; use this when your infrastructure owns the table. |
| `observability.sdkStatsEnabled` | Wrap migration app clients and collect SDK `send()` stats. Defaults to `true`. |
| `observability.captureConsumedCapacity` | Request `ReturnConsumedCapacity=TOTAL` on supported app commands. Defaults to `false`. |
| `stages.<name>.region` | AWS region for this stage's app tables. **Required.** |
| `stages.<name>.accountId` | Optional AWS account ID for audit/guardrail use. Not part of the ledger key. |
| `stages.<name>.tablePrefix` | Prepended to logical table names from `ctx.tableName('users')`. |
| `stages.<name>.tables` | Logical → physical table name overrides (wins over `tablePrefix`). |
| `stages.<name>.ledgerTable` | Stage-specific ledger table override. Most projects should prefer `ledger.tableName`. |
| `stages.<name>.ledgerRegion` | Stage-specific ledger region override. Wins over `ledger.region`. |
| `stages.<name>.ledgerEndpoint` | Stage-specific ledger endpoint override. Wins over `ledger.endpoint`. |
| `stages.<name>.endpoint` | AWS endpoint override (for ddb-local / testcontainers). |
| `stages.<name>.profile` | Optional AWS shared config profile name. Callers may also set `AWS_PROFILE`. |

---

## Writing migrations

Migrations may be single files:

```txt
migrations/
  2026-05-04_11-30_backfill_schema_version.ts
```

Or directories with an `index` entrypoint and colocated fixtures/helpers:

```txt
migrations/
  2026-05-04_11-30_backfill_schema_version/
    index.ts
    fixture.json
```

Directory migration checksums include every non-hidden file under the migration directory, so fixture/helper drift is detected after a migration has been applied.

```ts
// migrations/2026-05-04_11-30_backfill_schema_version/index.ts
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MigrationContext } from 'ddb-migration-tools';

export const description = 'Backfill schemaVersion=1 on User items';

export async function up(ctx: MigrationContext): Promise<void> {
  const Users = ctx.tableName('users'); // → 'my-app-dev-users'

  let cursor = (await ctx.getCheckpoint<{ lastKey?: Record<string, unknown> }>())?.lastKey;
  do {
    ctx.throwIfStopped(); // cooperative Ctrl-C boundary

    const page = await ctx.ddb.send(new ScanCommand({
      TableName: Users,
      ExclusiveStartKey: cursor,
      FilterExpression: 'attribute_not_exists(schemaVersion)',
    }));

    let updated = 0;
    for (const item of page.Items ?? []) {
      if (ctx.dryRun) continue;
      await ctx.ddb.send(new UpdateCommand({
        TableName: Users,
        Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: 'SET schemaVersion = :v',
        ConditionExpression: 'attribute_not_exists(schemaVersion)',
        ExpressionAttributeValues: { ':v': 1 },
      }));
      updated += 1;
    }

    cursor = page.LastEvaluatedKey;
    await ctx.checkpoint({ lastKey: cursor });
    ctx.progress({ phase: 'apply', table: Users, updated, sdk: ctx.sdkStats.snapshot() });
  } while (cursor);
}

export async function down(ctx: MigrationContext): Promise<void> {
  throw new Error('not reversible');
}
```

For more patterns — idempotent backfills, expand-and-contract renames, parallel scans with checkpoints, GSI adds — see [`examples/`](./examples/).

### Migration context

| Field | Description |
| --- | --- |
| `ddb` | `DynamoDBDocumentClient` (marshaled). Use for item reads/writes. |
| `ddbRaw` | `DynamoDBClient` (low-level). Use for table-level operations. |
| `tableName(logical)` | Resolves a logical name to its physical name for the active stage. |
| `stage` | The stage name. |
| `dryRun` | `true` when running with `--dry-run`. Migrations should branch on this. |
| `logger` | Prefixed logger; prefer this over `console.log`. |
| `signal` | `AbortSignal` aborted when the operator requests shutdown (e.g. first Ctrl-C). |
| `shouldStop()` | Returns `true` once shutdown has been requested. Check at page/batch boundaries. |
| `throwIfStopped()` | Throws `MigrationInterruptedError` when shutdown has been requested, leaving the ledger row `in_progress` (later `up` retries). |
| `progress(event)` | Emit a structured progress event for the CLI's renderer. |
| `sdkStats` | Per-migration DynamoDB app-client `send()` stats. Use `snapshot()` / `reset()`. |
| `params` | Frozen shallow copy of `up({ params })`. An empty object when unset (and always for the CLI). |
| `checkpoint(value)` | Persist arbitrary JSON state on the ledger row for resume after a crash. |
| `getCheckpoint()` | Read the last checkpoint value. |

---

## CLI

```
ddb-migrate [-C <project>] current                                              [--json]
ddb-migrate [-C <project>] init
ddb-migrate [-C <project>] create <description>                                 [--flat]
ddb-migrate [-C <project>] status     --stage <name>                            [--json]
ddb-migrate [-C <project>] plan       --stage <name> [--to <id>]                [--json]
ddb-migrate [-C <project>] doctor     --stage <name>                            [--json]
ddb-migrate [-C <project>] up         --stage <name> [--to <id>] [--dry-run] [--force] [--capacity] [--no-sdk-stats] [--lock-owner <owner> [--lock-ttl <seconds>]] [--json]
ddb-migrate [-C <project>] down       --stage <name> [--shift N] [--dry-run] [--force] [--capacity] [--no-sdk-stats] [--json]
ddb-migrate [-C <project>] checkpoint show  <migrationId> --stage <name>        [--json]
ddb-migrate [-C <project>] checkpoint clear <migrationId> --stage <name> --force [--json]
```

| Command | Purpose |
| --- | --- |
| `current` | Print the resolved CLI context (cwd, config path, version). |
| `init` | Scaffold `ddb-migrations.config.json` and a `migrations/` directory. |
| `create` | Create a timestamped migration directory (or `--flat` file). |
| `status` | Print the migration ledger for a stage, with drift flags. |
| `plan` | Compute the execution plan **without importing migration code**. |
| `doctor` | Run config, ledger, AWS identity, and migration health checks. |
| `up` | Apply pending migrations. |
| `down` | Roll back the last `N` completed migrations (`--shift 0` means everything). |
| `checkpoint show` | Print the saved checkpoint for a migration. |
| `checkpoint clear` | Remove the saved checkpoint (requires `--force`). |

Use `-C, --cwd <path>` to run from outside the project directory; `DDB_MIGRATE_CWD` is honored when `--cwd` is not set. Add `--json` to any read-style command (`status`, `plan`, `doctor`, `current`, `checkpoint show`) for CI and agents. `up --json` / `down --json` print the final result as JSON and suppress progress events.

**Exit codes:** `0` success · `1` failure · `130` interrupted by signal.

`up --lock-owner <owner>` takes the stage's run lock before reading the ledger and fails with `LOCK_HELD` (naming the holder) when another owner holds a live lease. `--lock-ttl` sets the lease length in seconds (default `3600`); the lease is renewed before each migration and on each `ctx.checkpoint()`. See [Run lock](#run-lock).

```bash
ddb-migrate -C services/api current
ddb-migrate -C services/api plan --stage dev
ddb-migrate -C services/api up   --stage dev --dry-run
```

---

## Operator workflow

`plan` is intentionally different from `up --dry-run`: it does **not** import or execute migration code (the programmatic `plan({ includeMeta: true })` imports modules to read their exports, but never calls `up`). It compares migration files with the ledger and prints what would be selected for execution. Use `plan` first, then `up --dry-run` to exercise the full code path with `dryRun=true`.

```bash
ddb-migrate -C services/api current
ddb-migrate -C services/api doctor --stage dev
ddb-migrate -C services/api plan   --stage dev
ddb-migrate -C services/api up     --stage dev --dry-run
ddb-migrate -C services/api up     --stage dev
ddb-migrate -C services/api status --stage dev
```

### Prod safety

Non-dry-run `up` for any stage whose name contains `prod` requires `--force`:

```bash
ddb-migrate -C services/api up --stage prod --dry-run
ddb-migrate -C services/api up --stage prod --force
```

Rollback is always destructive, so non-dry-run `down` always requires `--force`:

```bash
ddb-migrate -C services/api down --stage dev --shift 1 --dry-run
ddb-migrate -C services/api down --stage dev --shift 1 --force
```

### Interruption and resume

The first `SIGINT` / `SIGTERM` / `SIGQUIT` triggers cooperative shutdown: `ctx.signal` aborts and `ctx.throwIfStopped()` raises a `MigrationInterruptedError`. The ledger row is marked `interrupted` and a later `up` will retry it. A second signal forces exit with code 130; the CLI still attempts to persist the interrupted status synchronously.

Inspect or clear a stuck checkpoint:

```bash
ddb-migrate checkpoint show  <migrationId> --stage dev
ddb-migrate checkpoint clear <migrationId> --stage dev --force
```

---

## Programmatic API

Every CLI verb is also a function exported from `ddb-migration-tools`. `up`, `plan`, `status` and `doctor` accept extra options for running migrations from another program, such as a deploy pipeline. All of them are opt-in: leave them unset and behavior matches the CLI.

```ts
import { plan, up } from 'ddb-migration-tools';

const result = await up({
  stage: 'dev',
  cwd: '/path/to/service',          // base for migrationsDir
  config: { appName: 'orders', migrationsDir: 'migrations', ledger: { tableName: 'orders-migrations', create: false }, stages: { dev: { region: 'us-east-1' } } },
  clients: { app: { raw: appClient }, ledger: { raw: ledgerClient } },
  appliedBy: 'deployer:run-42',
  params: { deploymentId: 'dep_1' },
  lock: { owner: 'deployer:run-42', ttlSeconds: 3900 },
  only: ['2026-10-01_12-00_backfill-status'],
  onEvent: (event) => console.log('migration event', event),
});
```

| Option | Actions | Effect |
| --- | --- | --- |
| `config` | `up` `plan` `status` `doctor` | Config object (same shape as the config file). No config file is read; `cwd` still sets the base for `migrationsDir`. `plan`/`doctor` report `configPath` as `<options.config>`. |
| `clients` | `up` `plan` `status` `doctor` | `{ app?, ledger? }`, each `{ raw: DynamoDBClient, doc?: DynamoDBDocumentClient }`. The ledger client carries every ledger command; migration code (`ctx.ddb` / `ctx.ddbRaw`) sees only the app client. A missing one is built from the stage config with the default credential chain; an injected app client is never reused for the ledger. With an injected app client, the `accountId` check uses its credentials. |
| `appliedBy` | `up` | Replaces `user@host` as the ledger row's `appliedBy`. |
| `params` | `up` | Exposed to migrations as `ctx.params`. |
| `lock` | `up` | `{ owner, ttlSeconds, onTakeover? }` takes the run lock (see [Run lock](#run-lock)). `{ owner, held: true, ttlSeconds? }` is for a caller that already holds it: `up` only verifies ownership, never releases, and heartbeats only outside a dry-run. |
| `only` | `up` | Apply just these pending ids, in lexical order; the rest stay pending. An id that is not pending is an error, and so is combining it with `to`. |
| `onEvent` | `up` | Receives `start`, `progress`, `checkpoint`, `complete`, `fail` and `interrupt` events with the migration id. |
| `includeMeta` | `plan` | Import each pending migration and return its non-function exports as `pending[].meta`. This runs module top-level code, so keep migrations free of top-level side effects. |

`up` resolves with `applied` / `skipped` / `failed` / `interrupted` as before, plus:

- `results`: one entry per executed migration, `{ id, checksum, status, durationMs, sdkStats?, progress?, error? }`, where `status` is `completed`, `dry-run`, `failed` or `interrupted` and `progress` is the last `ctx.progress()` event;
- `pending`: ids still not completed after the run (a dry-run completes nothing);
- `lock`: `{ owner, takeover, previousOwner?, released }` when `lock` was used.

`plan` also returns `pending: [{ id, checksum, path, meta? }]` for every not-completed migration.

### Run lock

The lock is one row per scope and stage in the ledger table: `pk = LOCK#SCOPE#<scope>#STAGE#<stage>`, `sk = LOCK`, with `owner`, `acquiredAt`, `expiresAt` (epoch seconds), `heartbeatAt`, and `releasedAt` / `previousOwner` when set. It is a lease:

- **Acquire** is a conditional put that succeeds when the row is missing, expired, released or already owned by the same owner. Otherwise it throws `LockHeldError` (`code: 'LOCK_HELD'`, `holder`, `expiresAt`). Taking over another owner's expired, unreleased lease is reported as `takeover` and passed to `onTakeover(previous)`.
- **Heartbeat** extends an unreleased lease owned by the caller. **Release** sets `expiresAt = 0` and `releasedAt`; the row is never deleted. Both throw `LockLostError` (`code: 'LOCK_LOST'`) when the caller no longer owns the lease.
- `up` stops at the next heartbeat once its lease is lost: the migration is reported as failed and its ledger row stays `in_progress` for a later run to resume.

`acquireLock`, `heartbeatLock`, `releaseLock`, `assertLockHeld` and `readLock` are exported for callers that hold the lease across several `up` calls, for example a parent process that heartbeats while child processes run with `lock: { owner, held: true }`.

Lease expiry compares the writer's clock with `expiresAt`; keep the TTL well above expected clock skew between runners.

### Ledger write conditions

Each `up` run stamps a fresh `runToken` on the ledger row when it starts a migration. Its later writes to that row (`completed`, `failed`, `interrupted`, checkpoints) require that token and a row that is not `completed`. A run that was superseded by another run, or that reaches a row someone else completed, gets `LedgerConflictError` (`code: 'LEDGER_CONFLICT'`) instead of rewriting it, and `up` reports the migration as failed without touching the row. A completed row is never rewritten.

---

## Observability

Migration app-table clients are wrapped by default so progress output can show DynamoDB SDK activity alongside migration business counters:

```txt
[2026-06-02_cleanup] apply delete 5400/11375 47.5% rem=5975 eta=9m3s
  sdk calls=5693 reads=293 writes=5400 pages=293 items=29187
  written=0 updated=0 deleted=5400 skipped=0
```

These are top-level `ctx.ddb.send()` / `ctx.ddbRaw.send()` calls observed by the wrapper. They are not AWS SDK internal retry attempts and do not include ledger/checkpoint writes.

| Flag | Effect |
| --- | --- |
| `--capacity` | Request `ReturnConsumedCapacity=TOTAL` on supported app commands; renders as `cu` in progress output. |
| `--no-sdk-stats` | Disable SDK call wrapping/collection for the run. |
| `observability.sdkStatsEnabled` | Project default for SDK stats (default `true`). |
| `observability.captureConsumedCapacity` | Project default for capacity capture (default `false`). |

Migration code can inspect or reset stats directly:

```ts
ctx.progress({ phase: 'apply', sdk: ctx.sdkStats.snapshot() });
ctx.sdkStats.reset();
```

---

## Lifecycle

### Status values

| Status | Meaning |
| --- | --- |
| `pending` | File exists, no ledger entry. |
| `completed` | Applied successfully; checksum recorded. |
| `in_progress` | Started but never marked complete (likely a crash). Rerunning `up` will retry it. |
| `interrupted` | Operator-requested shutdown via Ctrl-C. Rerunning `up` will retry it. |
| `failed` | Last run threw. Rerun after fixing or investigate. |
| `orphan` | Ledger entry whose file has been deleted from disk. |

### Drift detection

Each completed entry stores a SHA-256 of the file content. If the file changes after being applied, `up` refuses to run and reports the drifted id. Restore the original file or roll back before continuing. Directory migrations checksum every non-hidden file under the directory.

### Dry-run semantics

`--dry-run` does two things:

1. Skips ledger writes (`markStart` / `markComplete` / `checkpoint`).
2. Sets `ctx.dryRun = true` so migration code can branch on it.

The framework can't know which calls inside a migration are side-effects, so **migrations are responsible for honoring `ctx.dryRun`**.

### Running TypeScript migrations

The CLI auto-registers `tsx`'s ESM loader before importing `.ts` migration files. As long as `tsx` is installed (it's a runtime dep of this package), `.ts` migrations Just Work — no compile step. If you'd rather precompile, point `migrationsDir` at a directory of `.mjs` / `.js` files.

---

## Topology

### Multi-stage promotion

By default, each AWS account/region has one shared ledger table, while app/stage isolation lives in the item keys:

```txt
pk = SCOPE#<ledger.scope or appName>#STAGE#<stage>
sk = MIGRATION#<migrationId>
```

`accountId` and `region` are stored as item attributes when configured, but are not part of the primary key. The account is implied by the DynamoDB table you are writing to.

Promotion looks like:

```bash
ddb-migrate up --stage dev        # developer iterating
ddb-migrate up --stage staging    # CI on merge
ddb-migrate up --stage prod --force  # CI on release (gated)
```

Files and migration directories in `migrations/` are sorted lexicographically by id, so the timestamped prefix from `create` makes ordering deterministic across stages. Don't reorder or rename migrations after they've been applied somewhere — drift detection will trip.

### Centralized ledger across regions

By default the ledger client reuses the stage's region — one ledger per AWS account/region. If app tables span multiple regions but you want a single shared ledger, set `ledger.region` (or `stages.<name>.ledgerRegion`):

```json
{
  "ledger": { "tableName": "ddb-migrations-ledger", "region": "us-east-1" },
  "stages": {
    "prod-us": { "region": "us-east-1", "tablePrefix": "myapp-prod-us-" },
    "prod-eu": { "region": "eu-west-1", "tablePrefix": "myapp-prod-eu-" }
  }
}
```

Each stage still talks to its own app tables in `stage.region`; only the ledger reads and writes route to `ledger.region`. The `region` attribute on each ledger row continues to record the *app* region the migration ran against.

### Ledger stack

`stack/` ships a Serverless Framework reference stack for the ledger table itself: PAY_PER_REQUEST, SSE enabled, point-in-time recovery on, `DeletionPolicy: Retain`. Deploy one stack per AWS account/region:

```bash
cd stack
npm install
npx osls deploy --stage prod --region us-east-1
```

Override the physical table name with `--param='ledgerTableName=my-ledger'`. See [`stack/README.md`](./stack/README.md) for details. The table is retained on stack delete.

---

## Architecture

```
   migrations/                             AWS Account / Region
   ┌─────────────────────────────┐         ┌────────────────────────────────────┐
   │ 2026-05-04_…_users.ts       │         │  app tables                         │
   │ 2026-05-12_…_orders/        │         │  my-app-<stage>-users               │
   │   index.ts                  │         │  my-app-<stage>-orders              │
   │   fixture.json              │         └──────────────▲──────────────────────┘
   └──────────────┬──────────────┘                        │
                  │                                       │ ctx.ddb / ctx.ddbRaw
                  ▼                                       │ (app-table reads/writes)
         ┌────────────────────┐                           │
         │   ddb-migrate CLI  │ ──────────────────────────┘
         │   init / create    │
         │   plan / doctor    │                           ┌────────────────────────┐
         │   up / down        │ ─── checksum + status ──► │ ddb-migrations-ledger   │
         │   status / current │ ─── checkpoint state ───► │  pk = SCOPE#app#STAGE#…│
         │   checkpoint …     │                           │  sk = MIGRATION#<id>    │
         └─────────▲──────────┘                           │  status, checksum,      │
                   │                                      │  duration, appliedBy,   │
                   │                                      │  checkpoint blob        │
   ddb-migrations.config.json                             └────────────────────────┘
   (stages, table prefixes, ledger location)
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `DRIFT` shown on `status` / `up` refuses to run | A migration file was edited after being applied somewhere | Restore the original content, or `down` past it and reapply. Don't edit applied migrations — write a forward-only repair instead. |
| `Non-dry-run up for stage 'prod' requires --force.` | Prod-name safety guard | Add `--force` after the dry-run looks correct. |
| `Non-dry-run down requires --force.` | Rollback safety guard | Add `--force` after the dry-run looks correct. |
| Status `in_progress` never clears | A previous `up` crashed mid-flight | Just rerun `up`; with checkpoints + idempotent writes it will resume. If the migration is unsalvageable, `checkpoint clear <id> --force` then mark or roll back manually. |
| Status `interrupted` | Operator hit Ctrl-C during a run | Rerun `up`. The retry resumes from the last `ctx.checkpoint()`. |
| Status `orphan` | Someone deleted an applied migration file | Restore the file from git, or accept the orphan as a historical record. Forward-only repair if behavior needs to change. |
| `ResourceNotFoundException: <ledger-table>` | Ledger table not deployed in this account/region | Deploy `stack/` to the target account/region, or set `ledger.region` to a region where it does exist. |
| `LEDGER_MISSING` | `ledger.create` is `false` and the ledger table does not exist | Deploy the stack that owns the ledger table, or check `ledger.tableName` / region. |
| `LOCK_HELD` | Another runner holds a live lease on the stage | Wait for it, or for the lease to expire (`expiresAt`), then rerun. |
| `LOCK_LOST` | This run's lease expired or was taken over | Raise the lock TTL or checkpoint more often; rerun `up` to resume. |
| `LEDGER_CONFLICT` | Another run started or completed the same migration concurrently | Check `status`; rerun `up` if the migration is still pending. |
| Wrong table prefix in resolved table name | Stage `tablePrefix` mismatch | Check `ddb-migrate current` + `doctor --stage <s>`; `ctx.tableName('users')` returns `<prefix>users`. |
| AWS credential errors | Default credential chain didn't resolve | Set `AWS_PROFILE`, or env vars, or run inside a role-bound environment. `doctor` runs `sts:GetCallerIdentity` to surface this. |

---

## Limitations

- **The run lock is opt-in.** Without `--lock-owner` / `lock`, concurrent `up` runs on the same stage are not serialized; coordinate at the CI level or use the lock.
- **No built-in parallel-scan helper.** Migrations roll their own; `examples/2026-01-03-000000-parallel-scan-with-checkpoints.ts` shows the pattern.
- **No `--from` flag.** `up` always replays from the oldest pending migration; bound the upper end with `--to`.
- **DynamoDB only.** Local development against `amazon/dynamodb-local` works (set `endpoint`), but there's no other DB target.
- **`down()` is opt-in per migration.** The framework will run it if defined, but the convention is forward-only with explicit `throw` in `down()`.

---

## FAQ

**What happens if two CI jobs run `up --stage prod` at the same time?**
There is no distributed lock. The ledger surfaces `in_progress` rows but you should coordinate in CI (single-flight workflow or queue).

**Can I rename a migration file after it's been applied?**
No. The id is the ledger primary key and the checksum is recorded. Write a new forward-only migration to repair.

**Do I need a separate ledger per stage?**
No. One ledger per AWS account/region. Stage is part of the row's primary key. Centralize further with `ledger.region` if app tables span regions.

**How do I migrate from `dynamo-data-migrations`?**
There's no automatic import. Manually seed a ledger row per already-applied migration with the matching id and checksum, then run new work through `ddb-migration-tools`.

**Can I use this without TypeScript?**
Yes. Point `migrationsDir` at compiled `.mjs` / `.js` files. The `tsx` loader is only needed for `.ts`.

**How do I test migrations locally?**
Run `docker compose up -d` (DynamoDB local) and add `endpoint: "http://localhost:8000"` to a stage in your config. Or use `testcontainers` from your project's test harness.

**Why aren't credentials in the config file?**
The CLI uses the standard AWS SDK credential chain (env vars, IAM role, `~/.aws/credentials`). Set `AWS_PROFILE` for a specific profile, or `stages.<name>.profile` in config.

**Can I run a single migration in isolation?**
Use `--to <migrationId>` on `up` (or `plan`) to bound the upper end of execution. The CLI does not support running an out-of-order single migration; that would break the lexicographic-ordering invariant.

---

## Contributor Utilities

### Preview TTY progress output

Use the render harness to inspect the migration progress display without touching DynamoDB:

```bash
npx tsx tests/render-progress/index.ts
```

The optional arguments are:

```bash
npx tsx tests/render-progress/index.ts <columns> <delayMs> <stepSize> <total>
```

For example, this previews an 88-column terminal with fast frames and a smaller fake delete plan:

```bash
npx tsx tests/render-progress/index.ts 88 80 1000 5000
```

## License

MIT
