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
