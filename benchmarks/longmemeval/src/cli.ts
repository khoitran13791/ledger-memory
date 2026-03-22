import { buildBenchmarkConfig } from './config.js';
import { loadLongMemEvalDataset } from './dataset.js';
import { runLongMemEvalBenchmark } from './runner.js';

const HELP_TEXT = `LongMemEval benchmark runner

Usage:
  pnpm --filter @ledgermind/benchmark-longmemeval benchmark [options]

Options:
  --smoke                 Run the pinned smoke subset
  --canary                Run the pinned canary subset
  --runtime-mode <mode>   One of static_materialize or agentic_loop
  --out-dir <path>        Write artifacts to a specific directory
  --help, -h              Show this help message
`;

export const main = async (argv: readonly string[]): Promise<void> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const config = buildBenchmarkConfig(argv);
  const examples = await loadLongMemEvalDataset(config.datasetPath);
  const result = await runLongMemEvalBenchmark({
    config,
    examples,
  });

  process.stdout.write(`LongMemEval artifacts written to ${result.summaryPath}\n`);
};

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
