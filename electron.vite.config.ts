import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const sharedDir = resolve(__dirname, 'src/shared')
const rendererDir = resolve(__dirname, 'src/renderer')
const variablesFile = resolve(rendererDir, 'src/assets/styles/variables.scss').replace(/\\/g, '/')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': sharedDir
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': sharedDir
      }
    }
  },
  renderer: {
    root: rendererDir,
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
