import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface TranscriptCheckpoint {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly lineCount: number;
}

export interface TranscriptCheckpointStore {
  get(sessionId: string, transcriptPath: string): Promise<TranscriptCheckpoint | undefined>;
  save(checkpoint: TranscriptCheckpoint): Promise<void>;
}

const matchesCheckpoint = (
  candidate: TranscriptCheckpoint,
  sessionId: string,
  transcriptPath: string,
): boolean => candidate.sessionId === sessionId && candidate.transcriptPath === transcriptPath;

const readCheckpoints = async (checkpointStorePath: string): Promise<readonly TranscriptCheckpoint[]> => {
  try {
    return JSON.parse(await readFile(checkpointStorePath, 'utf8')) as TranscriptCheckpoint[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const writeCheckpoints = async (
  checkpointStorePath: string,
  checkpoints: readonly TranscriptCheckpoint[],
): Promise<void> => {
  await mkdir(dirname(checkpointStorePath), { recursive: true });
  await writeFile(checkpointStorePath, JSON.stringify(checkpoints, null, 2), 'utf8');
};

export const createFileTranscriptCheckpointStore = (
  checkpointStorePath: string,
): TranscriptCheckpointStore => ({
  async get(sessionId, transcriptPath) {
    return (await readCheckpoints(checkpointStorePath)).find((checkpoint) =>
      matchesCheckpoint(checkpoint, sessionId, transcriptPath),
    );
  },
  async save(checkpoint) {
    const existing = await readCheckpoints(checkpointStorePath);
    const next = existing.filter(
      (candidate) => !matchesCheckpoint(candidate, checkpoint.sessionId, checkpoint.transcriptPath),
    );
    next.push(checkpoint);
    await writeCheckpoints(checkpointStorePath, next);
  },
});
