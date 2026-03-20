#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { formatMcpServerHelp, parseMcpServerConfig } from './config';

interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly stderr?: NodeJS.WriteStream;
}

export const runCli = ({
  argv = process.argv.slice(2),
  stderr = process.stderr,
}: RunCliOptions = {}): number => {
  if (argv.includes('--help')) {
    stderr.write(formatMcpServerHelp());
    return 0;
  }

  const config = parseMcpServerConfig({ argv });
  stderr.write(
    `LedgerMind MCP server configuration validated (${config.readOnly ? 'read-only' : 'write-enabled'} mode).\n`,
  );
  return 0;
};

const main = async (): Promise<void> => {
  try {
    const exitCode = runCli();
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
