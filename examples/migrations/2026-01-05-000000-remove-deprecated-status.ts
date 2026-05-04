/**
 * Remove the legacy `status` attribute from Order items.
 *
 * Pattern: phase 3 of expand-and-contract.
 *
 * Preconditions before running this:
 *  - All app code reads `state` and never reads or writes `status`.
 *  - The phase-2 migration (2026-01-02-000000-rename-status-to-state.ts)
 *    has been applied to every environment.
 *
 * Once `status` is gone, there is no way to recover it without an
 * external backup. Run this only after the no-status app code has been
 * deployed everywhere and you've watched it for at least one full
 * release cycle.
 */
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MigrationContext } from 'ddb-migrations';

export const description = 'Remove legacy `status` from Orders';

export async function up(ctx: MigrationContext): Promise<void> {
  const Orders = ctx.tableName('orders');
  let cursor: Record<string, unknown> | undefined;
  let processed = 0;

  do {
    const page = await ctx.ddb.send(
      new ScanCommand({
        TableName: Orders,
        ExclusiveStartKey: cursor,
        FilterExpression: 'attribute_exists(#s)',
        ExpressionAttributeNames: { '#s': 'status' },
      }),
    );

    for (const item of page.Items ?? []) {
      if (ctx.dryRun) continue;
      await ctx.ddb.send(
        new UpdateCommand({
          TableName: Orders,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: 'REMOVE #s',
          ExpressionAttributeNames: { '#s': 'status' },
        }),
      );
      processed += 1;
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  ctx.logger.info(`Removed legacy status from ${processed} items.`);
}

export async function down(_ctx: MigrationContext): Promise<void> {
  // Cleanup migrations are not safely reversible — there's no source of
  // truth for the deleted attribute. Restore from a backup instead.
  throw new Error('cleanup is not reversible');
}
