// Verifies the STS client used for account checks: default chain unless the caller
// passes the credentials of an injected app client.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { stsClientFor } from '../../src/lib/aws-identity.js';
import type { ResolvedStage } from '../../src/lib/types.js';

const stage = {
  stage: 'dev',
  region: 'us-west-2',
  ledgerTable: 'ddb-migrations-ledger',
  ledgerScope: 'myapp',
  ledgerRegion: 'us-west-2',
} as ResolvedStage;

describe('stsClientFor', () => {
  it('uses the credentials of the given client', async () => {
    const app = new DynamoDBClient({
      region: 'us-west-2',
      credentials: { accessKeyId: 'AKIAINJECTED', secretAccessKey: 'secret' },
    });
    const sts = stsClientFor(stage, app.config.credentials);
    const credentials = await sts.config.credentials();
    expect(credentials.accessKeyId).toBe('AKIAINJECTED');
    expect(await sts.config.region()).toBe('us-west-2');
  });

  it('uses the stage region without explicit credentials', async () => {
    const sts = stsClientFor(stage);
    expect(await sts.config.region()).toBe('us-west-2');
  });
});
