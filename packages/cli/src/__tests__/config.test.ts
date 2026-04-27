import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCockpitConfig, splitCommand } from '../config';

describe('splitCommand', () => {
  it('separates command args from shared options', () => {
    expect(splitCommand(['recall', 'bridge selection', '--json'])).toEqual({
      command: 'recall',
      commandArgs: ['bridge selection'],
      optionArgs: ['--json'],
    });
  });

  it('keeps command args after flag options', () => {
    expect(splitCommand(['remember', '--json', 'keep this note'])).toEqual({
      command: 'remember',
      commandArgs: ['keep this note'],
      optionArgs: ['--json'],
    });
  });

  it('keeps flag-like memory text after an option terminator', () => {
    expect(splitCommand(['remember', '--json', '--', 'use', '--storage', 'postgres'])).toEqual({
      command: 'remember',
      commandArgs: ['use', '--storage', 'postgres'],
      optionArgs: ['--json'],
    });
  });
});

describe('parseCockpitConfig', () => {
  it('defaults to workspace binding store and workspace runtime session', () => {
    const cwd = '/tmp/ledger-workspace';

    expect(parseCockpitConfig({ argv: [], env: {}, cwd })).toEqual({
      storage: { type: 'in-memory' },
      bindingStorePath: resolve(cwd, '.ledgermind/session-bindings.json'),
      runtimeSessionId: 'workspace',
      workspaceScope: cwd,
      userScope: 'local-user',
      output: 'human',
    });
  });

  it('parses postgres storage from --db and --json', () => {
    expect(
      parseCockpitConfig({
        argv: ['--db', 'postgres://localhost/ledgermind', '--json'],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toMatchObject({
      storage: {
        type: 'postgres',
        connectionString: 'postgres://localhost/ledgermind',
      },
      output: 'json',
    });
  });

  it('rejects unsupported storage', () => {
    expect(() =>
      parseCockpitConfig({
        argv: ['--storage', 'sqlite'],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toThrow('Unsupported storage type "sqlite".');
  });

  it('requires a value for value options', () => {
    expect(() =>
      parseCockpitConfig({
        argv: ['--binding-store'],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toThrow('--binding-store requires a value.');
  });

  it('rejects unknown options', () => {
    expect(() =>
      parseCockpitConfig({
        argv: ['--wat'],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toThrow('Unknown option "--wat".');
  });

  it('requires a connection string for postgres storage', () => {
    expect(() =>
      parseCockpitConfig({
        argv: ['--storage', 'postgres'],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toThrow('Postgres storage requires --db or LEDGERMIND_DB_URL.');
  });

  it('rejects a blank postgres connection string', () => {
    expect(() =>
      parseCockpitConfig({
        argv: ['--storage', 'postgres', '--db', '   '],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toThrow('Postgres storage requires --db or LEDGERMIND_DB_URL.');
  });

  it('ignores option-like command text after an option terminator when parsing config', () => {
    expect(
      parseCockpitConfig({
        argv: ['--json', '--', 'use', '--storage', 'postgres'],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toMatchObject({
      storage: { type: 'in-memory' },
      output: 'json',
    });
  });

  it('uses environment scopes when flags are omitted', () => {
    expect(
      parseCockpitConfig({
        argv: [],
        env: {
          LEDGERMIND_COCKPIT_BRANCH: 'main',
          LEDGERMIND_COCKPIT_PARENT_RUNTIME_SESSION: 'parent-runtime',
          LEDGERMIND_COCKPIT_RUNTIME_SESSION: 'runtime-1',
          LEDGERMIND_COCKPIT_USER: 'agent-user',
          LEDGERMIND_COCKPIT_WORKSPACE: '/tmp/other-workspace',
          LEDGERMIND_MCP_BINDING_STORE: '/tmp/bindings.json',
        },
        cwd: '/tmp/ledger-workspace',
      }),
    ).toMatchObject({
      bindingStorePath: '/tmp/bindings.json',
      runtimeSessionId: 'runtime-1',
      parentRuntimeSessionId: 'parent-runtime',
      workspaceScope: '/tmp/other-workspace',
      branchScope: 'main',
      userScope: 'agent-user',
    });
  });

  it('parses parent runtime session from shared options', () => {
    expect(
      parseCockpitConfig({
        argv: ['--runtime-session', 'child', '--parent-runtime-session', 'parent'],
        env: {},
        cwd: '/tmp/ledger-workspace',
      }),
    ).toMatchObject({
      runtimeSessionId: 'child',
      parentRuntimeSessionId: 'parent',
    });
  });
});
