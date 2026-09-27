import {
  ConditionalCheckFailedException,
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
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { Clients } from './ddb.js';
import { LedgerConflictError, LedgerMissingError, isConditionalCheckFailed } from './errors.js';
import type { LedgerEntry, ResolvedStage } from './types.js';

export type LedgerOptions = {
  tableName: string;
  scope: string;
  stage: string;
  accountId?: string;
  region?: string;
  /** Create the table when missing. Defaults to true; false throws LedgerMissingError instead. */
  create?: boolean;
};

export class Ledger {
  private readonly pk: string;
  /** Run token per migration this instance started; later writes are conditioned on it. */
  private readonly runTokens = new Map<string, string>();

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
    if (this.options.create === false) throw new LedgerMissingError(this.tableName);
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
    const setClauses = [
      '#scope = :scope',
      '#stage = :stage',
      'migrationId = :migrationId',
      'checksum = :checksum',
      'appliedAt = :appliedAt',
      '#status = :status',
      'runToken = :runToken',
    ];
    const removeClauses = ['errorMessage', 'interruptedAt', 'durationMs', 'itemsProcessed'];
    const runToken = randomUUID();
    const values: Record<string, unknown> = {
      ':runToken': runToken,
      ':scope': this.options.scope,
      ':stage': this.options.stage,
      ':migrationId': entry.migrationId,
      ':checksum': entry.checksum,
      ':appliedAt': new Date().toISOString(),
      ':status': 'in_progress' satisfies LedgerEntry['status'],
      ':completed': 'completed' satisfies LedgerEntry['status'],
    };

    if (entry.appliedBy !== undefined) {
      setClauses.push('appliedBy = :appliedBy');
      values[':appliedBy'] = entry.appliedBy;
    } else {
      removeClauses.push('appliedBy');
    }
    if (this.options.accountId !== undefined) {
      setClauses.push('accountId = :accountId');
      values[':accountId'] = this.options.accountId;
    } else {
      removeClauses.push('accountId');
    }
    if (this.options.region !== undefined) {
      setClauses.push('#region = :region');
      values[':region'] = this.options.region;
    } else {
      removeClauses.push('#region');
    }

    await this.conditionalWrite(entry.migrationId, 'markStart', () =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(entry.migrationId),
          UpdateExpression: `SET ${setClauses.join(', ')} REMOVE ${removeClauses.join(', ')}`,
          // Allow overwrite if previous run was failed/in_progress; refuse if already completed.
          ConditionExpression:
            '(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR #status <> :completed',
          ExpressionAttributeNames: {
            '#scope': 'scope',
            '#stage': 'stage',
            '#status': 'status',
            '#region': 'region',
          },
          ExpressionAttributeValues: values,
        }),
      ),
    );
    this.runTokens.set(entry.migrationId, runToken);
  }

  async markComplete(
    migrationId: string,
    durationMs: number,
    itemsProcessed?: number,
  ): Promise<void> {
    const itemsClause = itemsProcessed === undefined ? '' : ', itemsProcessed = :i';
    const values: Record<string, unknown> = { ':s': 'completed', ':d': durationMs };
    if (itemsProcessed !== undefined) values[':i'] = itemsProcessed;
    await this.conditionalWrite(migrationId, 'markComplete', () =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(migrationId),
          UpdateExpression: `SET #status = :s, durationMs = :d${itemsClause} REMOVE errorMessage, interruptedAt`,
          ...this.runCondition(migrationId, { '#status': 'status' }, values),
        }),
      ),
    );
  }

  async markFailed(migrationId: string, errorMessage: string): Promise<void> {
    await this.conditionalWrite(migrationId, 'markFailed', () =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(migrationId),
          UpdateExpression: 'SET #status = :s, errorMessage = :e REMOVE interruptedAt',
          ...this.runCondition(
            migrationId,
            { '#status': 'status' },
            { ':s': 'failed', ':e': errorMessage },
          ),
        }),
      ),
    );
  }

  async markInterrupted(migrationId: string, message: string): Promise<boolean> {
    const runToken = this.runTokens.get(migrationId);
    const values: Record<string, unknown> = {
      ':s': 'interrupted' satisfies LedgerEntry['status'],
      ':e': message,
      ':t': new Date().toISOString(),
      ':completed': 'completed' satisfies LedgerEntry['status'],
    };
    if (runToken !== undefined) values[':runToken'] = runToken;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(migrationId),
          UpdateExpression: 'SET #status = :s, errorMessage = :e, interruptedAt = :t',
          ConditionExpression:
            'attribute_exists(pk) AND attribute_exists(sk) AND #status <> :completed' +
            (runToken !== undefined ? ' AND runToken = :runToken' : ''),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || isConditionalCheckFailed(err)) {
        return false;
      }
      throw err;
    }
  }

  async remove(migrationId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: this.key(migrationId) }),
    );
  }

  async setCheckpoint(migrationId: string, value: Record<string, unknown>): Promise<void> {
    await this.conditionalWrite(migrationId, 'setCheckpoint', () =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(migrationId),
          UpdateExpression: 'SET checkpoint = :v',
          ...this.runCondition(migrationId, {}, { ':v': value }),
        }),
      ),
    );
  }

  async clearCheckpoint(migrationId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(migrationId),
        UpdateExpression: 'REMOVE checkpoint',
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

  /**
   * For a migration this instance started: condition the write on its run token and on the row
   * not being completed. Otherwise the write is unconditioned.
   */
  private runCondition(
    migrationId: string,
    names: Record<string, string>,
    values: Record<string, unknown>,
  ): {
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  } {
    const runToken = this.runTokens.get(migrationId);
    if (runToken === undefined) {
      return {
        ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
      };
    }
    return {
      ConditionExpression: 'runToken = :runToken AND #status <> :completed',
      ExpressionAttributeNames: { ...names, '#status': 'status' },
      ExpressionAttributeValues: {
        ...values,
        ':runToken': runToken,
        ':completed': 'completed' satisfies LedgerEntry['status'],
      },
    };
  }

  /** Runs a conditioned write, turning a failed condition into LedgerConflictError. */
  private async conditionalWrite(
    migrationId: string,
    operation: string,
    write: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await write();
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || isConditionalCheckFailed(err)) {
        throw new LedgerConflictError(migrationId, operation, { cause: err });
      }
      throw err;
    }
  }
}

/** The ledger for a resolved stage, on the ledger client pair. */
export function stageLedger(
  sc: ResolvedStage,
  clients: Pick<Clients, 'ledgerRaw' | 'ledgerDoc'>,
): Ledger {
  return new Ledger(clients.ledgerRaw, clients.ledgerDoc, {
    tableName: sc.ledgerTable,
    scope: sc.ledgerScope,
    stage: sc.stage,
    accountId: sc.accountId,
    region: sc.region,
    create: sc.ledgerCreate,
  });
}

export function ledgerPk(scope: string, stage: string): string {
  return `SCOPE#${scope}#STAGE#${stage}`;
}

export function ledgerSk(migrationId: string): string {
  return `MIGRATION#${migrationId}`;
}
