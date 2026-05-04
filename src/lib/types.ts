import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export type StageConfig = {
  region: string;
  /** Prefix prepended to every logical table name resolved via ctx.tableName(). */
  tablePrefix?: string;
  /** Logical → physical table name overrides (wins over tablePrefix). */
  tables?: Record<string, string>;
  /** Where the migrations ledger lives. Defaults to `${appName}-migrations-${stage}`. */
  ledgerTable?: string;
  /** AWS endpoint override (for ddb-local / testcontainers). */
  endpoint?: string;
};

export type Config = {
  appName: string;
  migrationsDir: string;
  stages: Record<string, StageConfig>;
};

export type ResolvedStage = StageConfig & {
  stage: string;
  ledgerTable: string;
};

export type LedgerStatus = 'completed' | 'in_progress' | 'failed';

export type LedgerEntry = {
  migrationId: string;
  appliedAt: string;
  checksum: string;
  status: LedgerStatus;
  durationMs?: number;
  appliedBy?: string;
  itemsProcessed?: number;
  errorMessage?: string;
  checkpoint?: Record<string, unknown>;
};

export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
};

export type MigrationContext = {
  /** Marshaled high-level client. Use this for item-level reads/writes. */
  ddb: DynamoDBDocumentClient;
  /** Low-level client. Use this for table-level operations and raw scans. */
  ddbRaw: DynamoDBClient;
  /** Resolve a logical table name to its physical name for this stage. */
  tableName(logical: string): string;
  /** Stage label, e.g. "dev", "prod". */
  stage: string;
  /** True for `--dry-run`. Migrations should branch on this to skip side effects. */
  dryRun: boolean;
  /** Prefer this over console.log; output is prefixed with the migration id. */
  logger: Logger;
  /** Persist arbitrary state on the ledger entry so the migration can resume after a crash. */
  checkpoint(value: Record<string, unknown>): Promise<void>;
  /** Read the last checkpoint value. Returns undefined if none has been set. */
  getCheckpoint<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T | undefined>;
};

export type MigrationModule = {
  description?: string;
  up(ctx: MigrationContext): Promise<void>;
  down?(ctx: MigrationContext): Promise<void>;
};

export type MigrationFile = {
  id: string;
  fileName: string;
  fullPath: string;
  checksum: string;
};
