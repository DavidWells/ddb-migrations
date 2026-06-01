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
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { LedgerEntry } from './types.js';

export type LedgerOptions = {
  tableName: string;
  scope: string;
  stage: string;
  accountId?: string;
  region?: string;
};

export class Ledger {
  private readonly pk: string;

  constructor(
    private readonly raw: DynamoDBClient,
    private readonly doc: DynamoDBDocumentClient,
    private readonly options: LedgerOptions,
  ) {
    this.pk = ledgerPk(options.scope, options.stage);
  }

  get tableName(): string {
    return this.options.tableName;
  }

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
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
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
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': this.pk },
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
      new GetCommand({ TableName: this.tableName, Key: this.key(migrationId) }),
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
          pk: this.pk,
          sk: ledgerSk(entry.migrationId),
          scope: this.options.scope,
          stage: this.options.stage,
          migrationId: entry.migrationId,
          checksum: entry.checksum,
          appliedAt: new Date().toISOString(),
          status: 'in_progress' satisfies LedgerEntry['status'],
          appliedBy: entry.appliedBy,
          accountId: this.options.accountId,
          region: this.options.region,
        },
        // Allow overwrite if previous run was failed/in_progress; refuse if already completed.
        ConditionExpression:
          '(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR #status <> :completed',
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
        Key: this.key(migrationId),
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
        Key: this.key(migrationId),
        UpdateExpression: 'SET #status = :s, errorMessage = :e',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':s': 'failed', ':e': errorMessage },
      }),
    );
  }

  async remove(migrationId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: this.key(migrationId) }),
    );
  }

  async setCheckpoint(migrationId: string, value: Record<string, unknown>): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(migrationId),
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

  private key(migrationId: string): { pk: string; sk: string } {
    return { pk: this.pk, sk: ledgerSk(migrationId) };
  }
}

export function ledgerPk(scope: string, stage: string): string {
  return `SCOPE#${scope}#STAGE#${stage}`;
}

export function ledgerSk(migrationId: string): string {
  return `MIGRATION#${migrationId}`;
}
