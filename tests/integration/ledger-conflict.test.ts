// Verifies conditional ledger writes: a runner whose row was taken over by another run, or
// completed, gets LedgerConflictError and never rewrites the completed row.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerConflictError } from '../../src/lib/index.js';
import { Ledger, ledgerPk, ledgerSk } from '../../src/lib/ledger.js';
import { doc, dropIfExists, raw, uniqueName } from './helpers.js';

const APP = uniqueName('ddbmig-conflict');
const LEDGER_TABLE = `${APP}-ledger`;
const MIG_ID = '2026-07-06_00-00-contended';

function runner(): Ledger {
  return new Ledger(raw, doc, { tableName: LEDGER_TABLE, scope: APP, stage: 'dev' });
}

async function row(): Promise<Record<string, unknown> | undefined> {
  const resp = await doc.send(
    new GetCommand({ TableName: LEDGER_TABLE, Key: { pk: ledgerPk(APP, 'dev'), sk: ledgerSk(MIG_ID) } }),
  );
  return resp.Item;
}

beforeAll(async () => {
  await dropIfExists(LEDGER_TABLE);
  await runner().ensureExists();
});

afterAll(async () => {
  await dropIfExists(LEDGER_TABLE);
});

describe('conditional ledger writes', () => {
  const first = runner();
  const second = runner();

  it('lets a second run take over an in-progress row', async () => {
    await first.markStart({ migrationId: MIG_ID, checksum: 'c1' });
    await second.markStart({ migrationId: MIG_ID, checksum: 'c1' });
    await second.setCheckpoint(MIG_ID, { page: 2 });
    await second.markComplete(MIG_ID, 42);
    expect(await row()).toMatchObject({ status: 'completed', durationMs: 42 });
  });

  it('rejects every write from the superseded run with LedgerConflictError', async () => {
    const before = await row();
    for (const write of [
      () => first.markComplete(MIG_ID, 1),
      () => first.markFailed(MIG_ID, 'late failure'),
      () => first.setCheckpoint(MIG_ID, { page: 1 }),
    ]) {
      const err = await write().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(LedgerConflictError);
      expect(err).toMatchObject({ code: 'LEDGER_CONFLICT', migrationId: MIG_ID });
    }
    expect(await first.markInterrupted(MIG_ID, 'late interrupt')).toBe(false);
    expect(await row()).toEqual(before);
  });

  it('refuses to restart a completed row', async () => {
    const before = await row();
    const err = await runner()
      .markStart({ migrationId: MIG_ID, checksum: 'c2' })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerConflictError);
    expect(err).toMatchObject({ code: 'LEDGER_CONFLICT', operation: 'markStart' });
    expect(await row()).toEqual(before);
  });
});
