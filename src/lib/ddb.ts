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

/** A caller-built client. `doc` defaults to a document client over `raw` with the library's marshall options. */
export type ClientPair = {
  raw: DynamoDBClient;
  doc?: DynamoDBDocumentClient;
};

/**
 * Caller-built clients that replace the default-chain ones, e.g. separate credentials for the
 * ledger and the app tables, or read-only credentials for a dry-run. A missing one is built from
 * the stage config and the default credential chain.
 */
export type InjectedClients = {
  /** Used for every migration command (ctx.ddb / ctx.ddbRaw). */
  app?: ClientPair;
  /** Used for every ledger command. */
  ledger?: ClientPair;
};

const MARSHALL_OPTIONS = {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
} as const;

export function createClients(stage: ResolvedStage, injected: InjectedClients = {}): Clients {
  const raw = injected.app?.raw ?? new DynamoDBClient({
    region: stage.region,
    endpoint: stage.endpoint,
  });
  const doc = injected.app?.doc ?? DynamoDBDocumentClient.from(raw, MARSHALL_OPTIONS);

  if (injected.ledger) {
    return {
      raw,
      doc,
      ledgerRaw: injected.ledger.raw,
      ledgerDoc: injected.ledger.doc ?? DynamoDBDocumentClient.from(injected.ledger.raw, MARSHALL_OPTIONS),
    };
  }

  // An injected app client carries caller credentials, so the ledger never borrows it.
  const ledgerSameAsApp =
    !injected.app && stage.ledgerRegion === stage.region && stage.ledgerEndpoint === stage.endpoint;
  const ledgerRaw = ledgerSameAsApp
    ? raw
    : new DynamoDBClient({ region: stage.ledgerRegion, endpoint: stage.ledgerEndpoint });
  const ledgerDoc = ledgerSameAsApp ? doc : DynamoDBDocumentClient.from(ledgerRaw, MARSHALL_OPTIONS);

  return { raw, doc, ledgerRaw, ledgerDoc };
}
