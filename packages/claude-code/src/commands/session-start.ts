#!/usr/bin/env node

export const runSessionStartCommand = async (): Promise<void> => {
  process.stderr.write('LedgerMind Claude session-start hook is not implemented yet.\n');
};

await runSessionStartCommand();
