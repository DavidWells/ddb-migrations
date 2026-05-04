import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { LedgerEntry } from './types.js';

export class Ledger {
  constructor(
    private readonly raw: DynamoDBClient,
    private readonly doc: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}

  async ensureExists(): Promise<void> {
    try {
      await this.raw.send(new DescribeTableCommand({ TableName: this.tableName }));
      return;
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
    await this.raw.send(
      new CreateTableCommand({
        TableName: this.tableName,
        AttributeDefinitions: [{ AttributeName: 'migrationId', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'migrationId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await waitUntilTableExists(
      { client: this.raw, maxWaitTime: 60 },
      { TableName: this.tableName },
    );
  }

  async listAll(): Promise<LedgerEntry[]> {
    const items: LedgerEntry[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const resp = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          ExclusiveStartKey: cursor,
        }),
      );
      if (resp.Items) items.push(...(resp.Items as LedgerEntry[]));
      cursor = resp.LastEvaluatedKey;
    } while (cursor);
    return items.sort((a, b) => a.migrationId.localeCompare(b.migrationId));
  }

  async get(migrationId: string): Promise<LedgerEntry | undefined> {
    const resp = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { migrationId } }),
    );
    return resp.Item as LedgerEntry | undefined;
  }

  async markStart(entry: {
    migrationId: string;
    checksum: string;
    appliedBy?: string;
  }): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          migrationId: entry.migrationId,
          checksum: entry.checksum,
          appliedAt: new Date().toISOString(),
          status: 'in_progress' satisfies LedgerEntry['status'],
          appliedBy: entry.appliedBy,
        },
        // Allow overwrite if previous run was failed/in_progress; refuse if already completed.
        ConditionExpression: 'attribute_not_exists(migrationId) OR #status <> :completed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':completed': 'completed' },
      }),
    );
  }

  async markComplete(
    migrationId: string,
    durationMs: number,
    itemsProcessed?: number,
  ): Promise<void> {
    const itemsClause = itemsProcessed === undefined ? '' : ', itemsProcessed = :i';
    const values: Record<string, unknown> = { ':s': 'completed', ':d': durationMs };
    if (itemsProcessed !== undefined) values[':i'] = itemsProcessed;
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { migrationId },
        UpdateExpression: `SET #status = :s, durationMs = :d${itemsClause} REMOVE errorMessage`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
      }),
    );
  }

  async markFailed(migrationId: string, errorMessage: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { migrationId },
        UpdateExpression: 'SET #status = :s, errorMessage = :e',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':s': 'failed', ':e': errorMessage },
      }),
    );
  }

  async remove(migrationId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { migrationId } }),
    );
  }

  async setCheckpoint(migrationId: string, value: Record<string, unknown>): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { migrationId },
        UpdateExpression: 'SET checkpoint = :v',
        ExpressionAttributeValues: { ':v': value },
      }),
    );
  }

  async getCheckpoint<T extends Record<string, unknown> = Record<string, unknown>>(
    migrationId: string,
  ): Promise<T | undefined> {
    const entry = await this.get(migrationId);
    return entry?.checkpoint as T | undefined;
  }
}
