import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseClaudeCodeConfig } from '../config';

describe('parseClaudeCodeConfig', () => {
  it('defaults to workspace-local sqlite storage', () => {
    const cwd = '/tmp/ledger-workspace';

    expect(
      parseClaudeCodeConfig({
        LEDGERMIND_WORKSPACE_ROOT: cwd,
      }),
    ).toMatchObject({
      storage: 'sqlite',
      sqlitePath: resolve(cwd, '.ledgermind/memory.sqlite'),
    });
  });
});
