import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'evidence/', 'evidence-archive/', 'reports/', 'data/', '.candidates/', '.review-tmp/', 'test-results/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty-pattern': 'off',
    },
  },
);
