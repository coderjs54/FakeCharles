import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
).version

export default defineConfig({
  // 与 electron.vite.config.ts 保持一致，让单测环境也能拿到构建时注入的版本号
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion)
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
