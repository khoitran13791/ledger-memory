#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import type * as DoctorModule from './commands/doctor';
import type * as DecisionModule from './commands/decision';
import type * as ExplainModule from './commands/explain';
import type * as HandoffModule from './commands/handoff';
import type * as NextModule from './commands/next';
import type * as ProgressModule from './commands/progress';
import type * as RememberModule from './commands/remember';
import type * as RecallModule from './commands/recall';
import type * as SourceModule from './commands/source';
import type * as StaleModule from './commands/stale';
import type * as StateModule from './commands/state';
import type * as StatusModule from './commands/status';
import type * as TaskModule from './commands/task';
import type * as TimelineModule from './commands/timeline';
import type * as VerifyModule from './commands/verify';
import type * as ConfigModule from './config';
import type * as FormattersModule from './formatters';

export interface CliWritable {
  write(chunk: string): unknown;
}

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly stdout?: CliWritable;
  readonly stderr?: CliWritable;
}

const HELP = `Usage: ledgermind <command> [options]

Commands:
  status              Show memory cockpit status.
  doctor              Check local LedgerMind setup.
  remember <text>     Append a manual memory note.
  recall <query>      Search remembered work.
  timeline            Show recent memory events.
  explain <id>        Describe a summary or artifact.
  source <summary-id> Expand raw source messages with --yes.
  state               Show current operational state.
  next                Show active next steps.
  task <prompt>       Recall memory for a task start.
  handoff             Create a structured handoff from flags/stdin.
  decision <text>     Record a decision.
  progress <text>     Record progress.
  verify <text>       Record verification evidence.
  stale <record-id>   Mark a memory record stale.
  help                Show this help text.
`;

const localModule = (specifier: string): string =>
  new URL(import.meta.url.endsWith('.ts') ? `${specifier}.ts` : `${specifier}.js`, import.meta.url)
    .href;

const defaultCwd = (): string => process.env.INIT_CWD ?? process.cwd();

export const runCli = async ({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
}: RunCliOptions = {}): Promise<number> => {
  const effectiveArgv = argv[0] === '--' ? argv.slice(1) : argv;

  if (effectiveArgv.length === 0 || effectiveArgv[0] === '--help' || effectiveArgv[0] === 'help') {
    stdout.write(HELP);
    return 0;
  }

  const { splitCommand, parseCockpitConfig } = (await import(
    localModule('./config')
  )) as typeof ConfigModule;
  let optionArgs: readonly string[] = [];

  try {
    const { command, commandArgs, optionArgs: sharedOptionArgs } = splitCommand(effectiveArgv);
    optionArgs = sharedOptionArgs;
    const config = parseCockpitConfig({
      argv: optionArgs,
      env: process.env,
      cwd: defaultCwd(),
    });

    switch (command) {
      case 'status': {
        const { runStatusCommand } = (await import(
          localModule('./commands/status')
        )) as typeof StatusModule;
        stdout.write(await runStatusCommand({ config }));
        return 0;
      }
      case 'doctor': {
        const { runDoctorCommand } = (await import(
          localModule('./commands/doctor')
        )) as typeof DoctorModule;
        stdout.write(await runDoctorCommand({ config }));
        return 0;
      }
      case 'remember': {
        const { runRememberCommand } = (await import(
          localModule('./commands/remember')
        )) as typeof RememberModule;
        stdout.write(await runRememberCommand({ config, text: commandArgs.join(' ') }));
        return 0;
      }
      case 'recall': {
        const { runRecallCommand } = (await import(
          localModule('./commands/recall')
        )) as typeof RecallModule;
        stdout.write(await runRecallCommand({ config, query: commandArgs.join(' ') }));
        return 0;
      }
      case 'timeline': {
        const { runTimelineCommand } = (await import(
          localModule('./commands/timeline')
        )) as typeof TimelineModule;
        stdout.write(await runTimelineCommand({ config }));
        return 0;
      }
      case 'explain': {
        const { runExplainCommand } = (await import(
          localModule('./commands/explain')
        )) as typeof ExplainModule;
        stdout.write(await runExplainCommand({ config, id: commandArgs[0] ?? '' }));
        return 0;
      }
      case 'source': {
        const { runSourceCommand } = (await import(
          localModule('./commands/source')
        )) as typeof SourceModule;
        stdout.write(
          await runSourceCommand({
            config,
            summaryId: commandArgs[0] ?? '',
            confirmed: optionArgs.includes('--yes'),
          }),
        );
        return 0;
      }
      case 'state': {
        const { runStateCommand } = (await import(
          localModule('./commands/state')
        )) as typeof StateModule;
        stdout.write(await runStateCommand({ config }));
        return 0;
      }
      case 'next': {
        const { runNextCommand } = (await import(
          localModule('./commands/next')
        )) as typeof NextModule;
        stdout.write(await runNextCommand({ config }));
        return 0;
      }
      case 'task': {
        const { runTaskCommand } = (await import(
          localModule('./commands/task')
        )) as typeof TaskModule;
        stdout.write(await runTaskCommand({ config, prompt: commandArgs.join(' ') }));
        return 0;
      }
      case 'handoff': {
        const { runHandoffCommand } = (await import(
          localModule('./commands/handoff')
        )) as typeof HandoffModule;
        stdout.write(await runHandoffCommand({ config, text: commandArgs.join(' ') }));
        return 0;
      }
      case 'decision': {
        const { runDecisionCommand } = (await import(
          localModule('./commands/decision')
        )) as typeof DecisionModule;
        stdout.write(await runDecisionCommand({ config, text: commandArgs.join(' ') }));
        return 0;
      }
      case 'progress': {
        const { runProgressCommand } = (await import(
          localModule('./commands/progress')
        )) as typeof ProgressModule;
        stdout.write(await runProgressCommand({ config, text: commandArgs.join(' ') }));
        return 0;
      }
      case 'verify': {
        const { runVerifyCommand } = (await import(
          localModule('./commands/verify')
        )) as typeof VerifyModule;
        stdout.write(await runVerifyCommand({ config, text: commandArgs.join(' ') }));
        return 0;
      }
      case 'stale': {
        const { runStaleCommand } = (await import(
          localModule('./commands/stale')
        )) as typeof StaleModule;
        stdout.write(await runStaleCommand({ config, recordId: commandArgs[0] ?? '' }));
        return 0;
      }
    }

    stdout.write(`Command "${command}" is not implemented yet.\n`);
    return 1;
  } catch (error) {
    if (optionArgs.includes('--json') || effectiveArgv.includes('--json')) {
      const { errorJsonLine } = (await import(
        localModule('./formatters')
      )) as typeof FormattersModule;
      stderr.write(errorJsonLine(error));
    } else {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 1;
  }
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
