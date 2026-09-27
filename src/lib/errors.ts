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
