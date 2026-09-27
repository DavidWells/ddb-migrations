// Lease-style run lock stored in the ledger table: one row per scope+stage, taken with a
// conditional write, kept alive by heartbeats, released by expiring it (never deleted).
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { LockHeldError, LockLostError, isConditionalCheckFailed } from './errors.js';

export type LockParams = {
  /** Document client for the ledger table. */
  ledgerClient: DynamoDBDocumentClient;
  tableName: string;
  scope: string;
  stage: string;
  /** Identity of this runner, e.g. `saaslayer-deployer:<runId>`. */
  owner: string;
};

export type LockRow = {
  pk: string;
  sk: string;
  owner: string;
  acquiredAt: string;
  /** Epoch seconds. 0 once released. */
  expiresAt: number;
  heartbeatAt: string;
  releasedAt?: string;
  previousOwner?: string;
};

export type AcquireLockParams = LockParams & {
  ttlSeconds: number;
  /** Called when this acquire takes over another owner's expired, unreleased lease. */
  onTakeover?: (previous: LockRow) => void;
};

export type AcquireLockResult = {
  owner: string;
  expiresAt: number;
  /** True when an expired lease held by another owner was taken over. */
  takeover: boolean;
  previousOwner?: string;
};

export function lockKey(scope: string, stage: string): { pk: string; sk: string } {
  return { pk: `LOCK#SCOPE#${scope}#STAGE#${stage}`, sk: 'LOCK' };
}

/** Takes the lease if it is free, expired, released, or already ours. Throws LockHeldError otherwise. */
export async function acquireLock(p: AcquireLockParams): Promise<AcquireLockResult> {
  const previous = await readLock(p);
  const now = nowSeconds();
  const expiresAt = now + p.ttlSeconds;
  const at = new Date().toISOString();
  const previousOwner =
    previous && previous.owner !== p.owner ? previous.owner : previous?.previousOwner;
  const row: LockRow = {
    ...lockKey(p.scope, p.stage),
    owner: p.owner,
    acquiredAt: at,
    expiresAt,
    heartbeatAt: at,
    ...(previousOwner !== undefined ? { previousOwner } : {}),
  };
  try {
    await p.ledgerClient.send(
      new PutCommand({
        TableName: p.tableName,
        Item: row,
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now OR #owner = :owner',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':now': now, ':owner': p.owner },
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    const holder = await readLock(p);
    throw new LockHeldError(p.scope, p.stage, holder?.owner ?? 'unknown', holder?.expiresAt ?? 0);
  }
  const takeover = !!previous && previous.owner !== p.owner && previous.releasedAt === undefined;
  if (takeover && previous) p.onTakeover?.(previous);
  return {
    owner: p.owner,
    expiresAt,
    takeover,
    ...(takeover && previous ? { previousOwner: previous.owner } : {}),
  };
}

/** Extends our unreleased lease to now + ttlSeconds. Throws LockLostError if it is not ours. */
export async function heartbeatLock(
  p: LockParams & { ttlSeconds: number },
): Promise<{ expiresAt: number }> {
  const expiresAt = nowSeconds() + p.ttlSeconds;
  await ownerWrite(p, {
    UpdateExpression: 'SET expiresAt = :expiresAt, heartbeatAt = :at',
    ConditionExpression: '#owner = :owner AND attribute_not_exists(releasedAt)',
    values: { ':expiresAt': expiresAt, ':at': new Date().toISOString() },
  });
  return { expiresAt };
}

/** Releases our lease by expiring it; the row is kept for audit. Throws LockLostError if it is not ours. */
export async function releaseLock(p: LockParams): Promise<void> {
  await ownerWrite(p, {
    UpdateExpression: 'SET expiresAt = :zero, releasedAt = :at',
    ConditionExpression: '#owner = :owner',
    values: { ':zero': 0, ':at': new Date().toISOString() },
  });
}

/** Verifies we hold a live, unreleased lease without writing. Throws LockLostError otherwise. */
export async function assertLockHeld(p: LockParams): Promise<void> {
  const row = await readLock(p);
  if (!row || row.owner !== p.owner || row.releasedAt !== undefined || row.expiresAt < nowSeconds()) {
    throw new LockLostError(p.scope, p.stage, p.owner, row?.owner);
  }
}

export async function readLock(p: LockParams): Promise<LockRow | undefined> {
  const resp = await p.ledgerClient.send(
    new GetCommand({ TableName: p.tableName, Key: lockKey(p.scope, p.stage), ConsistentRead: true }),
  );
  return resp.Item as LockRow | undefined;
}

export type RunLockOptions = {
  owner: string;
  /** Lease length. Required unless `held`; with `held` it enables heartbeats. */
  ttlSeconds?: number;
  /** The caller already holds the lease: verify ownership instead of acquiring, never release. */
  held?: boolean;
  onTakeover?: (previous: LockRow) => void;
};

export type RunLockInfo = {
  owner: string;
  /** True when this run took over another owner's expired lease. */
  takeover: boolean;
  previousOwner?: string;
};

export type RunLock = {
  /** Extends the lease when this run may write it; a no-op otherwise. Throws LockLostError. */
  heartbeat(): Promise<void>;
  /**
   * Releases an acquired lease. Resolves false instead of throwing when the lease was already
   * lost, and false in held mode, where the caller releases.
   */
  release(): Promise<boolean>;
  info: RunLockInfo;
};

/**
 * Takes (or, when held, verifies) the lease for one `up` run. Heartbeats never happen in a
 * held dry-run, which is expected to run with read-only credentials.
 */
export async function openRunLock(
  p: Omit<LockParams, 'owner'> & { lock: RunLockOptions; dryRun: boolean },
): Promise<RunLock> {
  const { lock } = p;
  const params: LockParams = { ...p, owner: lock.owner };
  let info: RunLockInfo;
  if (lock.held) {
    await assertLockHeld(params);
    info = { owner: lock.owner, takeover: false };
  } else {
    if (!lock.ttlSeconds || lock.ttlSeconds <= 0) {
      throw new Error('lock.ttlSeconds (a positive number) is required unless lock.held is true.');
    }
    const acquired = await acquireLock({ ...params, ttlSeconds: lock.ttlSeconds, onTakeover: lock.onTakeover });
    info = {
      owner: lock.owner,
      takeover: acquired.takeover,
      ...(acquired.previousOwner !== undefined ? { previousOwner: acquired.previousOwner } : {}),
    };
  }
  const ttlSeconds = lock.ttlSeconds;
  const canHeartbeat = ttlSeconds !== undefined && !(lock.held && p.dryRun);
  return {
    info,
    heartbeat: async () => {
      if (canHeartbeat) await heartbeatLock({ ...params, ttlSeconds });
    },
    release: async () => {
      if (lock.held) return false;
      try {
        await releaseLock(params);
        return true;
      } catch (err) {
        if (err instanceof LockLostError) return false;
        throw err;
      }
    },
  };
}

async function ownerWrite(
  p: LockParams,
  write: { UpdateExpression: string; ConditionExpression: string; values: Record<string, unknown> },
): Promise<void> {
  try {
    await p.ledgerClient.send(
      new UpdateCommand({
        TableName: p.tableName,
        Key: lockKey(p.scope, p.stage),
        UpdateExpression: write.UpdateExpression,
        ConditionExpression: write.ConditionExpression,
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ...write.values, ':owner': p.owner },
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    const holder = await readLock(p);
    throw new LockLostError(p.scope, p.stage, p.owner, holder?.owner);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
