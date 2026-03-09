import type { Pool, PoolClient } from 'pg';

export interface PgQueryResultLike<Row extends object = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface PgQueryable {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResultLike<Row>>;
}

export interface PgPoolClientLike extends PgQueryable {
  release(): void;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgPoolClientLike>;
}

export type PgExecutor = PgPoolLike | PgPoolClientLike;

export const isPgPoolLike = (executor: PgExecutor): executor is PgPoolLike => {
  return 'connect' in executor && typeof executor.connect === 'function';
};

export const asPgExecutor = (pool: Pool | PoolClient): PgExecutor => {
  if ('connect' in pool) {
    return pool as unknown as PgPoolLike;
  }

  return pool as unknown as PgPoolClientLike;
};

export const toRowCount = (rowCount: number | null): number => {
  return rowCount ?? 0;
};
