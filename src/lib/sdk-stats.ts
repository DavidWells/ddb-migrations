export type DdbCommandClass = 'read' | 'write' | 'control' | 'unknown';

export type DdbClientSource = 'app' | 'appRaw' | 'ledger' | 'ledgerRaw';

export type DdbCommandStats = {
  attempted: number;
  succeeded: number;
  failed: number;
};

export type DdbSdkSourceStats = {
  calls: number;
  reads: number;
  writes: number;
  controls: number;
  unknown: number;
  succeeded: number;
  failed: number;
  pages: number;
  itemsReturned: number;
  consumedCapacity: number;
  lastEvaluatedKeyCount: number;
};

export type DdbSdkStatsSnapshot = DdbSdkSourceStats & {
  commands: Record<string, DdbCommandStats>;
  bySource: Record<string, DdbSdkSourceStats>;
  throttles: number;
  errorsByName: Record<string, number>;
};

export type DdbSdkStats = {
  snapshot(): DdbSdkStatsSnapshot;
  reset(): void;
};

export type DdbSdkStatsController = DdbSdkStats & {
  recordSend<TOutput>(
    source: DdbClientSource,
    command: unknown,
    send: () => Promise<TOutput>,
    options?: { captureConsumedCapacity?: boolean },
  ): Promise<TOutput>;
};

const READ_COMMANDS = new Set([
  'GetCommand',
  'QueryCommand',
  'ScanCommand',
  'BatchGetCommand',
  'GetItemCommand',
  'BatchGetItemCommand',
]);

const WRITE_COMMANDS = new Set([
  'PutCommand',
  'UpdateCommand',
  'DeleteCommand',
  'BatchWriteCommand',
  'TransactWriteCommand',
  'PutItemCommand',
  'UpdateItemCommand',
  'DeleteItemCommand',
  'BatchWriteItemCommand',
  'TransactWriteItemsCommand',
]);

const CONTROL_COMMANDS = new Set([
  'CreateTableCommand',
  'DeleteTableCommand',
  'DescribeTableCommand',
  'ListTablesCommand',
  'UpdateTableCommand',
  'DescribeTimeToLiveCommand',
  'UpdateTimeToLiveCommand',
]);

const CONSUMED_CAPACITY_COMMANDS = new Set([
  ...READ_COMMANDS,
  ...WRITE_COMMANDS,
]);

const THROTTLE_ERROR_NAMES = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'ThrottlingError',
  'RequestLimitExceeded',
  'RequestThrottledException',
  'TooManyRequestsException',
]);

type SendFunction = (command: unknown) => Promise<unknown>;

function emptySourceStats(): DdbSdkSourceStats {
  return {
    calls: 0,
    reads: 0,
    writes: 0,
    controls: 0,
    unknown: 0,
    succeeded: 0,
    failed: 0,
    pages: 0,
    itemsReturned: 0,
    consumedCapacity: 0,
    lastEvaluatedKeyCount: 0,
  };
}

function emptySnapshot(): DdbSdkStatsSnapshot {
  return {
    ...emptySourceStats(),
    commands: {},
    bySource: {},
    throttles: 0,
    errorsByName: {},
  };
}

export function createDdbSdkStats(): DdbSdkStatsController {
  let stats = emptySnapshot();

  return {
    snapshot() {
      return cloneStats(stats);
    },
    reset() {
      stats = emptySnapshot();
    },
    async recordSend(source, command, send, options = {}) {
      const name = commandName(command);
      const classification = classifyDdbCommand(name);
      const commandStats = getCommandStats(stats, name);
      const sourceStats = getSourceStats(stats, source);

      stats.calls += 1;
      sourceStats.calls += 1;
      commandStats.attempted += 1;
      incrementClass(stats, classification);
      incrementClass(sourceStats, classification);

      if (options.captureConsumedCapacity === true) {
        injectConsumedCapacity(command, name);
      }

      try {
        const result = await send();
        commandStats.succeeded += 1;
        stats.succeeded += 1;
        sourceStats.succeeded += 1;
        stats.pages += 1;
        sourceStats.pages += 1;

        const items = countItems(result);
        stats.itemsReturned += items;
        sourceStats.itemsReturned += items;

        const capacity = capacityUnits(consumedCapacity(result));
        stats.consumedCapacity += capacity;
        sourceStats.consumedCapacity += capacity;

        if (hasLastEvaluatedKey(result)) {
          stats.lastEvaluatedKeyCount += 1;
          sourceStats.lastEvaluatedKeyCount += 1;
        }

        return result;
      } catch (error) {
        commandStats.failed += 1;
        stats.failed += 1;
        sourceStats.failed += 1;
        const name = errorName(error);
        stats.errorsByName[name] = (stats.errorsByName[name] ?? 0) + 1;
        if (THROTTLE_ERROR_NAMES.has(name)) stats.throttles += 1;
        throw error;
      }
    },
  };
}

export function wrapCountingDdbClient<TClient extends object>(
  client: TClient,
  options: {
    stats: DdbSdkStatsController;
    source: DdbClientSource;
    captureConsumedCapacity?: boolean;
  },
): TClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'send') return Reflect.get(target, prop, receiver);
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      const send = original.bind(target) as SendFunction;
      return (command: unknown) =>
        options.stats.recordSend(
          options.source,
          command,
          () => send(command),
          { captureConsumedCapacity: options.captureConsumedCapacity },
        );
    },
  });
}

export function classifyDdbCommand(name: string): DdbCommandClass {
  if (READ_COMMANDS.has(name)) return 'read';
  if (WRITE_COMMANDS.has(name)) return 'write';
  if (CONTROL_COMMANDS.has(name)) return 'control';
  return 'unknown';
}

export function capacityUnits(capacity: unknown): number {
  if (Array.isArray(capacity)) {
    return capacity.reduce((sum, item) => sum + capacityUnits(item), 0);
  }
  if (!isRecord(capacity)) return 0;
  const capacityUnitsValue = numberValue(capacity.CapacityUnits);
  if (capacityUnitsValue !== undefined) return capacityUnitsValue;
  return (numberValue(capacity.ReadCapacityUnits) ?? 0) + (numberValue(capacity.WriteCapacityUnits) ?? 0);
}

export function countItems(result: unknown): number {
  if (!isRecord(result)) return 0;
  if (Array.isArray(result.Items)) return result.Items.length;
  if (Array.isArray(result.Responses)) return result.Responses.length;
  if (isRecord(result.Responses)) {
    return Object.values(result.Responses).reduce<number>(
      (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
      0,
    );
  }
  return result.Item !== undefined ? 1 : 0;
}

function commandName(command: unknown): string {
  if (!isRecord(command)) return 'UnknownCommand';
  const ctor = command.constructor;
  if (typeof ctor !== 'function') return 'UnknownCommand';
  return typeof ctor.name === 'string' && ctor.name.length > 0 ? ctor.name : 'UnknownCommand';
}

function injectConsumedCapacity(command: unknown, name: string): void {
  if (!CONSUMED_CAPACITY_COMMANDS.has(name)) return;
  if (!isRecord(command) || !isRecord(command.input)) return;
  if (command.input.ReturnConsumedCapacity !== undefined) return;
  command.input.ReturnConsumedCapacity = 'TOTAL';
}

function consumedCapacity(result: unknown): unknown {
  return isRecord(result) ? result.ConsumedCapacity : undefined;
}

function hasLastEvaluatedKey(result: unknown): boolean {
  return isRecord(result) && result.LastEvaluatedKey !== undefined;
}

function errorName(error: unknown): string {
  if (isRecord(error) && typeof error.name === 'string' && error.name.length > 0) return error.name;
  return 'Error';
}

function getCommandStats(stats: DdbSdkStatsSnapshot, name: string): DdbCommandStats {
  stats.commands[name] ??= { attempted: 0, succeeded: 0, failed: 0 };
  return stats.commands[name];
}

function getSourceStats(stats: DdbSdkStatsSnapshot, source: DdbClientSource): DdbSdkSourceStats {
  stats.bySource[source] ??= emptySourceStats();
  return stats.bySource[source];
}

function incrementClass(stats: DdbSdkSourceStats, classification: DdbCommandClass): void {
  if (classification === 'read') stats.reads += 1;
  else if (classification === 'write') stats.writes += 1;
  else if (classification === 'control') stats.controls += 1;
  else stats.unknown += 1;
}

function cloneStats(stats: DdbSdkStatsSnapshot): DdbSdkStatsSnapshot {
  return {
    ...stats,
    commands: Object.fromEntries(
      Object.entries(stats.commands).map(([name, value]) => [name, { ...value }]),
    ),
    bySource: Object.fromEntries(
      Object.entries(stats.bySource).map(([source, value]) => [source, { ...value }]),
    ),
    errorsByName: { ...stats.errorsByName },
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
