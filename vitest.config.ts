import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: [
        '**/dist/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/node_modules/**',
        '.www/**',
        'docs/**',
      ],
    },
  },
});
