import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
 
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ghapi': {
        target: 'https://api.github.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ghapi/, ''),
        headers: {
          'User-Agent': 'governance-hub-dev'
        }
      }
    }
  }
})