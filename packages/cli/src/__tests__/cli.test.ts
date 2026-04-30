import { describe, expect, it } from 'vitest';

import { runCli } from '../cli';

class RecordingWritable {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

describe('runCli', () => {
  it('prints help when no command is provided', async () => {
    const stdout = new RecordingWritable();

    const exitCode = await runCli({ argv: [], stdout });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain('Usage: ledgermind <command> [options]');
    expect(stdout.toString()).toContain('status');
    expect(stdout.toString()).toContain('remember <text>');
    expect(stdout.toString()).toContain('state');
    expect(stdout.toString()).toContain('task <prompt>');
  });

  it('prints help when requested explicitly', async () => {
    const stdout = new RecordingWritable();

    const exitCode = await runCli({ argv: ['--help'], stdout });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain('Commands:');
  });

  it('returns a placeholder error for unknown commands', async () => {
    const stdout = new RecordingWritable();

    const exitCode = await runCli({ argv: ['unknown'], stdout });

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe('Command "unknown" is not implemented yet.\n');
  });

  it('prints JSON error envelopes when --json is present', async () => {
    const stdout = new RecordingWritable();
    const stderr = new RecordingWritable();

    const exitCode = await runCli({
      argv: ['remember', '', '--json'],
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe('');
    expect(stderr.toString().split('\n')).toHaveLength(2);
    expect(JSON.parse(stderr.toString())).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('remember requires non-empty text') },
    });
  });

  it('prints human errors to stderr without --json', async () => {
    const stdout = new RecordingWritable();
    const stderr = new RecordingWritable();

    const exitCode = await runCli({
      argv: ['remember', ''],
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe('');
    expect(stderr.toString()).toBe('remember requires non-empty text.\n');
  });

  it('prints JSON error envelopes for unknown options with --json', async () => {
    const stdout = new RecordingWritable();
    const stderr = new RecordingWritable();

    const exitCode = await runCli({
      argv: ['status', '--unknown-option', '--json'],
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe('');
    expect(stderr.toString().split('\n')).toHaveLength(2);
    expect(JSON.parse(stderr.toString())).toMatchObject({
      ok: false,
      error: { message: 'Unknown option "--unknown-option".' },
    });
  });
});
