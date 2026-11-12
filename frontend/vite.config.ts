import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  // 后端端口跟随仓库根目录 .env 的 PORT（默认 8000），避免前后端端口不一致
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const apiPort = rootEnv.PORT || process.env.PORT || '8000'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@panwatch/api': path.resolve(__dirname, './packages/api/src'),
        '@panwatch/base-ui': path.resolve(__dirname, './packages/base-ui/src'),
        '@panwatch/biz-ui': path.resolve(__dirname, './packages/biz-ui/src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5183,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  }
})
