export interface FileReaderPort {
  readBytes(path: string): Promise<Uint8Array>;
}
