import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // In dev the game server runs separately; proxy websockets through Vite
      // so the client can always connect to its own origin.
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
  },
});
