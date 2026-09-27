// Typed errors with stable `code` values that callers branch on (ledger + lock failures).
// Each carries the context an operator needs to act on it.

/** The ledger table does not exist and `ledger.create` is false. */
export class LedgerMissingError extends Error {
  readonly code = 'LEDGER_MISSING';

  constructor(readonly tableName: string) {
    super(
      `Ledger table '${tableName}' does not exist and ledger.create is false. ` +
        `Create it with your infrastructure before running migrations.`,
    );
    this.name = 'LedgerMissingError';
  }
}

/**
 * A ledger write lost a race: the row was completed, or another run started it after this one.
 * Completed rows are never rewritten.
 */
export class LedgerConflictError extends Error {
  readonly code = 'LEDGER_CONFLICT';

  constructor(
    readonly migrationId: string,
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Ledger ${operation} for '${migrationId}' was rejected: the row is completed ` +
        `or another run started it after this one.`,
      options,
    );
    this.name = 'LedgerConflictError';
  }
}

/** Another owner holds a live lease on the run lock. */
export class LockHeldError extends Error {
  readonly code = 'LOCK_HELD';

  constructor(
    readonly scope: string,
    readonly stage: string,
    readonly holder: string,
    /** Epoch seconds when the holder's lease expires. */
    readonly expiresAt: number,
  ) {
    super(
      `Migration lock for scope '${scope}' stage '${stage}' is held by '${holder}' ` +
        `until ${new Date(expiresAt * 1000).toISOString()}.`,
    );
    this.name = 'LockHeldError';
  }
}

/** This owner no longer holds the run lock: it expired, was released, or was taken over. */
export class LockLostError extends Error {
  readonly code = 'LOCK_LOST';

  constructor(
    readonly scope: string,
    readonly stage: string,
    readonly owner: string,
    /** Current holder, when there is one. */
    readonly holder?: string,
  ) {
    super(
      `Migration lock for scope '${scope}' stage '${stage}' is not held by '${owner}'` +
        (holder && holder !== owner ? ` (holder: '${holder}').` : '.'),
    );
    this.name = 'LockLostError';
  }
}

/** True for DynamoDB's ConditionalCheckFailedException, by class or by name. */
export function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'ConditionalCheckFailedException'
  );
}
