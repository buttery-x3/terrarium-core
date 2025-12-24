import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const proxyTarget = 'http://localhost:3000';

  return {
    plugins: [svelte()],
    server: {
      port: 4174,
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
