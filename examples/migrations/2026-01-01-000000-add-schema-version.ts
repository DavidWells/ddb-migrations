/**
 * Add `schemaVersion = 1` to every existing item that doesn't have it.
 *
 * Pattern: idempotent additive backfill.
 *  - The FilterExpression skips items already at v1, so re-runs cost a
 *    Scan but no writes.
 *  - The ConditionExpression on the UpdateCommand prevents clobbering
 *    an item that the app code wrote with schemaVersion in the meantime.
 *
 * This is the cheapest migration shape: no coordination with app code
 * required. New items get schemaVersion at write time; old items get it
 * here.
 */
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MigrationContext } from 'ddb-migration-tools';

export const description = 'Backfill schemaVersion=1 on User items';

export async function up(ctx: MigrationContext): Promise<void> {
  const Users = ctx.tableName('users');
  let cursor: Record<string, unknown> | undefined;
  let processed = 0;

  do {
    const page = await ctx.ddb.send(
      new ScanCommand({
        TableName: Users,
        ExclusiveStartKey: cursor,
        FilterExpression: 'attribute_not_exists(schemaVersion)',
      }),
    );

    for (const item of page.Items ?? []) {
      if (ctx.dryRun) continue;
      await ctx.ddb.send(
        new UpdateCommand({
          TableName: Users,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: 'SET schemaVersion = :v',
          ConditionExpression: 'attribute_not_exists(schemaVersion)',
          ExpressionAttributeValues: { ':v': 1 },
        }),
      );
      processed += 1;
    }

    cursor = page.LastEvaluatedKey;
    await ctx.checkpoint({ lastKey: cursor ?? null, processed });
  } while (cursor);

  ctx.logger.info(`Updated ${processed} items.`);
}

export async function down(ctx: MigrationContext): Promise<void> {
  const Users = ctx.tableName('users');
  let cursor: Record<string, unknown> | undefined;

  do {
    const page = await ctx.ddb.send(
      new ScanCommand({
        TableName: Users,
        ExclusiveStartKey: cursor,
        FilterExpression: 'schemaVersion = :v',
        ExpressionAttributeValues: { ':v': 1 },
      }),
    );
    for (const item of page.Items ?? []) {
      if (ctx.dryRun) continue;
      await ctx.ddb.send(
        new UpdateCommand({
          TableName: Users,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: 'REMOVE schemaVersion',
        }),
      );
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
}
