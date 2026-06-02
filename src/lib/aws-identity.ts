import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { ResolvedStage } from './types.js';

export type AwsCallerIdentity = {
  account?: string;
  arn?: string;
  userId?: string;
};

export async function getCallerIdentity(stage: ResolvedStage): Promise<AwsCallerIdentity> {
  const client = new STSClient({ region: stage.region });
  const result = await client.send(new GetCallerIdentityCommand({}));
  return {
    account: result.Account,
    arn: result.Arn,
    userId: result.UserId,
  };
}

export async function assertConfiguredAccount(stage: ResolvedStage): Promise<void> {
  if (!stage.accountId || stage.endpoint) return;
  const identity = await getCallerIdentity(stage);
  if (identity.account !== stage.accountId) {
    throw new Error(
      `AWS account mismatch for stage '${stage.stage}'. ` +
        `Expected ${stage.accountId}, got ${identity.account ?? 'unknown'}.`,
    );
  }
}
