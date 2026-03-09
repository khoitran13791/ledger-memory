import { readFile } from 'node:fs/promises';

import type { FileReaderPort } from '@ledgermind/application';

export class NodeFileReader implements FileReaderPort {
  async readBytes(path: string): Promise<Uint8Array> {
    const fileBuffer = await readFile(path);
    return new Uint8Array(fileBuffer);
  }
}
