import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages などサブディレクトリに置いても動くように相対パスにする
  base: './',
  // poly2tri（屋根の三角形分割）は Node の `global` を参照するので、ブラウザの globalThis に置き換える
  define: { global: 'globalThis' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
