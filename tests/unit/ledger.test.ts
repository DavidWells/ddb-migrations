import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../../src/lib/ledger.js';

describe('Ledger', () => {
  it('marks a migration start without replacing an existing checkpoint', async () => {
    const sent: unknown[] = [];
    const ledger = new Ledger(
      {} as DynamoDBClient,
      { send: async (command: unknown) => sent.push(command) } as DynamoDBDocumentClient,
      {
        tableName: 'migration-ledger',
        scope: 'app',
        stage: 'dev',
        accountId: '123456789012',
        region: 'us-east-1',
      },
    );

    await ledger.markStart({
      migrationId: '2026-01-01_demo',
      checksum: 'abc123',
      appliedBy: 'tester@host',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateCommand);
    expect(sent[0]).not.toBeInstanceOf(PutCommand);

    const input = (sent[0] as UpdateCommand).input;
    expect(input.UpdateExpression).toContain('SET ');
    expect(input.UpdateExpression).not.toContain('checkpoint');
    expect(input.ConditionExpression).toContain('#status <> :completed');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':checksum': 'abc123',
      ':completed': 'completed',
      ':status': 'in_progress',
    });
  });

  it('marks a migration interrupted without replacing checkpoint data', async () => {
    const sent: unknown[] = [];
    const ledger = new Ledger(
      {} as DynamoDBClient,
      { send: async (command: unknown) => sent.push(command) } as DynamoDBDocumentClient,
      {
        tableName: 'migration-ledger',
        scope: 'app',
        stage: 'dev',
      },
    );

    await ledger.markInterrupted('2026-01-01_demo', 'received SIGINT');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateCommand);

    const input = (sent[0] as UpdateCommand).input;
    expect(input.UpdateExpression).toContain('#status = :s');
    expect(input.UpdateExpression).not.toContain('checkpoint');
    expect(input.ConditionExpression).toContain('#status <> :completed');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':s': 'interrupted',
      ':e': 'received SIGINT',
      ':completed': 'completed',
    });
    expect(input.ExpressionAttributeValues).toHaveProperty(':t');
  });
});
