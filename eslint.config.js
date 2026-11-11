import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.loopx/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['packages/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: '@sk/policy', importNames: ['approve', 'approvalToCardInput'], message: 'Only the approval service may approve or issue.' }],
        patterns: [{ group: ['@sk/policy/*', '**/policy/**', '@sk/app', '@sk/app/*', '**/app/**', '@sk/airwallex', '@sk/airwallex/*'], message: 'Agent authority is limited to submitting approval requests.' }],
      }],
    },
  },
);
