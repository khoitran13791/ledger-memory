import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger } from './sqlite-json';
import { SQLITE_SCHEMA_SQL, SQLITE_SCHEMA_VERSION } from './sqlite-schema';
import type { SqliteDatabase } from './sqlite-types';

export interface OpenSqliteDatabaseOptions {
  readonly path: string;
  readonly readOnly?: boolean;
}

export const openSqliteDatabase = async ({
  path,
  readOnly = false,
}: OpenSqliteDatabaseOptions): Promise<SqliteDatabase> => {
  if (path.trim().length === 0) {
    throw new Error('SQLite path is required and cannot be empty.');
  }

  if (!readOnly && path !== ':memory:') {
    await mkdir(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path, {
    readOnly,
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });

  try {
    const versionRow = db.prepare('PRAGMA user_version').get() as
      | { readonly user_version: unknown }
      | undefined;
    const existingVersion = parseSqliteInteger(versionRow?.user_version, 'pragma user_version');

    if (existingVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite database schema version ${existingVersion} is newer than supported version ${SQLITE_SCHEMA_VERSION}.`,
      );
    }

    if (readOnly && existingVersion === 0) {
      throw new Error('SQLite database schema has not been initialized.');
    }

    if (!readOnly) {
      for (const statement of SQLITE_SCHEMA_SQL) {
        db.exec(statement);
      }

      if (existingVersion === 0) {
        db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      }
    }

    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    path,
    db,
    close() {
      db.close();
    },
  };
};
