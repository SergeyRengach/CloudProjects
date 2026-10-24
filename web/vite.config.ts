import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (GitHub Pages) and as an iPad PWA.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
