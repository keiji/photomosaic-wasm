/**
 * WASM バインディング(生成物)の結合テスト。
 * handoff/02 検収基準: サンプル関数を JS から呼び出し、値が往復すること。
 *
 * 生成物(web/src/wasm/)が無い環境ではスキップする
 * (`npm run wasm:build` で再生成できる。CI ではビルド後に実行される)。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

  describe('メイン画像解析(P1)', () => {
    it('set_main_image で GridInfo とコア算出の平均色を取得できる', () => {
      // 2x2 の単色赤
      const rgba = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
      const info = wasm.set_main_image(rgba, 2, 2);
      try {
        expect(info.width).toBe(2);
        expect(info.height).toBe(2);
        expect(info.block_size).toBe(24);
        expect(info.cols).toBe(1);
        expect(info.rows).toBe(1);
        expect(info.total_blocks).toBe(1);
      } finally {
        info.free();
      }

      // 単色赤の平均色は赤そのもの(線形平均 → Lab → sRGB 逆変換の往復)
      const colors = wasm.get_block_mean_colors();
      expect(Array.from(colors)).toEqual([255, 0, 0]);
    });

    it('set_block_size でグリッドが再計算される', () => {
      const rgba = new Uint8Array(4 * 4 * 4); // 4x4 画像
      wasm.set_main_image(rgba, 4, 4);
      const info = wasm.set_block_size(2);
      try {
        expect(info.cols).toBe(2);
        expect(info.rows).toBe(2);
        expect(info.total_blocks).toBe(4);
      } finally {
        info.free();
      }
      // 4 ブロック分の平均色
      expect(wasm.get_block_mean_colors().length).toBe(4 * 3);
    });

    it('export_main_image が設定した RGBA を返す', () => {
      const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
      wasm.set_main_image(rgba, 2, 2);
      const exported = wasm.export_main_image();
      expect(Array.from(exported)).toEqual(Array.from(rgba));
    });

    it('clear_main_image 後はコア状態が空になる', () => {
      wasm.set_main_image(new Uint8Array(2 * 2 * 4), 2, 2);
      wasm.clear_main_image();
      expect(() => wasm.set_block_size(24)).toThrow();
      expect(wasm.get_block_mean_colors().length).toBe(0);
    });

    it('rgba 長さ不一致はエラーになる', () => {
      expect(() => wasm.set_main_image(new Uint8Array(3), 2, 2)).toThrow();
    });
  });

  describe('タイル取り込み(P2: handoff/04 M3)', () => {
    /** 単色の特徴量サムネイル(32×32)を生成する */
    const featureThumb = (r: number, g: number, b: number): Uint8Array => {
      const data = new Uint8Array(32 * 32 * 4);
      for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
      return data;
    };

    /** 単色の合成用サムネイルを生成する */
    const composeThumb = (w: number, h: number): Uint8Array => new Uint8Array(w * h * 4);

    afterEach(() => {
      wasm.clear_tiles();
    });

    it('add_tile でタイルが登録され、TileInfo が返る', () => {
      const info = wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 32), 64, 32);
      try {
        expect(info.id).toBe(1n);
        expect(info.thumb_w).toBe(64);
        expect(info.thumb_h).toBe(32);
        expect(info.usage).toBe(0);
        // 単色赤の CIELAB: L* ≈ 53.24(既知値、詳細設計書 11 章)
        const [l, a, b] = Array.from(info.mean_lab);
        expect(l).toBeCloseTo(53.24, 1);
        expect(a).toBeCloseTo(80.09, 1);
        expect(b).toBeCloseTo(67.2, 1);
        // 単色なので detail は 0
        expect(info.detail).toBeCloseTo(0, 4);
      } finally {
        info.free();
      }
      expect(wasm.get_tile_count()).toBe(1);
      expect(wasm.get_tiles_memory_bytes()).toBe(64 * 32 * 4);
    });

    it('同一 id の追加は置き換わり、メモリ量が二重計上されない', () => {
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64), 64, 64);
      wasm.add_tile(1n, featureThumb(0, 0, 255), composeThumb(32, 32), 32, 32);
      expect(wasm.get_tile_count()).toBe(1);
      expect(wasm.get_tiles_memory_bytes()).toBe(32 * 32 * 4);
    });

    it('remove_tile / clear_tiles / get_tile_count が連携する', () => {
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64), 64, 64);
      wasm.add_tile(2n, featureThumb(0, 255, 0), composeThumb(64, 64), 64, 64);
      expect(wasm.get_tile_count()).toBe(2);
      wasm.remove_tile(1n);
      expect(wasm.get_tile_count()).toBe(1);
      expect(wasm.get_tiles_memory_bytes()).toBe(64 * 64 * 4);
      wasm.clear_tiles();
      expect(wasm.get_tile_count()).toBe(0);
      expect(wasm.get_tiles_memory_bytes()).toBe(0);
    });

    it('存在しない id の remove_tile はエラーになる', () => {
      expect(() => wasm.remove_tile(999n)).toThrow(/unknown tile id/);
    });

    it('特徴量サムネイルの寸法が 32×32 以外ならエラーになる', () => {
      const wrong = new Uint8Array(31 * 31 * 4);
      expect(() => wasm.add_tile(1n, wrong, composeThumb(32, 32), 32, 32)).toThrow(
        /feature thumbnail/,
      );
      expect(wasm.get_tile_count()).toBe(0);
    });

    it('合成サムネイルの長辺 65(上限 64 超)はエラーになる', () => {
      expect(() => wasm.add_tile(1n, featureThumb(1, 2, 3), composeThumb(65, 1), 65, 1)).toThrow(
        /compose thumbnail/,
      );
      expect(wasm.get_tile_count()).toBe(0);
    });

    it('コントラスト付きタイルの detail が大きくなる', () => {
      const data = new Uint8Array(32 * 32 * 4);
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const v = x < 16 ? 0 : 255;
          const offset = (y * 32 + x) * 4;
          data[offset] = v;
          data[offset + 1] = v;
          data[offset + 2] = v;
          data[offset + 3] = 255;
        }
      }
      const info = wasm.add_tile(1n, data, composeThumb(32, 32), 32, 32);
      try {
        // 半々の明度反転 → L* の標準偏差は 50 前後
        expect(info.detail).toBeGreaterThan(40);
      } finally {
        info.free();
      }
    });

    it('300 枚のタイルを 1 枚あたり数 ms 未満で解析できる(M3 完了条件のリグレッション検知)', () => {
      // 完了条件(handoff/04 M3): 300 枚程度で UI が固まらず、1 枚あたり数 ms。
      // P2 の性能目標(300 枚 200ms 以内 = 約 0.67ms/枚)に対し、
      // 環境差を考慮した緩い上限(1 枚あたり 5ms)で検知する。
      const feature = featureThumb(120, 130, 140);
      const start = performance.now();
      for (let i = 0; i < 300; i++) {
        const info = wasm.add_tile(BigInt(i), feature, composeThumb(64, 64), 64, 64);
        info.free();
      }
      const perTileMs = (performance.now() - start) / 300;
      expect(wasm.get_tile_count()).toBe(300);
      expect(perTileMs).toBeLessThan(5);
    });
  });

  describe('一括生成(M4: P3 マッチング + P4 合成)', () => {
    const featureThumb = (r: number, g: number, b: number): Uint8Array => {
      const data = new Uint8Array(32 * 32 * 4);
      for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
      return data;
    };
    const composeThumb = (w: number, h: number, rgb: [number, number, number]): Uint8Array => {
      const data = new Uint8Array(w * h * 4);
      for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
        data[offset + 3] = 255;
      }
      return data;
    };

    afterEach(() => {
      wasm.clear_tiles();
      wasm.clear_main_image();
    });

    it('getConfig/setConfig が往復し、範囲外はエラーになる', () => {
      const config = JSON.parse(wasm.get_config()) as Record<string, number>;
      // f32 経由の丸め(0.7 → 0.6999999...)を許容して既定値を検証する
      const expected: Record<string, number> = {
        w_c: 1.0,
        w_d: 0.25,
        usage_penalty: 0.35,
        neighbor_penalty: 0.5,
        identical_de: 2.0,
        usage_cap: 4,
        color_correct: 0.7,
        row_batch: 8,
      };
      for (const [key, value] of Object.entries(expected)) {
        expect(config[key]).toBeCloseTo(value, 5);
      }

      wasm.set_config(JSON.stringify({ ...config, color_correct: 0.5, row_batch: 4 }));
      const updated = JSON.parse(wasm.get_config()) as Record<string, number>;
      expect(updated.color_correct).toBeCloseTo(0.5, 5);
      expect(updated.row_batch).toBe(4);

      // 復元: default へ戻す(後続テストは既定設定を前提とする)
      wasm.set_config(JSON.stringify(expected));
      const restored = JSON.parse(wasm.get_config()) as Record<string, number>;
      expect(restored.row_batch).toBe(8);

      expect(() => wasm.set_config(JSON.stringify({ ...config, color_correct: 1.5 }))).toThrow(
        /color_correct/,
      );
      // 失敗した set は既存設定(既定へ復元済み)を壊さない
      expect(JSON.parse(wasm.get_config()).color_correct).toBeCloseTo(0.7, 5);
      // 不正 JSON もエラー
      expect(() => wasm.set_config('{ invalid')).toThrow();
    });

    it('メイン画像とタイルからフォトモザイクを一括生成する', () => {
      // メイン: 48x24 の左半分赤・右半分青
      const main = new Uint8Array(48 * 24 * 4);
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 48; x++) {
          const offset = (y * 48 + x) * 4;
          const rgb: [number, number, number] = x < 24 ? [255, 0, 0] : [0, 0, 255];
          main[offset] = rgb[0];
          main[offset + 1] = rgb[1];
          main[offset + 2] = rgb[2];
          main[offset + 3] = 255;
        }
      }
      wasm.set_main_image(main, 48, 24);
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]), 64, 64);
      wasm.add_tile(2n, featureThumb(0, 0, 255), composeThumb(64, 64, [0, 0, 255]), 64, 64);

      wasm.run();

      const exported = wasm.export_main_image();
      expect(exported.length).toBe(48 * 24 * 4);
      // 全ピクセル不透明(白背景仕様)
      for (let offset = 3; offset < exported.length; offset += 4) {
        expect(exported[offset]).toBe(255);
      }
      // 左ブロックは赤系・右ブロックは青系のタイルが割り当てられている
      const red = exported[(12 * 48 + 12) * 4];
      const blue = exported[(12 * 48 + 36) * 4];
      expect(red).toBeGreaterThan(200);
      expect(blue).toBeLessThan(55);
    });

    it('タイルプール空での run はエラーになる(詳細設計書 6 章)', () => {
      const main = new Uint8Array(24 * 24 * 4);
      wasm.set_main_image(main, 24, 24);
      expect(() => wasm.run()).toThrow(/tile pool is empty/);
    });

    it('メイン画像未設定での run はエラーになる', () => {
      expect(() => wasm.run()).toThrow(/main image is not set/);
    });

    it('set_block_size 後は合成結果が無効化される(メイン画像へ戻る)', () => {
      const main = new Uint8Array(24 * 24 * 4);
      wasm.set_main_image(main, 24, 24);
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]), 64, 64);
      wasm.run();
      const composed = wasm.export_main_image();
      // 合成後は原画像(全 0)ではなく色補正済みのタイル描画になる
      // (α=0.7 → 赤タイルの R 成分が残り、G/B はゼロ除算ガードで 0 のまま)
      expect(composed.some((b) => b > 0)).toBe(true);

      wasm.set_block_size(12); // composed はクリア
      const exported = wasm.export_main_image();
      expect(Array.from(exported)).toEqual(Array.from(main));
    });
  });
});
