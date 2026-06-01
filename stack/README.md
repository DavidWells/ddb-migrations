# ddb-migrations ledger stack

Reusable Serverless Framework stack for the shared DynamoDB migrations
ledger table.

Deploy one ledger table per AWS account and region:

```bash
cd stack
npm install
npx osls deploy --stage staging --region us-east-1
```

The default table name is `ddb-migrations-ledger`. Migration clients isolate
apps and stages inside the table using scoped keys:

```txt
pk = SCOPE#<scope>#STAGE#<stage>
sk = MIGRATION#<migrationId>
```

You can override the physical table name if needed:

```bash
npx osls deploy --stage staging --region us-east-1 --param='ledgerTableName=my-ledger'
```

Use `npx osls remove` only when you intentionally want to remove the
CloudFormation stack. The DynamoDB table has `DeletionPolicy: Retain`, so
removing the stack will not delete migration history automatically.
