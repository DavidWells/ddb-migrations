import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { ResolvedStage } from './types.js';

export type AwsCallerIdentity = {
  account?: string;
  arn?: string;
  userId?: string;
};

/** Credentials of an existing SDK client, e.g. an injected app client. */
export type ClientCredentials = DynamoDBClient['config']['credentials'];

/** STS client for the stage region. Uses the given credentials, else the default chain. */
export function stsClientFor(stage: ResolvedStage, credentials?: ClientCredentials): STSClient {
  return credentials
    ? new STSClient({ region: stage.region, credentials })
    : new STSClient({ region: stage.region });
}

export async function getCallerIdentity(
  stage: ResolvedStage,
  credentials?: ClientCredentials,
): Promise<AwsCallerIdentity> {
  const client = stsClientFor(stage, credentials);
  const result = await client.send(new GetCallerIdentityCommand({}));
  return {
    account: result.Account,
    arn: result.Arn,
    userId: result.UserId,
  };
}

export async function assertConfiguredAccount(
  stage: ResolvedStage,
  credentials?: ClientCredentials,
): Promise<void> {
  if (!stage.accountId || stage.endpoint) return;
  const identity = await getCallerIdentity(stage, credentials);
  if (identity.account !== stage.accountId) {
    throw new Error(
      `AWS account mismatch for stage '${stage.stage}'. ` +
        `Expected ${stage.accountId}, got ${identity.account ?? 'unknown'}.`,
    );
  }
}
