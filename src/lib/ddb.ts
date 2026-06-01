import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedStage } from './types.js';

export type Clients = {
  /** App-table client. Region/endpoint come from stage.region / stage.endpoint. */
  raw: DynamoDBClient;
  doc: DynamoDBDocumentClient;
  /** Ledger client. Reuses the app client when ledger region+endpoint match the stage. */
  ledgerRaw: DynamoDBClient;
  ledgerDoc: DynamoDBDocumentClient;
};

const MARSHALL_OPTIONS = {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
} as const;

export function createClients(stage: ResolvedStage): Clients {
  const raw = new DynamoDBClient({
    region: stage.region,
    endpoint: stage.endpoint,
  });
  const doc = DynamoDBDocumentClient.from(raw, MARSHALL_OPTIONS);

  const ledgerSameAsApp =
    stage.ledgerRegion === stage.region && stage.ledgerEndpoint === stage.endpoint;
  const ledgerRaw = ledgerSameAsApp
    ? raw
    : new DynamoDBClient({ region: stage.ledgerRegion, endpoint: stage.ledgerEndpoint });
  const ledgerDoc = ledgerSameAsApp ? doc : DynamoDBDocumentClient.from(ledgerRaw, MARSHALL_OPTIONS);

  return { raw, doc, ledgerRaw, ledgerDoc };
}
