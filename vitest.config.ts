import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for RLS testing
 *
 * Uses Testcontainers to spin up real PostgreSQL instances
 * for accurate Row Level Security testing.
 */
export default defineConfig({
  test: {
    // Run tests sequentially to avoid port conflicts with Testcontainers
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Longer timeout for container startup
    testTimeout: 60000,
    hookTimeout: 60000,

    // Global setup/teardown (if needed)
    // globalSetup: './src/test/global-setup.ts',

    // Test file patterns
    include: ['src/**/*.test.ts'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        'src/scripts/**',
        'src/database/migrations/**',
      ],
    },

    // Environment
    environment: 'node',
  },
});
