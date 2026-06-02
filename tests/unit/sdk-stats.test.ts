import { describe, expect, it } from 'vitest';
import {
  capacityUnits,
  classifyDdbCommand,
  countItems,
  createDdbSdkStats,
  wrapCountingDdbClient,
} from '../../src/lib/sdk-stats.js';

class QueryCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown> = {}) {
    this.input = input;
  }
}

class DeleteCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown> = {}) {
    this.input = input;
  }
}

class DescribeTableCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown> = {}) {
    this.input = input;
  }
}

class MadeUpCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown> = {}) {
    this.input = input;
  }
}

class FakeClient {
  config = { region: 'us-east-1' };
  responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = [...responses];
  }

  async send(_command: unknown): Promise<unknown> {
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? {};
  }
}

describe('DynamoDB SDK stats', () => {
  it('classifies read, write, control, and unknown commands', () => {
    expect(classifyDdbCommand('QueryCommand')).toBe('read');
    expect(classifyDdbCommand('DeleteCommand')).toBe('write');
    expect(classifyDdbCommand('DescribeTableCommand')).toBe('control');
    expect(classifyDdbCommand('SomethingElseCommand')).toBe('unknown');
  });

  it('counts result item shapes and capacity units', () => {
    expect(countItems({ Items: [{}, {}] })).toBe(2);
    expect(countItems({ Item: {} })).toBe(1);
    expect(countItems({ Responses: { a: [{}, {}], b: [{}] } })).toBe(3);
    expect(capacityUnits({ CapacityUnits: 1.5 })).toBe(1.5);
    expect(capacityUnits([{ ReadCapacityUnits: 2 }, { WriteCapacityUnits: 3 }])).toBe(5);
  });

  it('wraps send calls and records aggregate stats', async () => {
    const stats = createDdbSdkStats();
    const client = wrapCountingDdbClient(new FakeClient([
      { Items: [{ id: 1 }], LastEvaluatedKey: { pk: 'a' } },
      {},
      {},
      {},
    ]), {
      stats,
      source: 'app',
    });

    expect(client.config.region).toBe('us-east-1');
    await client.send(new QueryCommand());
    await client.send(new DeleteCommand());
    await client.send(new DescribeTableCommand());
    await client.send(new MadeUpCommand());

    const snapshot = stats.snapshot();
    expect(snapshot.calls).toBe(4);
    expect(snapshot.reads).toBe(1);
    expect(snapshot.writes).toBe(1);
    expect(snapshot.controls).toBe(1);
    expect(snapshot.unknown).toBe(1);
    expect(snapshot.pages).toBe(4);
    expect(snapshot.itemsReturned).toBe(1);
    expect(snapshot.lastEvaluatedKeyCount).toBe(1);
    expect(snapshot.bySource.app.calls).toBe(4);
    expect(snapshot.commands.QueryCommand.attempted).toBe(1);
    expect(snapshot.commands.DeleteCommand.succeeded).toBe(1);
  });

  it('injects ReturnConsumedCapacity only when enabled and absent', async () => {
    const stats = createDdbSdkStats();
    const client = wrapCountingDdbClient(new FakeClient([
      { ConsumedCapacity: { CapacityUnits: 2 } },
      { ConsumedCapacity: { CapacityUnits: 3 } },
      {},
    ]), {
      stats,
      source: 'app',
      captureConsumedCapacity: true,
    });
    const query = new QueryCommand();
    const deleteCommand = new DeleteCommand({ ReturnConsumedCapacity: 'INDEXES' });
    const describe = new DescribeTableCommand();

    await client.send(query);
    await client.send(deleteCommand);
    await client.send(describe);

    expect(query.input.ReturnConsumedCapacity).toBe('TOTAL');
    expect(deleteCommand.input.ReturnConsumedCapacity).toBe('INDEXES');
    expect(describe.input.ReturnConsumedCapacity).toBeUndefined();
    expect(stats.snapshot().consumedCapacity).toBe(5);
  });

  it('records failures and throttles without swallowing the original error', async () => {
    const stats = createDdbSdkStats();
    const error = new Error('slow down');
    error.name = 'ProvisionedThroughputExceededException';
    const client = wrapCountingDdbClient(new FakeClient([error]), { stats, source: 'app' });

    await expect(client.send(new QueryCommand())).rejects.toBe(error);

    const snapshot = stats.snapshot();
    expect(snapshot.calls).toBe(1);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.throttles).toBe(1);
    expect(snapshot.errorsByName.ProvisionedThroughputExceededException).toBe(1);
    expect(snapshot.commands.QueryCommand.failed).toBe(1);
  });

  it('snapshots are copies and reset clears state', async () => {
    const stats = createDdbSdkStats();
    const client = wrapCountingDdbClient(new FakeClient([{}]), { stats, source: 'app' });
    await client.send(new QueryCommand());

    const snapshot = stats.snapshot();
    snapshot.calls = 999;
    snapshot.commands.QueryCommand.attempted = 999;
    expect(stats.snapshot().calls).toBe(1);
    expect(stats.snapshot().commands.QueryCommand.attempted).toBe(1);

    stats.reset();
    expect(stats.snapshot().calls).toBe(0);
    expect(stats.snapshot().commands.QueryCommand).toBeUndefined();
  });
});
