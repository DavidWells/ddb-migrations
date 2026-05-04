import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedStage } from './types.js';

export type Clients = {
  raw: DynamoDBClient;
  doc: DynamoDBDocumentClient;
};

export function createClients(stage: ResolvedStage): Clients {
  const raw = new DynamoDBClient({
    region: stage.region,
    endpoint: stage.endpoint,
  });
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertClassInstanceToMap: true,
    },
  });
  return { raw, doc };
}
