// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // Only an object with nothing but `ignores` (and `name`) is a global
    // ignore. Adding any other key turns it into a per-object exclusion.
    name: 'kit/ignore-build-output',
    ignores: ['dist/**', 'coverage/**'],
  },
  {
    name: 'kit/linter-controls',
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    name: 'kit/typescript',
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    name: 'kit/async-test-doubles',
    files: ['src/**/*.test.ts', 'test/**/*.ts'],
    rules: {
      // In-memory doubles implement async interfaces on purpose.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    name: 'kit/node-esm-scripts',
    files: ['scripts/**/*.mjs', 'examples/**/*.mjs', 'eslint.config.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
  },
  {
    // consumer-probe.mts imports the package by name, which only resolves in
    // the temporary consumer project. verify-package.mjs type-checks it there.
    name: 'kit/type-probe-script',
    files: ['scripts/**/*.mts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
  },
  {
    name: 'kit/browser-observatory',
    files: ['examples/observatory/app.mjs', 'examples/observatory/lib/**/*.mjs'],
    languageOptions: { globals: globals.browser },
    rules: { 'no-restricted-imports': ['error', { patterns: ['node:*'] }] },
  },
  {
    // These Node harnesses pass functions to the browser's execution context.
    name: 'kit/browser-context-harnesses',
    files: ['examples/observatory/tools/verify-browser.mjs', 'examples/observatory/tools/capture-showcase.mjs', 'examples/observatory/tools/measure-render.mjs'],
    languageOptions: { globals: globals.browser },
  },
);
