#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { createOperatorWorkerLogger } from './logging';
import { createOperatorWorker } from './worker';
import { formatOperatorWorkerHelp, parseOperatorWorkerConfig } from './config';

interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly stderr?: NodeJS.WriteStream;
}

export const runCli = async ({
  argv = process.argv.slice(2),
  stderr = process.stderr,
}: RunCliOptions = {}): Promise<number> => {
  if (argv.includes('--help')) {
    stderr.write(formatOperatorWorkerHelp());
    return 0;
  }

  const logger = createOperatorWorkerLogger(stderr);
  const config = parseOperatorWorkerConfig({ argv });
  createOperatorWorker({ config });
  logger.info('Starting LedgerMind operator worker.', {
    workerId: config.workerId,
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
  });
  return 0;
};

const main = async (): Promise<void> => {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
