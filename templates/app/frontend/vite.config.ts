import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/app/my-app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:8800',
    },
  },
})
