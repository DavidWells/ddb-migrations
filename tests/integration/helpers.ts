// Shared DynamoDB Local setup for integration tests: clients, temp projects, table cleanup.
// Reads DDB_ENDPOINT (default http://localhost:8000) and uses dummy credentials.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
export const REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= REGION;

export const raw = new DynamoDBClient({ region: REGION, endpoint: ENDPOINT });
export const doc = DynamoDBDocumentClient.from(raw);

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function dropIfExists(name: string): Promise<void> {
  try {
    await raw.send(new DeleteTableCommand({ TableName: name }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}

/** Creates a temp dir with a migrations/ folder holding the given files. Returns the dir. */
export function makeMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ddbmig-int-'));
  mkdirSync(path.join(dir, 'migrations'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, 'migrations', name), body);
  }
  return dir;
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export type RecordedCall = { command: string; table?: string };

/** A real DDB Local client that records each command name and TableName it sends. */
export function recordingClient(): { client: DynamoDBClient; calls: RecordedCall[] } {
  const client = new DynamoDBClient({ region: REGION, endpoint: ENDPOINT });
  const calls: RecordedCall[] = [];
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const input = args.input as { TableName?: string };
      calls.push({ command: String(context.commandName), table: input.TableName });
      return next(args);
    },
    { step: 'initialize', name: 'recordCalls' },
  );
  return { client, calls };
}

export const NOOP_MIGRATION = 'export async function up() {}\n';
