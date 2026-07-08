import { defineConfig } from 'vitest/config'

// Test config lives here instead of inside `vite.config.ts` because vitest
// bundles its own copy of vite, and mixing the two `Plugin` types in a single
// `defineConfig` causes TS2769 during `tsc -b`. `vitest run` will prefer
// `vitest.config.ts` over `vite.config.ts` automatically.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
