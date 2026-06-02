import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export type StageConfig = {
  region: string;
  /** Optional AWS account guard/audit value. Not part of the ledger primary key. */
  accountId?: string;
  /** Optional AWS shared config profile name. Callers may also set AWS_PROFILE. */
  profile?: string;
  /** Prefix prepended to every logical table name resolved via ctx.tableName(). */
  tablePrefix?: string;
  /** Logical → physical table name overrides (wins over tablePrefix). */
  tables?: Record<string, string>;
  /** Stage override for the migrations ledger table. Defaults to ledger.tableName or ddb-migrations-ledger. */
  ledgerTable?: string;
  /** Stage override for the ledger AWS region. Wins over ledger.region. Defaults to stage.region. */
  ledgerRegion?: string;
  /** Stage override for the ledger AWS endpoint. Wins over ledger.endpoint. Defaults to stage.endpoint. */
  ledgerEndpoint?: string;
  /** AWS endpoint override (for ddb-local / testcontainers). */
  endpoint?: string;
};

export type LedgerConfig = {
  /** Shared ledger table name. Defaults to ddb-migrations-ledger. */
  tableName?: string;
  /** Namespace used in ledger partition keys. Defaults to appName. */
  scope?: string;
  /** AWS region for the ledger table. Defaults to the active stage's region. */
  region?: string;
  /** AWS endpoint override for the ledger client (ddb-local / testcontainers). */
  endpoint?: string;
};

export type Config = {
  appName: string;
  migrationsDir: string;
  ledger?: LedgerConfig;
  stages: Record<string, StageConfig>;
};

export type ResolvedStage = StageConfig & {
  stage: string;
  ledgerTable: string;
  ledgerScope: string;
  ledgerRegion: string;
  ledgerEndpoint?: string;
};

export type LedgerStatus = 'completed' | 'in_progress' | 'interrupted' | 'failed';

export type LedgerEntry = {
  pk: string;
  sk: string;
  scope: string;
  stage: string;
  migrationId: string;
  appliedAt: string;
  checksum: string;
  status: LedgerStatus;
  durationMs?: number;
  appliedBy?: string;
  accountId?: string;
  region?: string;
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

export type MigrationProgressEvent = {
  /** Migration id is injected by the runner when omitted by migration code. */
  migrationId?: string;
  /** Optional phase label such as scan/apply/verify. */
  phase?: string;
  /** Optional operation label such as put/update/delete. */
  operation?: string;
  /** Human-readable progress message. */
  message?: string;
  /** Logical or physical table currently being scanned/written. */
  table?: string;
  scanned?: number;
  written?: number;
  updated?: number;
  deleted?: number;
  skipped?: number;
  checkpointed?: boolean;
  done?: boolean;
  total?: number;
  remaining?: number;
  etaSeconds?: number;
  [key: string]: unknown;
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
  /** Aborted when the operator requests shutdown, e.g. first Ctrl-C in the CLI. */
  signal: AbortSignal;
  /** True once shutdown has been requested. Use at page/batch boundaries. */
  shouldStop(): boolean;
  /** Throw a MigrationInterruptedError when shutdown has been requested. */
  throwIfStopped(): void;
  /** Emit structured progress for long-running migrations. */
  progress(event: MigrationProgressEvent): void;
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
  kind: 'file' | 'directory';
};
