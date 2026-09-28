// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // varsIgnorePattern (not just argsIgnorePattern) — needed for the
      // "discard one field via destructuring, keep the rest" pattern (e.g.
      // auctions/repository.ts stripping an internal `notifications` field
      // off a transaction-local result type before returning the public
      // one) — TypeScript has no nameless-discard destructuring syntax, so
      // the discarded binding needs a name, and `_`-prefix is this
      // codebase's existing convention for "intentionally unused."
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'jest.config.js'],
  },
);
