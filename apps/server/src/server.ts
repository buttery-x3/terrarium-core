import { createDb, ensureTables, preserveLegacyDatabase } from '@terrarium/persistence';
import { ChatGptAuth, createChatGptProvider } from '@terrarium/lm-providers';
import { createApplication } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
if (config.useLegacyDatabase) await preserveLegacyDatabase(config.legacyDatabasePath, config.databasePath);
const db = createDb(config.databasePath);
try {
  await ensureTables(db);
  const auth = new ChatGptAuth();
  const { app } = await createApplication({ db, origins: config.origins, auth, provider: createChatGptProvider(auth) });
  await app.listen({ host: config.host, port: config.port });
  const shutdown = async () => { await app.close(); await db.destroy(); };
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
} catch (error) {
  await db.destroy();
  throw error;
}
