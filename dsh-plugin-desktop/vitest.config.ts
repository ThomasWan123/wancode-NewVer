import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@wancode/relay-protocol': fileURLToPath(
        new URL('../packages/wancode/relay-protocol/src/index.ts', import.meta.url),
      ),
      '@wancode/harness-kernel': fileURLToPath(
        new URL('../packages/wancode/harness-kernel/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
