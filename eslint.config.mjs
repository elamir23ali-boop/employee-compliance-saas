// E1 deviation from the originally-specified `.eslintrc.js`: `eslint@latest`
// resolves to ESLint 9+, whose default (and, from v10, only) config format is
// flat config -- `.eslintrc.js` requires opting back into the legacy system.
// This file achieves the same intent (typescript-eslint strict rules,
// eslint-plugin-security, Prettier integration) via flat config instead.
// See docs/architecture/decisions.md (ADR-014).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**', '**/test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // NEVER pass user input to sql.identifier() or other dynamic-SQL
      // identifier APIs (CLAUDE.md). No dedicated lint rule exists for this
      // Drizzle-specific API, so it's enforced by code review + this comment.
      'security/detect-non-literal-fs-filename': 'off',
      // NestJS modules/services are marker classes driven entirely by
      // decorators (@Module, @Injectable, @Global) -- an "empty" class here
      // is the idiomatic, correct pattern, not dead code.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Plain Node.js CommonJS scripts (bootstrap/tooling, not app source) --
    // e.g. infra/postgres/migrate.js, run directly via `node`, not bundled.
    files: ['infra/**/*.js'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  eslintConfigPrettier,
);
