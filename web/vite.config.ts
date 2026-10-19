import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages のプロジェクトページ(https://keiji.github.io/photomosaic-wasm/)用。
  // ローカル開発も同じパスで配信される。
  base: '/photomosaic-wasm/',
  // M0 ではロジック(純関数)のみテストする。DOM 依存の描画は手動確認 + M1 以降に拡充
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
