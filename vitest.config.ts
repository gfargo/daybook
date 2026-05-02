import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/dist/**', '**/*.test.ts'],
    },
  },
});
