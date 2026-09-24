import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on IPv4 + IPv6 so localhost works in every browser (and phones on the LAN)
    port: parseInt(process.env.PORT) || 5190,
    strictPort: false,
    proxy: {
      '/api': 'http://localhost:4200',
      '/uploads': 'http://localhost:4200'
    }
  },
  build: { outDir: '../dist', emptyOutDir: true }
});
