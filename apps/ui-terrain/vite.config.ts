import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const proxyTarget = 'http://127.0.0.1:3000';

  return {
    plugins: [svelte()],
    server: {
      port: 4174,
      strictPort: true,
      proxy: isDev
        ? {
            '/socket.io': {
              target: proxyTarget,
              ws: true,
            },
            '/config': {
              target: proxyTarget,
              ws: true,
            },
            '/terrain': {
              target: proxyTarget,
              ws: true,
            },
          }
        : undefined,
    },
  };
});
