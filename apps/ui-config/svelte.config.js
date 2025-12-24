import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  compilerOptions: {
    compatibility: {
      componentApi: 5,
    },
  },
  preprocess: vitePreprocess(),
};
