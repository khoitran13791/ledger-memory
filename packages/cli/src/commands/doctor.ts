import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, parse } from 'node:path';

import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';
import type * as PgModule from 'pg';

export interface DoctorCheck {
  readonly ok: boolean;
  readonly message: string;
  readonly fix?: string;
}

export interface RunDoctorCommandInput {
  readonly config: CockpitConfig;
  checkPostgres?(): Promise<DoctorCheck>;
  checkBindingStore?(): Promise<DoctorCheck>;
}

const BINDING_STORE_FIX = 'Create a writable binding store directory or pass --binding-store <path>.';
const POSTGRES_FIX = 'Set LEDGERMIND_DB_URL or pass --db <postgres-url>.';
const POSTGRES_CONNECTION_FIX = 'Check LEDGERMIND_DB_URL, start Postgres, or pass --db <postgres-url>.';

const checkNodeVersion = (): DoctorCheck => {
  const major = Number(process.versions.node.split('.')[0] ?? '0');

  return major >= 22
    ? { ok: true, message: `Node ${process.versions.node}` }
    : { ok: false, message: `Node ${process.versions.node}`, fix: 'Install Node.js >=22.' };
};

const isMissingPathError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const findWritableAncestor = async (path: string): Promise<boolean> => {
  let current = dirname(path);
  const root = parse(current).root;

  while (current !== root) {
    try {
      await access(current, constants.W_OK);
      return true;
    } catch (error) {
      if (!isMissingPathError(error)) {
        return false;
      }
    }
    current = dirname(current);
  }

  try {
    await access(root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const checkBindingStorePath = async (bindingStorePath: string): Promise<DoctorCheck> => {
  try {
    await access(bindingStorePath, constants.R_OK | constants.W_OK);
    return { ok: true, message: bindingStorePath };
  } catch (error) {
    if (!isMissingPathError(error)) {
      return { ok: false, message: `${bindingStorePath} is not readable and writable`, fix: BINDING_STORE_FIX };
    }
  }

  if (await findWritableAncestor(bindingStorePath)) {
    return { ok: true, message: `${bindingStorePath} (will be created)` };
  }

  return { ok: false, message: `${bindingStorePath} cannot be created`, fix: BINDING_STORE_FIX };
};

const formatHumanCheck = (label: string, check: DoctorCheck): string =>
  `${label}: ${check.message}${check.fix === undefined ? '' : `\n  Fix: ${check.fix}`}\n`;

const localModule = (specifier: string): string =>
  new URL(
    import.meta.url.endsWith('.ts') ? `${specifier}.ts` : `${specifier}.js`,
    import.meta.url,
  ).href;

const checkPostgresConnection = async (config: CockpitConfig): Promise<DoctorCheck> => {
  if (config.storage.type !== 'postgres') {
    return {
      ok: false,
      message: 'not configured',
      fix: POSTGRES_FIX,
    };
  }

  const { Pool } = await import('pg') as typeof PgModule;
  const pool = new Pool({
    connectionString: config.storage.connectionString,
    max: 1,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 1_000,
  });

  try {
    await pool.query('select 1');
    return { ok: true, message: 'reachable' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `unreachable (${message})`,
      fix: POSTGRES_CONNECTION_FIX,
    };
  } finally {
    await pool.end();
  }
};

export const runDoctorCommand = async ({
  config,
  checkPostgres = () => checkPostgresConnection(config),
  checkBindingStore = () => checkBindingStorePath(config.bindingStorePath),
}: RunDoctorCommandInput): Promise<string> => {
  const checks = {
    node: checkNodeVersion(),
    postgres: await checkPostgres(),
    bindingStore: await checkBindingStore(),
  };

  if (config.output === 'json') {
    const { asJsonLine } =
      await import(localModule('../formatters')) as typeof FormattersModule;

    return asJsonLine({
      ok: Object.values(checks).every((check) => check.ok),
      checks,
    });
  }

  return [
    'LedgerMind doctor\n',
    formatHumanCheck('Node', checks.node),
    formatHumanCheck('Postgres', checks.postgres),
    formatHumanCheck('Binding store', checks.bindingStore),
  ].join('');
};
