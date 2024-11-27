import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';
import 'eslint-import-resolver-typescript';
export default tseslint.config(
  {
    ignores: ['**/src/*.cjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  importPlugin.flatConfigs.recommended,
  {
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
      'import/no-named-as-default': ['off'],
      'import/order': [
        'error',
        {
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
          groups: [
            'type',
            'builtin',
            'external',
            'internal',
            'index',
            'sibling',
            'parent',
            'object',
          ],
        },
      ],
    },
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },

      'import/resolver': {
        typescript: {
          alwaysTryTypes: true, // always try to resolve types under `<root>@types` directory even it doesn't contain any source code, like `@types/unist`

          project: ['tsconfig.json'],
        },
      },
    },
  },
  prettierConfig,
);
