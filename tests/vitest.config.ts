import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      '@ledgermind/domain': path.resolve(__dirname, '../packages/domain/src/index.ts'),
      '@ledgermind/application': path.resolve(__dirname, '../packages/application/src/index.ts'),
      '@ledgermind/adapters': path.resolve(__dirname, '../packages/adapters/src/index.ts'),
      '@ledgermind/infrastructure': path.resolve(__dirname, '../packages/infrastructure/src/index.ts'),
      '@ledgermind/sdk': path.resolve(__dirname, '../packages/sdk/src/index.ts'),
    },
  },
});
