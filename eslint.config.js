// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // `.claude/` holds the linked worktrees an agent session creates in this repository. Each one is
  // a full checkout, so linting `.` would type-check the sources of the repository once per
  // worktree and exhaust the heap. The files of a worktree are linted by the gate run inside it.
  globalIgnores(['node_modules/', 'dist/', 'coverage/', '.claude/']),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'module' },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // NestJS modules are decorated classes with no instance members.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  prettier,
]);
