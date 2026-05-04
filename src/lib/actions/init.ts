import { promises as fs } from 'node:fs';
import path from 'node:path';

const CONFIG_TEMPLATE = `{
  "appName": "my-app",
  "migrationsDir": "migrations",
  "stages": {
    "dev": {
      "region": "us-east-1",
      "tablePrefix": "my-app-dev-"
    },
    "staging": {
      "region": "us-east-1",
      "tablePrefix": "my-app-staging-"
    },
    "prod": {
      "region": "us-east-1",
      "tablePrefix": "my-app-prod-"
    }
  }
}
`;

export type InitResult = {
  configPath: string;
  migrationsDir: string;
};

export async function init(cwd: string = process.cwd()): Promise<InitResult> {
  const configPath = path.join(cwd, 'ddb-migrations.config.json');
  try {
    await fs.access(configPath);
    throw new Error(`Config already exists at ${configPath}.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.writeFile(configPath, CONFIG_TEMPLATE);
  const dir = path.join(cwd, 'migrations');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.gitkeep'), '');
  return { configPath, migrationsDir: dir };
}
