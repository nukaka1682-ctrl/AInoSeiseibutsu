import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages などサブディレクトリに置いても動くように相対パスにする
  base: './',
  // node_modules をほかの作業ツリーと共有しても、事前バンドルのキャッシュはこの作業ツリーの中に置く（同時に動かすと壊れる）
  cacheDir: '.vite-cache',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
