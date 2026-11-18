import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const sharedDir = resolve(__dirname, 'src/shared')
const rendererDir = resolve(__dirname, 'src/renderer')
const variablesFile = resolve(rendererDir, 'src/assets/styles/variables.scss').replace(/\\/g, '/')

// 版本号统一来自 package.json，构建时注入，避免代码里再维护一份硬编码
const packageVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string })
  .version
const sharedDefine = {
  __APP_VERSION__: JSON.stringify(packageVersion)
}

export default defineConfig({
  main: {
    define: sharedDefine,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': sharedDir
      }
    }
  },
  preload: {
    define: sharedDefine,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': sharedDir
      }
    }
  },
  renderer: {
    root: rendererDir,
    define: sharedDefine,
    resolve: {
      alias: {
        '@renderer': resolve(rendererDir, 'src'),
        '@shared': sharedDir
      }
    },
    plugins: [vue()],
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: `@use "${variablesFile}" as *;\n`
        }
      }
    },
    build: {
      rollupOptions: {
        input: resolve(rendererDir, 'index.html')
      }
    }
  }
})
