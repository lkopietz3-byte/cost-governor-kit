// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    name: 'cost-governor/linter-controls',
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    name: 'cost-governor/typescript',
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    name: 'cost-governor/async-test-contracts',
    files: ['src/**/*.test.ts'],
    rules: {
      // In-memory doubles intentionally implement async interfaces. Keeping async
      // preserves rejected-promise and scheduling behavior in concurrency tests.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    name: 'cost-governor/node-esm',
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
  },
);
