import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractContinuityHandoffFromTranscript } from '../continuity/transcript-continuity-extractor';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('extractContinuityHandoffFromTranscript', () => {
  it('extracts deterministic continuity buckets and edited files from a Claude transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-transcript-extractor-'));
    tempDirectories.push(directory);
    const transcriptPath = join(directory, 'transcript.jsonl');

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ message: { role: 'user', content: 'Goal: implement continuity hooks.' } }),
        JSON.stringify({
          message: {
            role: 'assistant',
            content: [
              'Goal: implement continuity hooks.',
              'We decided to use recallForTask on session start.',
              'Next, wire the UserPromptSubmit hook.',
              'Tests passed: pnpm typecheck.',
              'We must preserve clean architecture.',
              'Open question: should MCP expose write tools by default?',
            ].join('\n'),
          },
        }),
        JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: join(directory, 'src', 'hook.ts') },
        }),
      ].join('\n'),
      'utf8',
    );

    const extracted = await extractContinuityHandoffFromTranscript({
      transcriptPath,
      sessionId: 'sess-extract',
    });

    expect(extracted.goal).toBe('Goal: implement continuity hooks.');
    expect(extracted.nextSteps).toEqual(['Next, wire the UserPromptSubmit hook.']);
    expect(extracted.decisions).toEqual(['We decided to use recallForTask on session start.']);
    expect(extracted.constraints).toEqual(['We must preserve clean architecture.']);
    expect(extracted.verification).toEqual(['Tests passed: pnpm typecheck.']);
    expect(extracted.openQuestions).toEqual([
      'Open question: should MCP expose write tools by default?',
    ]);
    expect(extracted.changedFiles).toEqual([join(directory, 'src', 'hook.ts')]);
  });

  it('redacts secrets and ignores user transcript lines when building handoff buckets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-transcript-extractor-redaction-'));
    tempDirectories.push(directory);
    const transcriptPath = join(directory, 'transcript.jsonl');

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          message: {
            role: 'user',
            content: 'Next, deploy using postgres://user:pass@localhost/db and sk-liveSecret.',
          },
        }),
        JSON.stringify({
          message: {
            role: 'assistant',
            content:
              'Next, run pnpm test with postgres://user:pass@localhost/db and sk-liveSecret.',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const extracted = await extractContinuityHandoffFromTranscript({
      transcriptPath,
      sessionId: 'sess-extract',
    });

    expect(extracted.nextSteps).toEqual(['Next, run pnpm test with [REDACTED] and [REDACTED].']);
    expect(JSON.stringify(extracted)).not.toContain('postgres://user:pass@localhost/db');
    expect(JSON.stringify(extracted)).not.toContain('sk-liveSecret');
    expect(JSON.stringify(extracted)).not.toContain('Next, deploy using');
  });
});
