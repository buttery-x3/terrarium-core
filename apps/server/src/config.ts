import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadEnvironment } from 'dotenv';

export const repositoryRoot = fileURLToPath(
  new URL('../../../', import.meta.url),
);

export function loadConfig() {
  loadEnvironment({ path: resolve(repositoryRoot, '.env') });
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer from 1 to 65535.');
  return {
    port,
    host: '127.0.0.1',
    databasePath: resolve(
      repositoryRoot,
      process.env.DATABASE_PATH ?? 'data/terrarium.db',
    ),
    useLegacyDatabase: !process.env.DATABASE_PATH,
    legacyDatabasePath: resolve(
      repositoryRoot,
      'apps/server/data/terrarium.db',
    ),
    origins: ['localhost', '127.0.0.1'].flatMap((host) =>
      [4173, 4174].map((port) => `http://${host}:${port}`),
    ),
  };
}
