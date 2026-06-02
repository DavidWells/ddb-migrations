# DynamoDB SDK Call Stats Plan

## Goal

Add first-class DynamoDB SDK call accounting to `ddb-migration-tools` so operators can see what a long-running migration is actually doing while it runs.

The immediate motivating case is output like:

```txt
[2026-06-02_00-13_ksf_full_cleanup] apply delete 5400/11375 47.5% rem=5975 eta=9m3s
  written=0 updated=0 deleted=5400 skipped=0
```

That tells us the migration's domain progress, but not the underlying AWS SDK activity:

- How many SDK calls have been sent?
- How many are reads vs writes?
- How many scan/query pages have returned?
- How many items were returned?
- How much consumed capacity did the operation report?
- Are failures or throttles happening?
- How much ledger/checkpoint traffic is mixed into the run?

The library should expose these counts in the migration context, optionally render them in progress output, and make them available for programmatic callers without each migration copy-pasting a local wrapper.

## Non-Goals

- Do not implement a full AWS SDK retry profiler in the first pass. The wrapper observes top-level `client.send(command)` calls, not internal Smithy retry attempts.
- Do not require migrations to change just to get basic call counts.
- Do not turn on `ReturnConsumedCapacity` by default. It changes command input and response payload size, so it should be explicit.
- Do not persist per-command stats in the ledger by default. Checkpoints should remain migration-owned state, not a growing telemetry blob.
- Do not make the progress renderer DynamoDB-specific. It should render an optional `sdk` field cleanly, but the stats module owns the DynamoDB accounting.

## Current Architecture

Relevant files:

- `src/lib/types.ts`
  - Defines `MigrationContext`, `MigrationProgressEvent`, `Config`, and stage types.
- `src/lib/runner.ts`
  - `makeContext()` constructs `ctx.ddb`, `ctx.ddbRaw`, `ctx.progress`, `ctx.checkpoint`, and shutdown helpers.
- `src/lib/actions/up.ts`
  - Builds app/ledger clients, creates migration context, and invokes `mod.up(ctx)`.
- `src/lib/actions/down.ts`
  - Same migration-context pattern for rollbacks.
- `src/lib/ddb.ts`
  - Creates `DynamoDBClient`, `DynamoDBDocumentClient`, and ledger clients.
- `src/lib/progress.ts`
  - Formats non-TTY and TTY progress events.
- `src/bin/cli.ts`
  - Wires CLI flags and progress printer.

Current important behavior:

- `ctx.ddb` is the high-level `DynamoDBDocumentClient`.
- `ctx.ddbRaw` is the low-level `DynamoDBClient`.
- Ledger/checkpoint operations use `ledgerDoc`/`ledgerRaw`, not `ctx.ddb`.
- Migration code explicitly calls `ctx.progress(event)`.
- The progress printer renders known counters like `written`, `updated`, `deleted`, `skipped`, `remaining`, and `etaSeconds`.

## Design Summary

Add a new stats module that wraps AWS SDK v3 clients:

```ts
const counted = createCountingDdbClient(clients.doc, {
  source: 'app',
  captureConsumedCapacity: false,
});
```

Then expose stats on migration context:

```ts
ctx.ddb       // wrapped high-level DocumentClient
ctx.ddbRaw    // wrapped low-level DynamoDBClient
ctx.sdkStats  // aggregate stats for this migration invocation
```

Basic stats are always-on because they are cheap:

- command counts
- read/write categorization
- success/failure counts
- page/result counts
- returned item counts
- last evaluated key counts

SDK stats are configurable:

- `observability.sdkStatsEnabled` defaults to `true`.
- CLI can disable stats collection with `--no-sdk-stats`.
- API/config can disable collection and progress display with `sdkStatsEnabled: false`.

Consumed capacity is opt-in:

- CLI flag: `--capacity`
- Programmatic API option: `captureConsumedCapacity?: boolean`
- Config default: optional, but lower priority than CLI/API options

When enabled, the wrapper sets `ReturnConsumedCapacity = 'TOTAL'` only when:

- the command input is object-like,
- the field is not already set,
- the command is known to support the option.

## Type Model

Add these types to `src/lib/types.ts` or a new `src/lib/sdk-stats.ts` with re-exports from `src/lib/index.ts`.

```ts
export type DdbCommandClass =
  | 'read'
  | 'write'
  | 'control'
  | 'unknown';

export type DdbClientSource =
  | 'app'
  | 'appRaw'
  | 'ledger'
  | 'ledgerRaw';

export type DdbCommandStats = {
  attempted: number;
  succeeded: number;
  failed: number;
};

export type DdbSdkStatsSnapshot = {
  commands: Record<string, DdbCommandStats>;
  bySource: Record<string, {
    calls: number;
    reads: number;
    writes: number;
    controls: number;
    unknown: number;
    succeeded: number;
    failed: number;
    pages: number;
    itemsReturned: number;
    consumedCapacity: number;
    lastEvaluatedKeyCount: number;
  }>;
  calls: number;
  reads: number;
  writes: number;
  controls: number;
  unknown: number;
  succeeded: number;
  failed: number;
  throttles: number;
  pages: number;
  itemsReturned: number;
  consumedCapacity: number;
  lastEvaluatedKeyCount: number;
  errorsByName: Record<string, number>;
};

export type DdbSdkStats = {
  snapshot(): DdbSdkStatsSnapshot;
  reset(): void;
};
```

Add to `MigrationContext`:

```ts
sdkStats: DdbSdkStats;
```

Add optional progress field:

```ts
export type MigrationProgressEvent = {
  // existing fields...
  sdk?: DdbSdkStatsSnapshot;
};
```

Rationale:

- `snapshot()` prevents migrations from mutating the live stats object.
- `reset()` lets a migration report phase-local stats if it wants to.
- `bySource` prepares the design for counting app and ledger clients separately.
- `controls` separates commands like `DescribeTableCommand` from item reads/writes.

## Command Classification

Create a central classifier in `src/lib/sdk-stats.ts`.

Initial sets:

```ts
const READ_COMMANDS = new Set([
  'GetCommand',
  'QueryCommand',
  'ScanCommand',
  'BatchGetCommand',
  'GetItemCommand',
  'BatchGetItemCommand',
]);

const WRITE_COMMANDS = new Set([
  'PutCommand',
  'UpdateCommand',
  'DeleteCommand',
  'BatchWriteCommand',
  'TransactWriteCommand',
  'PutItemCommand',
  'UpdateItemCommand',
  'DeleteItemCommand',
  'BatchWriteItemCommand',
  'TransactWriteItemsCommand',
]);

const CONTROL_COMMANDS = new Set([
  'CreateTableCommand',
  'DeleteTableCommand',
  'DescribeTableCommand',
  'ListTablesCommand',
  'UpdateTableCommand',
  'DescribeTimeToLiveCommand',
  'UpdateTimeToLiveCommand',
]);
```

Notes:

- A single command name such as `QueryCommand` or `ScanCommand` can cover both lib-dynamodb and client-dynamodb because the classifier only needs the constructor name.
- Unknown commands should still be counted under `unknown`; the library should not throw for unfamiliar AWS SDK commands.
- Export the classifier for tests and downstream debugging.

## Counting Semantics

For each `send(command)`:

1. Determine the command name from `command.constructor.name`, fallback to `'UnknownCommand'`.
2. Increment aggregate `calls` and `commands[name].attempted`.
3. Increment read/write/control/unknown counts based on classification.
4. Optionally inject `ReturnConsumedCapacity = 'TOTAL'`.
5. Await the real client's `send(command)`.
6. On success:
   - increment `succeeded`,
   - increment `commands[name].succeeded`,
   - increment `pages`,
   - add returned item count,
   - add consumed capacity,
   - increment `lastEvaluatedKeyCount` if present.
7. On failure:
   - increment `failed`,
   - increment `commands[name].failed`,
   - increment `errorsByName[error.name]`,
   - increment `throttles` for DynamoDB throttling-ish errors,
   - rethrow exactly the original error.

Important: `attempted` should increment before the real send. This lets operators see that calls were attempted even if AWS rejects them.

## Item Counting

Count returned items from common DynamoDB shapes:

- `Items`: array length.
- `Item`: `1` when present.
- `Responses`: either array length or object of table names to item arrays.
- `UnprocessedKeys`: do not count as returned items.
- `UnprocessedItems`: do not count as returned items.

This is intentionally result-shape based and not command-name based.

## Consumed Capacity

Use helper:

```ts
function capacityUnits(capacity: unknown): number
```

Handle:

- single `ConsumedCapacity` object,
- array of capacity objects,
- `CapacityUnits`,
- `ReadCapacityUnits`,
- `WriteCapacityUnits`.

If DynamoDB returns both read/write units, sum both unless `CapacityUnits` is present.

Open detail to confirm during implementation:

- Some response shapes may include nested index capacity. First pass can ignore per-index detail and use top-level values only.

## Wrapping Clients

Add:

```ts
export function createDdbSdkStats(): DdbSdkStatsController

type SendableClient = {
  send<TOutput>(command: { constructor?: { name?: string }; input?: unknown }): Promise<TOutput>;
};

export function wrapCountingDdbClient<TClient extends SendableClient>(
  client: TClient,
  opts: {
    stats: DdbSdkStatsController;
    source: DdbClientSource;
    captureConsumedCapacity?: boolean;
  },
): TClient
```

Implementation should avoid `any`. AWS SDK v3 `send` generics are hard to preserve exactly across both low-level and DocumentClient variants, so keep the unsafe boundary internal and prefer an `unknown`-based structural shape. If exact structural typing gets too awkward, keep the `unknown` boundary inside `sdk-stats.ts` and export strongly typed public APIs. Avoid leaking weak types into `MigrationContext`.

Do not mutate all methods on the client. Only proxy `send`.

Safe implementation options:

1. `Proxy` wrapper that intercepts `send` and delegates everything else.
2. Shallow wrapper object that spreads/prototypes from client and overrides `send`.

Recommendation: use `Proxy`.

Reasons:

- Preserves SDK client methods/config shape better.
- Lets `ctx.ddb` still behave like a DocumentClient for callers that inspect `.config`.
- Keeps the implementation narrow.

## Context Integration

In `makeContext()`:

1. Create one stats controller per migration context.
2. Wrap `clients.doc` as source `app`.
3. Wrap `clients.raw` as source `appRaw`.
4. Expose `sdkStats`.

```ts
const sdkStats = createDdbSdkStats();

return {
  ddb: wrapCountingDdbClient(clients.doc, { stats: sdkStats, source: 'app', captureConsumedCapacity }),
  ddbRaw: wrapCountingDdbClient(clients.raw, { stats: sdkStats, source: 'appRaw', captureConsumedCapacity }),
  sdkStats,
  // existing context
}
```

The first pass should count only migration app clients, not ledger clients.

Rationale:

- The operator primarily needs app-table activity.
- Ledger/checkpoint writes would add noise, especially for migrations that checkpoint frequently.
- We can add `--include-ledger-stats` later if needed.

Future option:

- Add separate hidden/internal stats for ledger operations if diagnosing checkpoint write volume becomes important.

## CLI/API Options

Add to `UpOptions` and `DownOptions`:

```ts
captureConsumedCapacity?: boolean;
```

Add CLI flags on `up` and `down`:

```bash
ddb-migrate up --stage dev --capacity
ddb-migrate down --stage dev --shift 1 --capacity --force
```

Flag name:

- Use `--capacity`, not `--return-consumed-capacity`.

Reason:

- Operators want a short flag during interactive work.
- The README can explain that it injects `ReturnConsumedCapacity=TOTAL` when supported.

Do not make `--capacity` imply JSON output or extra logs. It only enables capacity collection.

## Config Option

Optional config field:

```ts
export type Config = {
  // existing...
  observability?: {
    sdkStatsEnabled?: boolean;
    captureConsumedCapacity?: boolean;
  };
};
```

Resolution order:

1. Explicit API/CLI option.
2. Config `observability.*`.
3. Defaults:
   - `sdkStatsEnabled: true`
   - `captureConsumedCapacity: false`

This lets projects choose a default without making the package globally noisy.

## Progress Rendering

Add optional SDK rendering to `src/lib/progress.ts`.

TTY format:

```txt
[2026-06-02_00-13_ksf_full_cleanup] apply delete 5400/11375 47.5% rem=5975 eta=9m3s
  sdk calls=5693 reads=293 writes=5400 pages=293 items=29187 rcu=44.5 errors=0
  written=0 updated=0 deleted=5400 skipped=0 checkpointed=false
```

Non-TTY format:

```txt
[2026-06-02_00-13_ksf_full_cleanup] apply delete 5400/11375 ... sdk.calls=5693 sdk.reads=293 sdk.writes=5400 ...
```

Design rules:

- SDK line should appear before business counters when present.
- Show `wcu` only if we can reliably separate write capacity. Otherwise show `cu`.
- Use `cu=...` in first pass for total consumed capacity.
- Keep it compact; truncate still applies.
- Do not render huge `commands` maps in progress lines.

Recommended compact fields:

- `calls`
- `reads`
- `writes`
- `pages`
- `items`
- `cu` only when greater than 0
- `errors` only when greater than 0
- `throttles` only when greater than 0

Example:

```txt
  sdk calls=5693 reads=293 writes=5400 pages=293 items=29187
```

With capacity:

```txt
  sdk calls=5693 reads=293 writes=5400 pages=293 items=29187 cu=5444.5
```

## Automatic Progress Enrichment

There are two possible ways to get stats into progress output.

Option A: migration code includes it manually:

```ts
ctx.progress({
  phase: 'apply',
  sdk: ctx.sdkStats.snapshot(),
});
```

Option B: `ctx.progress()` automatically attaches `sdk: ctx.sdkStats.snapshot()`.

Recommendation: Option B. The escape hatch is disabling SDK stats for the run.

Rationale:

- The point is to avoid copy-paste in migrations.
- Automatic enrichment makes existing migrations immediately more observable.
- Progress events are already low-frequency and explicitly emitted by migrations, so snapshot overhead is negligible.

Implementation:

```ts
progress: (event) => {
  const withStats = sdkStatsEnabled
    ? { sdk: sdkStats.snapshot(), ...event }
    : event;
  opts.onProgress?.({ migrationId, ...withStats });
}
```

Ordering detail:

- If migration code explicitly provides `sdk`, respect it.
- Use `{ migrationId, sdk: sdkStats.snapshot(), ...event }` so explicit `event.sdk` wins.

Add API option:

```ts
sdkStatsEnabled?: boolean; // default true
```

Add CLI flag:

```bash
ddb-migrate up --stage dev --no-sdk-stats
```

This disables SDK stats collection and progress display for the CLI run.

## JSON Output

Current CLI suppresses progress when `--json` is used:

```ts
onProgress: opts.json ? undefined : progress.print
```

Keep that behavior.

Future enhancement:

- `up --json` could include final stats in the result object.

First pass:

- Add `sdkStats` to `UpResult` and `DownResult` only if implementation can do so without making the API awkward.
- Otherwise defer final aggregate JSON output.

Recommendation:

- Include final stats in `UpResult`/`DownResult`.

Reason:

- Programmatic callers and `--json` users should have access to the aggregate run stats.
- The stats object is compact enough.

Shape:

```ts
export type UpResult = {
  applied: string[];
  skipped: string[];
  sdkStats?: Record<string, DdbSdkStatsSnapshot>;
  failed?: { id: string; message: string };
  interrupted?: { id?: string; message: string };
};
```

Better shape:

```ts
sdkStats?: {
  total: DdbSdkStatsSnapshot;
  byMigration: Record<string, DdbSdkStatsSnapshot>;
};
```

Recommendation for first pass:

- Use `byMigration` only.
- Add a helper to merge snapshots later if needed.

## Migration Boundary

Each migration should get its own stats controller.

Reasons:

- A long `up` run might apply multiple pending migrations.
- Operators care which migration is hot.
- Per-migration stats prevent earlier migrations from polluting later progress output.

Implementation in `up.ts`:

- `makeContext()` returns or exposes `sdkStats`.
- After each migration completes/fails/interrupted, snapshot it.
- Store under `result.sdkStats.byMigration[f.id]`.

Same for `down.ts`.

## Failure and Interruption Behavior

On migration failure:

- Stats should include attempted/succeeded/failed calls up to the thrown error.
- The original error path should remain unchanged.

On interruption:

- Stats should include calls up to the page/batch where the migration observed shutdown and exited.
- Forced second Ctrl-C may still lose the latest in-memory stats, which is acceptable because stats are telemetry, not correctness state.

Do not checkpoint stats automatically on every progress event.

Reason:

- It would increase ledger writes.
- Checkpoints should remain migration-owned and semantically meaningful.

## Test Plan

### Unit Tests: Stats Module

New file:

```txt
tests/unit/sdk-stats.test.ts
```

Cases:

1. Counts read commands.
2. Counts write commands.
3. Counts control commands.
4. Counts unknown commands without throwing.
5. Counts `Items`, `Item`, and `Responses`.
6. Counts `LastEvaluatedKey`.
7. Sums consumed capacity from object and array shapes.
8. Injects `ReturnConsumedCapacity = 'TOTAL'` only when enabled and absent.
9. Does not overwrite existing `ReturnConsumedCapacity`.
10. Records failures and rethrows original error.
11. Classifies throttling errors.
12. `snapshot()` returns a deep copy.
13. `reset()` clears stats.

### Unit Tests: Context

Update or add:

```txt
tests/unit/runner.test.ts
```

Cases:

1. `makeContext()` exposes `sdkStats`.
2. `ctx.ddb.send()` increments app source stats.
3. `ctx.ddbRaw.send()` increments appRaw source stats.
4. `ctx.progress()` attaches a stats snapshot by default.
5. Explicit `event.sdk` wins over automatic snapshot.
6. `sdkStatsEnabled: false` suppresses collection and enrichment.

If adding `runner.test.ts` is too much, use existing tests that create contexts.

### Unit Tests: CLI/API

Update `tests/unit/cli.test.ts`:

1. `up --capacity` is accepted.
2. `down --capacity --force` is accepted.
3. Help output includes `--capacity`.

Avoid tests that require AWS.

### Unit Tests: Progress

Update `tests/unit/progress.test.ts`:

1. TTY renders SDK stats as a separate compact line.
2. Non-TTY renders compact SDK fields and does not dump nested `commands`.
3. TTY omits `cu`, `errors`, and `throttles` when zero.
4. TTY includes `cu`, `errors`, and `throttles` when non-zero.

### Manual Preview

Update `tests/render-progress/index.ts` to include fake SDK stats.

Example command:

```bash
npx tsx tests/render-progress/index.ts 100 150 250 16100
```

Expected visual:

```txt
[migration] apply delete 1500/16100 9.3% rem=14600 eta=5m5s
  sdk calls=1620 reads=120 writes=1500 pages=120 items=12000
  written=0 updated=0 deleted=1500 skipped=0 checkpointed=false
```

### Typecheck and Build

Run:

```bash
npm run typecheck
npm test
npm run build
```

## Documentation Plan

Update `README.md`:

1. Add an "SDK call stats" section near progress/checkpoint docs.
2. Explain that basic counts are always-on in migration progress.
3. Explain `--capacity`.
4. Explain `ctx.sdkStats.snapshot()` and `ctx.sdkStats.reset()`.
5. Include example output.

Update `skill/SKILL.md`:

- Mention `--capacity` for diagnosing expensive migrations.
- Mention `ctx.sdkStats` for custom migration progress.

Update `tests/render-progress` README note already present in `README.md` if needed.

## Implementation Phases

### Phase 1: Stats Core

Files:

- `src/lib/sdk-stats.ts`
- `src/lib/types.ts`
- `src/lib/index.ts`
- `tests/unit/sdk-stats.test.ts`

Tasks:

1. Define stats types.
2. Implement command classification.
3. Implement item/capacity helpers.
4. Implement stats controller.
5. Implement counting client wrapper.
6. Export public types/helpers.
7. Add focused unit tests.

Exit criteria:

- Stats wrapper works against fake clients.
- No runner/CLI behavior changed yet.

### Phase 2: Context Integration

Files:

- `src/lib/runner.ts`
- `src/lib/actions/up.ts`
- `src/lib/actions/down.ts`
- `src/lib/types.ts`
- tests for context/actions

Tasks:

1. Add options for capacity and progress enrichment.
2. Wrap `ctx.ddb` and `ctx.ddbRaw`.
3. Add `ctx.sdkStats`.
4. Auto-attach stats snapshots to progress events.
5. Capture final per-migration snapshots into action results if practical.

Exit criteria:

- Existing migrations get SDK stats without code changes.
- Existing tests pass with minimal fixture updates.

### Phase 3: CLI and Progress Rendering

Files:

- `src/bin/cli.ts`
- `src/lib/progress.ts`
- `tests/unit/cli.test.ts`
- `tests/unit/progress.test.ts`
- `tests/render-progress/index.ts`

Tasks:

1. Add `--capacity` to `up` and `down`.
2. Pass capacity option into actions.
3. Render compact SDK stats line in TTY mode.
4. Render compact SDK stats in non-TTY mode.
5. Update render harness with fake SDK stats.

Exit criteria:

- TTY output gives useful SDK activity without wrapping/truncating the main progress line.
- Non-TTY output remains grep-friendly.

### Phase 4: Docs and Examples

Files:

- `README.md`
- `skill/SKILL.md`
- maybe `examples/migrations/...`

Tasks:

1. Document basic stats and capacity mode.
2. Add a short migration snippet using `ctx.sdkStats.snapshot()`.
3. Add a note that `--json` suppresses live progress but can include final stats if implemented.
4. Run full tests/build.

Exit criteria:

- Contributor and user docs explain how to use the feature.
- Published package types include the new context field.

## Edge Cases and Decisions

### What are the main downsides and mitigations?

#### Proxy typing/runtime weirdness

Risk:

- AWS SDK clients expose methods and properties beyond `send`. A wrapper could break callers that inspect `.config` or pass the client to helper functions.

Mitigation:

- Use a minimal `Proxy` that intercepts only `send` and delegates all other properties to the real client.
- Add tests that `ctx.ddb.config` remains readable and that unwrapped properties still resolve.
- Keep the weak structural typing boundary inside `src/lib/sdk-stats.ts`; do not weaken `MigrationContext`.

#### Progress output noise

Risk:

- Small migrations or verbose migrations may get too much output if every progress event includes SDK stats.

Mitigation:

- Provide CLI `--no-sdk-stats` to disable stats collection for a run.
- Provide config/API `sdkStatsEnabled: false`.
- Render only compact aggregate fields, never the full `commands` map, in progress lines.

#### Top-level send counts are not AWS retry counts

Risk:

- Operators may mistake `writes=5400` for exact HTTP requests or exact AWS billing events.

Mitigation:

- Document that stats count migration app-client `send()` calls observed by the wrapper.
- Do not claim retry-level precision.
- Keep retry-level Smithy middleware instrumentation as future work.

#### Consumed capacity can be misleading

Risk:

- `ConsumedCapacity` is absent unless requested and may include mixed read/write units.

Mitigation:

- Keep capacity opt-in via `--capacity` / `captureConsumedCapacity`.
- Render total `cu`, not `rcu`/`wcu`, until the library intentionally models those separately.
- Do not overwrite migration-provided `ReturnConsumedCapacity`.

#### Ledger writes excluded from app stats

Risk:

- Checkpoint-heavy migrations may show fewer writes than the total library traffic to DynamoDB.

Mitigation:

- Label and document first-pass stats as app-table SDK stats.
- Keep ledger stats as explicit future work behind `--include-ledger-stats`.

#### Final JSON result contract

Risk:

- Adding `sdkStats` to `UpResult` / `DownResult` expands the public API surface.

Mitigation:

- Use an optional field with a stable `byMigration` shape.
- Keep progress rendering as the primary deliverable if JSON result integration gets awkward.

#### Concurrent migration code

Risk:

- Migrations using `Promise.all` can make phase-local stats less intuitive.

Mitigation:

- Keep stats aggregate and factual.
- Do not imply ordering or one-to-one mapping between business counters and SDK calls.

### Should ledger operations count?

Decision: no for first pass.

Reason:

- Operators are asking "what is my migration doing to app data?"
- Checkpoint-heavy migrations would make write counts confusing.
- The library can add separate ledger stats later.

### Should stats be checkpointed?

Decision: no.

Reason:

- Stats are telemetry, not resume state.
- Persisting them on every progress event would add extra ledger writes.
- Migration-owned checkpoints already control durable resume state.

### Should capacity capture be default-on?

Decision: no.

Reason:

- It mutates command inputs.
- It changes response payload size.
- Some users may not want extra response metadata.

### Should progress auto-include stats?

Decision: yes.

Reason:

- Existing migrations become observable immediately.
- Snapshot cost is tiny compared with DDB calls.
- Progress events are already explicitly emitted by migration authors.

### What about commands that do not support `ReturnConsumedCapacity`?

Decision:

- Only inject for known commands that support it.
- Never throw just because a command is not in the supported set.

### What about AWS SDK retry attempts?

Decision:

- First pass counts top-level `send()` attempts only.
- Add Smithy middleware instrumentation later if retry-level visibility becomes necessary.

## Acceptance Criteria

Feature is done when:

1. `MigrationContext` exposes `ctx.sdkStats`.
2. `ctx.ddb` and `ctx.ddbRaw` calls are counted automatically.
3. Progress events include compact SDK stats by default.
4. TTY output renders SDK stats on a separate line.
5. Non-TTY output remains single-line and compact.
6. `--capacity` enables consumed-capacity capture for `up` and `down`.
7. Failures and throttles are counted and rethrown unchanged.
8. Tests cover stats, context integration, CLI flags, and progress rendering.
9. `npm run typecheck`, `npm test`, and `npm run build` pass.
10. README documents how to use the feature.

## Future Work

- `--no-sdk-stats` if users find progress too noisy.
- `--include-ledger-stats` for diagnosing checkpoint-heavy migrations.
- Retry-level stats via AWS SDK middleware.
- Per-table stats if table name extraction proves reliable.
- Final stats table after migration completion in non-JSON mode.
- `ddb-migrate stats <migrationId>` if stats are ever persisted.
- Local progress snapshots for dry-run/apply diagnostics.
