import { Pool, type PoolConfig } from 'pg';

export interface CreatePgPoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

export const createPgPool = (options: CreatePgPoolOptions): Pool => {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.idleTimeoutMillis === undefined
      ? {}
      : { idleTimeoutMillis: options.idleTimeoutMillis }),
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
  };

  return new Pool(config);
};
