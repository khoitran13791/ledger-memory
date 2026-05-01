import { describe, expect, it } from 'vitest';

import { parseMcpServerConfig } from '../config';

describe('parseMcpServerConfig', () => {
  it('defaults to in-memory storage, no binding store path, and read-only mode', () => {
    const config = parseMcpServerConfig({ argv: [] });

    expect(config.storage).toEqual({ type: 'in-memory' });
    expect(config.bindingStorePath).toBeUndefined();
    expect(config.enableWriteTools).toBe(false);
    expect(config.readOnly).toBe(true);
  });

  it('parses postgres storage and binding store path from CLI flags', () => {
    const config = parseMcpServerConfig({
      argv: [
        '--db',
        'postgres://localhost/ledgermind',
        '--binding-store',
        '.ledgermind/session-bindings.json',
      ],
    });

    expect(config.storage).toEqual({
      type: 'postgres',
      connectionString: 'postgres://localhost/ledgermind',
    });
    expect(config.bindingStorePath).toBe('.ledgermind/session-bindings.json');
  });

  it('parses sqlite storage and keeps the host-provided path', () => {
    const config = parseMcpServerConfig({
      argv: ['--storage', 'sqlite', '--sqlite', '.ledgermind/memory.sqlite'],
      env: {},
    });

    expect(config.storage).toEqual({
      type: 'sqlite',
      path: '.ledgermind/memory.sqlite',
    });
  });

  it('selects sqlite storage from --sqlite without requiring --storage', () => {
    const config = parseMcpServerConfig({
      argv: ['--sqlite', '.ledgermind/memory.sqlite'],
      env: {},
    });

    expect(config.storage).toEqual({
      type: 'sqlite',
      path: '.ledgermind/memory.sqlite',
    });
  });

  it('lets explicit in-memory storage override sqlite path env', () => {
    const config = parseMcpServerConfig({
      argv: ['--storage', 'in-memory'],
      env: {
        LEDGERMIND_SQLITE_PATH: '.ledgermind/memory.sqlite',
      },
    });

    expect(config.storage).toEqual({ type: 'in-memory' });
  });

  it('keeps write tools disabled unless explicitly enabled', () => {
    const config = parseMcpServerConfig({
      argv: ['--enable-write-tools'],
    });

    expect(config.enableWriteTools).toBe(true);
    expect(config.readOnly).toBe(false);
  });
});
