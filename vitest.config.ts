import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against core's source, so no build is needed first.
    alias: {
      '@tossana/agents-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test-helper.ts', '**/index.ts'],
      thresholds: {
        // The plan requires full coverage of the Done guard and the comment protocol.
        'packages/core/src/clickup/guard.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'packages/core/src/protocol.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
