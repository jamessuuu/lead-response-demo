import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'scripts/**/*.test.ts',
      'worker/test/**/*.test.ts',
    ],
    environment: 'node',
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/junit.xml' },
  },
});
