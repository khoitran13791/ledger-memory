import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SQLITE_SCHEMA_VERSION, SQLITE_TEXT_SEARCH_MODE } from '../sqlite-schema';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('openSqliteDatabase', () => {
  it('creates parent directories, applies schema, and enables foreign keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-'));
    tempDirs.push(dir);
    const path = join(dir, 'nested', 'memory.sqlite');

    const database = await openSqliteDatabase({ path });

    try {
      expect(database.path).toBe(path);
      expect(database.db.prepare('PRAGMA user_version').get()).toEqual({
        user_version: SQLITE_SCHEMA_VERSION,
      });
      expect(database.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(SQLITE_TEXT_SEARCH_MODE).toBe('mirror-table');
      expect(
        database.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events'")
          .get(),
      ).toEqual({
        name: 'ledger_events',
      });
      expect(
        database.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events_fts'",
          )
          .get(),
      ).toEqual({
        name: 'ledger_events_fts',
      });
      expect(
        database.db
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE name = 'ledger_events_fts'
               AND sql LIKE '%USING fts5%'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('does not create parent directories when opening a missing read-only database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-readonly-missing-'));
    tempDirs.push(dir);
    const parent = join(dir, 'nested');
    const path = join(parent, 'memory.sqlite');

    await expect(openSqliteDatabase({ path, readOnly: true })).rejects.toThrow();
    await expect(access(parent)).rejects.toThrow();
  });

  it('rejects databases with a future schema version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-future-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
    db.close();

    await expect(openSqliteDatabase({ path })).rejects.toThrow(
      `SQLite database schema version ${SQLITE_SCHEMA_VERSION + 1} is newer than supported version ${SQLITE_SCHEMA_VERSION}.`,
    );
  });

  it('rejects read-only databases that have not been initialized', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-readonly-empty-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const db = new DatabaseSync(path);
    db.close();

    await expect(openSqliteDatabase({ path, readOnly: true })).rejects.toThrow(
      'SQLite database schema has not been initialized.',
    );
  });

  it('closes the database handle when schema setup fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-schema-fail-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};
      CREATE TABLE ledger_events (id TEXT PRIMARY KEY) STRICT;
    `);
    db.close();

    await expect(openSqliteDatabase({ path })).rejects.toThrow();

    const reopened = new DatabaseSync(path);
    try {
      reopened.exec('PRAGMA user_version');
    } finally {
      reopened.close();
    }
  });
});
