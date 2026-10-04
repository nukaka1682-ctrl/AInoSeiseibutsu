import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages などサブディレクトリに置いても動くように相対パスにする
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
