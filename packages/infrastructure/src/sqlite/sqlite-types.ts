import type { DatabaseSync, StatementSync } from 'node:sqlite';

export type SqliteValue = string | number | bigint | Uint8Array | null;
export type SqliteParams = readonly SqliteValue[] | Record<string, SqliteValue>;
export type SqliteRow = Record<string, unknown>;

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export type SqliteStatement<Row extends SqliteRow = SqliteRow> = StatementSync & {
  get(...params: SqliteValue[]): Row | undefined;
  get(params: Record<string, SqliteValue>): Row | undefined;
  all(...params: SqliteValue[]): Row[];
  all(params: Record<string, SqliteValue>): Row[];
  run(...params: SqliteValue[]): SqliteRunResult;
  run(params: Record<string, SqliteValue>): SqliteRunResult;
};

export interface SqliteDatabase {
  readonly path: string;
  readonly db: DatabaseSync;
  close(): void;
}
