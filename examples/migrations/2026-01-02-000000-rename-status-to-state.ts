/**
 * Rename the `status` attribute to `state` on Order items.
 *
 * Pattern: phase 2 of expand-and-contract.
 *
 * Deploy sequence:
 *   Phase 1 (NOT this migration): app code writes BOTH `status` and
 *           `state`, reads from either preferring `state`. Deploy first.
 *   Phase 2 (THIS migration):    backfill `state` from `status` for any
 *           item that has `status` but not `state`.
 *   Phase 3 (later migration):   remove `status` once app code only
 *           writes `state`. See 2026-01-05-000000-remove-deprecated-status.ts.
 *
 * The ConditionExpression below protects against a race where the app
 * already wrote `state` between our Scan and our Update.
 */
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MigrationContext } from 'ddb-migration-tools';

export const description = 'Backfill `state` from `status` on Orders';

export async function up(ctx: MigrationContext): Promise<void> {
  const Orders = ctx.tableName('orders');
  let cursor: Record<string, unknown> | undefined;

  do {
    const page = await ctx.ddb.send(
      new ScanCommand({
        TableName: Orders,
        ExclusiveStartKey: cursor,
        FilterExpression:
          'attribute_exists(#status) AND attribute_not_exists(#state)',
        ExpressionAttributeNames: { '#status': 'status', '#state': 'state' },
      }),
    );

    for (const item of page.Items ?? []) {
      if (ctx.dryRun) continue;
      await ctx.ddb.send(
        new UpdateCommand({
          TableName: Orders,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: 'SET #state = :v',
          ConditionExpression: 'attribute_not_exists(#state)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':v': item.status },
        }),
      );
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
}

export async function down(_ctx: MigrationContext): Promise<void> {
  // Not auto-reversible. By the time this has run, app code is reading
  // `state`, and the two attributes can have diverged. Roll forward
  // with a new migration if you need to undo.
  throw new Error('rename migrations are not auto-reversible');
}
