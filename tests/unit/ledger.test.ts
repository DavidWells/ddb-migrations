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

  it('conditions writes after markStart on the run token it set', async () => {
    const sent: UpdateCommand[] = [];
    const ledger = new Ledger(
      {} as DynamoDBClient,
      { send: async (command: UpdateCommand) => sent.push(command) } as unknown as DynamoDBDocumentClient,
      { tableName: 'migration-ledger', scope: 'app', stage: 'dev' },
    );

    await ledger.markStart({ migrationId: '2026-01-01_demo', checksum: 'abc123' });
    await ledger.setCheckpoint('2026-01-01_demo', { page: 1 });
    await ledger.markComplete('2026-01-01_demo', 10);
    await ledger.markFailed('2026-01-01_demo', 'boom');
    await ledger.markInterrupted('2026-01-01_demo', 'received SIGINT');

    const [start, ...writes] = sent.map((command) => command.input);
    expect(start?.UpdateExpression).toContain('runToken = :runToken');
    const token = start?.ExpressionAttributeValues?.[':runToken'];
    expect(typeof token).toBe('string');
    expect(writes).toHaveLength(4);
    for (const input of writes) {
      expect(input.ConditionExpression).toContain('runToken = :runToken');
      expect(input.ConditionExpression).toContain('#status <> :completed');
      expect(input.ExpressionAttributeValues?.[':runToken']).toBe(token);
    }
  });

  it('leaves writes unconditioned on a run token when this instance did not start the row', async () => {
    const sent: UpdateCommand[] = [];
    const ledger = new Ledger(
      {} as DynamoDBClient,
      { send: async (command: UpdateCommand) => sent.push(command) } as unknown as DynamoDBDocumentClient,
      { tableName: 'migration-ledger', scope: 'app', stage: 'dev' },
    );

    await ledger.markInterrupted('2026-01-01_demo', 'forced shutdown');

    expect(sent[0]?.input.ConditionExpression).not.toContain('runToken');
  });
});

