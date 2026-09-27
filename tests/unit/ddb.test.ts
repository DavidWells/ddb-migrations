import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createClients } from '../../src/lib/ddb.js';
import type { ResolvedStage } from '../../src/lib/types.js';

function stage(overrides: Partial<ResolvedStage> = {}): ResolvedStage {
  return {
    stage: 'dev',
    region: 'us-east-1',
    ledgerTable: 'ddb-migrations-ledger',
    ledgerScope: 'myapp',
    ledgerRegion: 'us-east-1',
    ...overrides,
  } as ResolvedStage;
}

describe('createClients', () => {
  it('reuses the app client for the ledger when region+endpoint match', () => {
    const { raw, doc, ledgerRaw, ledgerDoc } = createClients(stage());
    expect(ledgerRaw).toBe(raw);
    expect(ledgerDoc).toBe(doc);
  });

  it('reuses the app client when both endpoints are the same explicit value', () => {
    const { raw, doc, ledgerRaw, ledgerDoc } = createClients(
      stage({ endpoint: 'http://localhost:8000', ledgerEndpoint: 'http://localhost:8000' }),
    );
    expect(ledgerRaw).toBe(raw);
    expect(ledgerDoc).toBe(doc);
  });

  it('builds a separate ledger client when the ledger region differs', () => {
    const { raw, doc, ledgerRaw, ledgerDoc } = createClients(
      stage({ region: 'us-west-2', ledgerRegion: 'us-east-1' }),
    );
    expect(ledgerRaw).not.toBe(raw);
    expect(ledgerDoc).not.toBe(doc);
  });

  it('builds a separate ledger client when only the endpoint differs', () => {
    const { raw, doc, ledgerRaw, ledgerDoc } = createClients(
      stage({ endpoint: 'http://localhost:8000', ledgerEndpoint: undefined }),
    );
    expect(ledgerRaw).not.toBe(raw);
    expect(ledgerDoc).not.toBe(doc);
  });

  it('configures each client with its own region', async () => {
    const { raw, ledgerRaw } = createClients(
      stage({ region: 'us-west-2', ledgerRegion: 'eu-west-1' }),
    );
    // DynamoDBClient.config.region is a Provider<string>; call it to resolve.
    const appRegion = await raw.config.region();
    const ledgerRegion = await ledgerRaw.config.region();
    expect(appRegion).toBe('us-west-2');
    expect(ledgerRegion).toBe('eu-west-1');
  });

  it('uses injected app and ledger clients and derives missing document clients', () => {
    const appRaw = new DynamoDBClient({ region: 'us-east-1' });
    const ledgerRaw = new DynamoDBClient({ region: 'us-east-1' });
    const ledgerDoc = DynamoDBDocumentClient.from(ledgerRaw);
    const clients = createClients(stage(), {
      app: { raw: appRaw },
      ledger: { raw: ledgerRaw, doc: ledgerDoc },
    });
    expect(clients.raw).toBe(appRaw);
    expect(clients.doc).toBeInstanceOf(DynamoDBDocumentClient);
    expect(clients.ledgerRaw).toBe(ledgerRaw);
    expect(clients.ledgerDoc).toBe(ledgerDoc);
  });

  it('builds a default-chain ledger client when only the app client is injected', async () => {
    const appRaw = new DynamoDBClient({ region: 'us-east-1' });
    const clients = createClients(stage(), { app: { raw: appRaw } });
    expect(clients.raw).toBe(appRaw);
    expect(clients.ledgerRaw).not.toBe(appRaw);
    expect(await clients.ledgerRaw.config.region()).toBe('us-east-1');
  });

  it('builds a default-chain app client when only the ledger client is injected', () => {
    const ledgerRaw = new DynamoDBClient({ region: 'us-east-1' });
    const clients = createClients(stage(), { ledger: { raw: ledgerRaw } });
    expect(clients.ledgerRaw).toBe(ledgerRaw);
    expect(clients.raw).not.toBe(ledgerRaw);
  });
});
