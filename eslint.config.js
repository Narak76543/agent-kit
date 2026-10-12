import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/next-env.d.ts',
      'packages/templates/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // noUncheckedIndexedAccess makes regex groups `string | undefined`; `!` after a match is intended.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Core is a library: all output goes through logger.ts so tokens are always redacted.
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/logger.ts', '**/*.test.ts'],
    rules: { 'no-console': 'error' },
  },
  prettier,
);
