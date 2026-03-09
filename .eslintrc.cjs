module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'boundaries'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['**/dist/**', '**/node_modules/**', '.turbo/**'],
  settings: {
    'boundaries/elements': [
      { type: 'domain', pattern: 'packages/domain/src/**' },
      { type: 'application', pattern: 'packages/application/src/**' },
      { type: 'adapters', pattern: 'packages/adapters/src/**' },
      { type: 'infrastructure', pattern: 'packages/infrastructure/src/**' },
      { type: 'sdk', pattern: 'packages/sdk/src/**' },
    ],
  },
  rules: {
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        rules: [
          { from: 'domain', allow: [] },
          { from: 'application', allow: ['domain'] },
          { from: 'adapters', allow: ['application', 'domain'] },
          { from: 'infrastructure', allow: ['adapters', 'application', 'domain'] },
          { from: 'sdk', allow: ['infrastructure', 'adapters', 'application', 'domain'] },
        ],
      },
    ],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  },
  overrides: [
    {
      files: ['packages/domain/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@ledgermind/application',
                  '@ledgermind/adapters',
                  '@ledgermind/infrastructure',
                  '@ledgermind/sdk',
                  'zod',
                  'pg',
                  'ai',
                  'openai',
                  '@langchain/*',
                  'crypto',
                  'fs',
                  'path',
                  'node:crypto',
                  'node:fs',
                  'node:path',
                ],
                message: 'Domain layer must remain dependency-free and inward-only.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/application/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@ledgermind/adapters',
                  '@ledgermind/infrastructure',
                  '@ledgermind/sdk',
                  'zod',
                  'pg',
                  'ai',
                  'openai',
                  '@langchain/*',
                  'crypto',
                  'fs',
                  'path',
                  'node:crypto',
                  'node:fs',
                  'node:path',
                ],
                message: 'Application layer may only depend on domain and its own abstractions.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/adapters/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@ledgermind/infrastructure', '@ledgermind/sdk', 'pg', 'node-pg-migrate'],
                message: 'Adapters may only depend on application and domain.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/infrastructure/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@ledgermind/sdk'],
                message: 'Infrastructure may not depend on sdk.',
              },
            ],
          },
        ],
      },
    },
  ],
};
