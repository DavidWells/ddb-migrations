# Examples

Illustrative migration files for common DynamoDB schema-evolution
patterns. They aren't run by the test suite — they exist as reference
material to copy into your own project's `migrations/` directory.

Each file imports `MigrationContext` from `ddb-migration-tools` (the way a
consumer would). The examples are excluded from this repo's `tsc` build
because the import path only resolves once the package is installed.

## Index

| File | Pattern | When to use it |
| --- | --- | --- |
| `2026-01-01-000000-add-schema-version.ts` | Idempotent additive backfill | Adding a new attribute to existing items. |
| `2026-01-02-000000-rename-status-to-state.ts` | Phase 2 of expand-and-contract rename | Backfilling the new attribute after app code has been taught to dual-write. |
| `2026-01-03-000000-parallel-scan-with-checkpoints.ts` | Resumable parallel scan | Heavy backfills on large tables; want to resume after a crash. |
| `2026-01-04-000000-add-email-gsi.ts` | Table-level operation | Adding a Global Secondary Index. No item iteration needed. |
| `2026-01-05-000000-remove-deprecated-status.ts` | Phase 3 of expand-and-contract rename | Removing the old attribute after app code has stopped writing it. |

## Patterns at a glance

### Idempotency

Every example filters or conditions on the version/state it's migrating
*from*, so re-running after a crash doesn't redo work or fight
concurrent app writes. This is non-negotiable — DDB doesn't have
transactions across millions of items, so your migration has to be
crash-safe by design.

### Dry-run

Migrations branch on `ctx.dryRun` to skip side effects. The framework
can't know which `ddb.send` calls in your code are writes, so honoring
the flag is on you.

### Reversibility

Most data migrations are not safely reversible. Once you've removed an
attribute or normalized a value, the original is often gone for good.
Throwing in `down()` is more honest than a fake rollback that silently
breaks data — if you need to undo, deploy a *new* forward migration.

The GSI example is one of the few that's cleanly reversible (delete the
index).

### Expand-and-contract for renames

Three phases, three deploys:

1. **App code change.** Read both `old` and `new`, prefer `new`. Write both.
2. **Migration (this folder, phase 2).** Backfill `new` from `old` for
   any item that has `old` but not `new`.
3. **App code + cleanup migration.** App writes only `new`. After that's
   live everywhere, run a cleanup migration (phase 3) that removes `old`.

Compress this into one phase only if your downtime tolerance is
flexible. The three-phase pattern is what you reach for when migrations
have to happen alongside live traffic.

### Big tables

For tables under a million items, the simple sequential scan in
example 1 is fine. For tens of millions, use the parallel-scan +
checkpoint pattern in example 3.

For 50M+ items or where you want zero impact on the live table, the
right answer is usually outside this framework: export the table to S3,
transform with AWS Glue or a Step Functions distributed map, then
import the result into a new table. This framework is for migrations
that fit inside a CLI process talking directly to your live table.
