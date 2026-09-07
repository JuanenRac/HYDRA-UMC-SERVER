// =============================================================================
// HYDRA-UMC SERVER - Admin UI Vite Bundler Configuration: vite.config.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Served from this server's own /admin path (see server.ts's own
  // express.static(adminPublicPath, ...) mount under that prefix) - every
  // asset URL Vite emits needs the same prefix baked in, or the browser
  // requests them from "/" (STUDIO's own mount) instead and 404s.
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    // Same dev-time proxy strategy as HYDRA-UMC-STUDIO's own vite.config.ts
    // (see that file's own comment) - every fetch in src/ stays a relative
    // '/api/...' path, forwarded here to the real backend on localhost:3000.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
