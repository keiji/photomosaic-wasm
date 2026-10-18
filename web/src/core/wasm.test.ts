/**
 * WASM バインディング(生成物)の結合テスト。
 * handoff/02 検収基準: サンプル関数を JS から呼び出し、値が往復すること。
 *
 * 生成物(web/src/wasm/)が無い環境ではスキップする
 * (`npm run wasm:build` で再生成できる。CI ではビルド後に実行される)。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import * as wasm from '../wasm/photomosaic_core_wasm.js';

const wasmBinaryUrl = new URL('../wasm/photomosaic_core_wasm_bg.wasm', import.meta.url);
const hasWasmBinary = existsSync(wasmBinaryUrl);

describe.skipIf(!hasWasmBinary)('WASM バインディング(core-wasm 生成物)', () => {
  beforeAll(async () => {
    // node 環境では file URL を fetch できないため、バイト列から直接初期化する
    const bytes = await readFile(wasmBinaryUrl);
    await wasm.default(new Uint8Array(bytes));
  });

  it('get_version がコアバージョンを返す(UI とコアの整合確認用)', () => {
    const version = wasm.get_version();
    expect(version).toMatch(/^photomosaic-core \d+\.\d+\.\d+$/);
  });

  it('add が値を往復する(サンプル関数)', () => {
    expect(wasm.add(2, 3)).toBe(5);
    expect(wasm.add(-1, 1)).toBe(0);
  });

  it('tick はスロットル規則(16ms / 1%)に従う', () => {
    const demo = new wasm.ProgressDemo(1000);
    try {
      // 初回は即発火
      expect(demo.tick(0, 0)).toBeDefined();
      // 8ms 経過・0.5% 変化 → 抑制
      expect(demo.tick(8, 0.005)).toBeUndefined();
      // 合計 16ms 経過 → 時間条件で発火
      const event = demo.tick(16, 0.008);
      expect(event).toBeDefined();
      expect(event?.total_blocks).toBe(1000);
      expect(event?.phase_code).toBe('match');
      expect(event?.assigned_blocks).toBe(8);
    } finally {
      demo.free();
    }
  });

  it('tick は 1% 以上の変化なら時間が短くても発火する', () => {
    const demo = new wasm.ProgressDemo(1000);
    try {
      expect(demo.tick(0, 0)).toBeDefined();
      const event = demo.tick(1, 0.02);
      expect(event).toBeDefined();
      expect(event?.assigned_blocks).toBe(20);
    } finally {
      demo.free();
    }
  });

  it('範囲外の ratio では発火しない', () => {
    const demo = new wasm.ProgressDemo(1000);
    try {
      expect(demo.tick(0, -0.5)).toBeUndefined();
      expect(demo.tick(0, 1.5)).toBeUndefined();
    } finally {
      demo.free();
    }
  });

  it('overall_ratio は固定配分で計算される(P3 前に P1/P2 で 30% 進む)', () => {
    const demo = new wasm.ProgressDemo(1000);
    try {
      // P1(10%) + P2(20%) を完了し、P3 が始まった時点
      const event = demo.tick(0, 0);
      expect(event?.overall_ratio).toBeCloseTo(0.3, 5);
    } finally {
      demo.free();
    }
  });
});
