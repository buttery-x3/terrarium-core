import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export async function preserveLegacyDatabase(
  legacy: string,
  destination: string,
) {
  if (existsSync(destination) || !existsSync(legacy)) return;
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.migrating`;
  if (existsSync(temporary))
    throw new Error(
      'A previous database copy is incomplete. Preserve and inspect the .migrating file before retrying.',
    );
  const database = new Database(legacy, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await database.backup(temporary);
    if (existsSync(destination))
      throw new Error(
        'The destination database appeared during copying; neither database was overwritten.',
      );
    renameSync(temporary, destination);
  } finally {
    database.close();
  }
}
