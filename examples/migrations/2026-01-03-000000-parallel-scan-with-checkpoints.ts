/**
 * Parallel-scan migration with resumable per-segment checkpoints.
 *
 * Pattern: heavy backfill on a table with millions of items.
 *
 * Three things going on:
 *
 *  1. TotalSegments=N gives us N independent cursors that DDB shards
 *     across the keyspace. The sweet spot is usually 4-16.
 *
 *  2. Each segment's progress lives in its own slot of the checkpoint,
 *     so a crashed run resumes each segment from its last known cursor
 *     rather than restarting all of them.
 *
 *  3. ctx.checkpoint() does a full overwrite of the checkpoint object.
 *     With N segments writing concurrently, two writes would clobber
 *     each other. The AsyncLock below serializes the round-trips so
 *     only one segment writes at a time, but every write reads from the
 *     shared `cp` object — so segment 2's mutations are flushed by the
 *     next checkpoint write from any segment.
 */
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MigrationContext } from 'ddb-migration-tools';

const TOTAL_SEGMENTS = 8;
const TARGET_VERSION = 2;

type Checkpoint = {
  /** Per-segment LastEvaluatedKey. null means the segment is finished. */
  cursors: (Record<string, unknown> | null | undefined)[];
  processedPerSegment: number[];
};

export const description = 'Migrate Widgets to schemaVersion=2 (parallel)';

export async function up(ctx: MigrationContext): Promise<void> {
  const Widgets = ctx.tableName('widgets');
  const cp: Checkpoint =
    (await ctx.getCheckpoint<Checkpoint>()) ?? freshCheckpoint();
  const lock = new AsyncLock();

  await Promise.all(
    Array.from({ length: TOTAL_SEGMENTS }, (_, seg) =>
      processSegment(ctx, Widgets, seg, cp, lock),
    ),
  );

  const total = cp.processedPerSegment.reduce((a, b) => a + b, 0);
  ctx.logger.info(`Migration complete. Processed ${total} items.`);
}

async function processSegment(
  ctx: MigrationContext,
  table: string,
  segment: number,
  cp: Checkpoint,
  lock: AsyncLock,
): Promise<void> {
  // null = segment was finished on a prior run.
  if (cp.cursors[segment] === null) return;
  let cursor = cp.cursors[segment];

  do {
    const page = await ctx.ddb.send(
      new ScanCommand({
        TableName: table,
        Segment: segment,
        TotalSegments: TOTAL_SEGMENTS,
        ExclusiveStartKey: cursor ?? undefined,
        FilterExpression:
          'attribute_not_exists(schemaVersion) OR schemaVersion < :v',
        ExpressionAttributeValues: { ':v': TARGET_VERSION },
      }),
    );

    for (const item of page.Items ?? []) {
      if (ctx.dryRun) continue;
      await ctx.ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: 'SET schemaVersion = :v, normalizedName = :n',
          ConditionExpression:
            'attribute_not_exists(schemaVersion) OR schemaVersion < :v',
          ExpressionAttributeValues: {
            ':v': TARGET_VERSION,
            ':n': normalize(item.name),
          },
        }),
      );
      cp.processedPerSegment[segment] += 1;
    }

    cursor = page.LastEvaluatedKey ?? null;
    cp.cursors[segment] = cursor;
    await lock.run(() => ctx.checkpoint(cp));
  } while (cursor !== null);
}

function freshCheckpoint(): Checkpoint {
  return {
    cursors: Array.from({ length: TOTAL_SEGMENTS }, () => undefined),
    processedPerSegment: Array.from({ length: TOTAL_SEGMENTS }, () => 0),
  };
}

function normalize(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

class AsyncLock {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export async function down(_ctx: MigrationContext): Promise<void> {
  // We can't reliably revert `normalizedName`. Roll forward instead.
  throw new Error('not reversible');
}
