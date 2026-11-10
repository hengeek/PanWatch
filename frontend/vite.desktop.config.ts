import { defineConfig, mergeConfig } from 'vite'
import path from 'node:path'
import baseConfig from './vite.config'

export default defineConfig(mergeConfig(baseConfig, {
  base: './',
  build: {
    outDir: 'dist-desktop',
    emptyOutDir: true,
    rollupOptions: {
      input: { desktop: path.resolve(__dirname, 'desktop.html') },
    },
  },
}))
