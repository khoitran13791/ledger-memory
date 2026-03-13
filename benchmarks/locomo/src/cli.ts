import { buildBenchmarkConfig, loadLocomoDataset, selectExamples } from './config.js';
import { runLocomoBenchmark } from './runner.js';

const main = async (): Promise<void> => {
  const config = buildBenchmarkConfig(process.argv.slice(2));

  const samples = await loadLocomoDataset(config.datasetPath);
  const examples = await selectExamples({
    config,
    samples,
  });

  const result = await runLocomoBenchmark({
    config,
    samples,
    examples,
  });

  process.stdout.write(`LOCOMO benchmark complete (${config.runId})\n`);
  process.stdout.write(`- subset mode: ${config.smoke ? 'smoke' : config.canary ? 'canary' : 'full'}\n`);
  process.stdout.write(`- runtime mode: ${config.runtimeMode}\n`);
  process.stdout.write(`- config snapshot: ${result.configSnapshotPath}\n`);
  process.stdout.write(`- per-example jsonl: ${result.perExamplePath}\n`);
  process.stdout.write(`- trace per-example jsonl: ${result.tracePerExamplePath}\n`);
  process.stdout.write(`- summary: ${result.summaryPath}\n`);
};

main().catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`LOCOMO benchmark failed: ${message}\n`);
  process.exitCode = 1;
});
