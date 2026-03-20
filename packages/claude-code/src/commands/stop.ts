#!/usr/bin/env node

export const runStopCommand = async (): Promise<void> => {
  process.stderr.write('LedgerMind Claude stop hook is not implemented yet.\n');
};

await runStopCommand();
