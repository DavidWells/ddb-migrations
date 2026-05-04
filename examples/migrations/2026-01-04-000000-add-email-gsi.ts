/**
 * Add a Global Secondary Index to the Users table.
 *
 * Pattern: table-level operation. No item iteration needed — DynamoDB
 * backfills the GSI server-side. This migration completes only when
 * the GSI status flips from CREATING to ACTIVE.
 *
 * Caveats:
 *  - GSI creation can take minutes to hours on large tables.
 *  - On provisioned-capacity tables, backfill consumes WCU on the GSI
 *    and read capacity on the base table. Don't run during peak hours.
 *  - You can only have one GSI in CREATING state at a time per table.
 */
import {
  DescribeTableCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';
import type { MigrationContext } from 'ddb-migrations';

export const description = 'Add email-lookup GSI to Users';

const GSI_NAME = 'email-index';
const GSI_TIMEOUT_MS = 60 * 60 * 1000; // 1h cap
const POLL_INTERVAL_MS = 10_000;

export async function up(ctx: MigrationContext): Promise<void> {
  const TableName = ctx.tableName('users');

  if (ctx.dryRun) {
    ctx.logger.info(`Would add GSI '${GSI_NAME}' to ${TableName}`);
    return;
  }

  await ctx.ddbRaw.send(
    new UpdateTableCommand({
      TableName,
      AttributeDefinitions: [{ AttributeName: 'email', AttributeType: 'S' }],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: GSI_NAME,
            KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        },
      ],
    }),
  );

  ctx.logger.info(`GSI ${GSI_NAME} requested. Waiting for ACTIVE...`);
  await waitForGsiActive(ctx, TableName, GSI_NAME);
  ctx.logger.info(`GSI ${GSI_NAME} is ACTIVE.`);
}

async function waitForGsiActive(
  ctx: MigrationContext,
  table: string,
  index: string,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const resp = await ctx.ddbRaw.send(new DescribeTableCommand({ TableName: table }));
    const gsi = resp.Table?.GlobalSecondaryIndexes?.find((g) => g.IndexName === index);
    const s = gsi?.IndexStatus;
    if (s === 'ACTIVE') return;
    if (Date.now() - start > GSI_TIMEOUT_MS) {
      throw new Error(`GSI ${index} did not become ACTIVE within ${GSI_TIMEOUT_MS}ms (status: ${s})`);
    }
    ctx.logger.info(`GSI ${index} status: ${s}; waiting ${POLL_INTERVAL_MS / 1000}s`);
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function down(ctx: MigrationContext): Promise<void> {
  const TableName = ctx.tableName('users');
  if (ctx.dryRun) {
    ctx.logger.info(`Would delete GSI '${GSI_NAME}' from ${TableName}`);
    return;
  }
  await ctx.ddbRaw.send(
    new UpdateTableCommand({
      TableName,
      GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: GSI_NAME } }],
    }),
  );
  ctx.logger.info(`Requested deletion of GSI ${GSI_NAME}.`);
}
