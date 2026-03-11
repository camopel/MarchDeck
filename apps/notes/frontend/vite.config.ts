import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/app/notes/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    proxy: {
      '/api': 'http://localhost:8800',
    },
  },
})
