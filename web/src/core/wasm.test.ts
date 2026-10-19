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
      // f32 経由の丸め(0.85 → 0.8499999...)を許容して既定値を検証する
      const expected: Record<string, number> = {
        w_c: 1.0,
        w_d: 0.25,
        usage_penalty: 0.35,
        neighbor_penalty: 0.5,
        neighbor_de: 8.0,
        identical_de: 2.0,
        improve_margin: 1.0,
        duplicate_de: 2.0,
        duplicate_detail: 4.0,
        usage_cap: 4,
        color_correct: 0.85,
        main_blend: 0.2,
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
      expect(() => wasm.set_config(JSON.stringify({ ...config, improve_margin: 0.4 }))).toThrow(
        /improve_margin/,
      );
      expect(() => wasm.set_config(JSON.stringify({ ...config, duplicate_de: 0.4 }))).toThrow(
        /duplicate_de/,
      );
      expect(() => wasm.set_config(JSON.stringify({ ...config, duplicate_detail: 40 }))).toThrow(
        /duplicate_detail/,
      );
      expect(() => wasm.set_config(JSON.stringify({ ...config, main_blend: 0.9 }))).toThrow(
        /main_blend/,
      );
      expect(() => wasm.set_config(JSON.stringify({ ...config, neighbor_de: 1.5 }))).toThrow(
        /neighbor_de/,
      );
      // 失敗した set は既存設定(既定へ復元済み)を壊さない
      expect(JSON.parse(wasm.get_config()).color_correct).toBeCloseTo(0.85, 5);
      expect(JSON.parse(wasm.get_config()).improve_margin).toBeCloseTo(1.0, 5);
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

    it('main_blend でメイン画像を合成結果へブレンドする(詳細設計書 4.6)', () => {
      // メイン: グレー 127 の 1 ブロック / タイル: 赤。
      // ブレンド 0 では色補正済みタイル(R ≈ 127、G/B ≈ 0)、
      // ブレンド 0.8 では 0.2 * タイル + 0.8 * メイン(G/B ≈ 102)になる
      const main = new Uint8Array(24 * 24 * 4);
      for (let offset = 0; offset < main.length; offset += 4) {
        main[offset] = 127;
        main[offset + 1] = 127;
        main[offset + 2] = 127;
        main[offset + 3] = 255;
      }
      wasm.set_main_image(main, 24, 24);
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]), 64, 64);

      const center = (rgba: Uint8Array): { r: number; g: number } => ({
        r: rgba[(12 * 24 + 12) * 4] as number,
        g: rgba[(12 * 24 + 12) * 4 + 1] as number,
      });
      const saved = wasm.get_config();
      try {
        // ブレンド 0: 色補正のみ(メイン画像のグレーは混ざらない)
        wasm.set_config(JSON.stringify({ ...JSON.parse(saved), main_blend: 0.0 }));
        wasm.run();
        const noBlend = center(wasm.export_main_image());
        expect(noBlend.r).toBeGreaterThanOrEqual(120);
        expect(noBlend.g).toBeLessThan(5);

        // ブレンド 0.8 で再生成: メイン画像(グレー)が 8 割混ざる
        wasm.set_config(JSON.stringify({ ...JSON.parse(saved), main_blend: 0.8 }));
        wasm.run();
        const blended = center(wasm.export_main_image());
        // R: 0.2 * 127 + 0.8 * 127 = 127 / G: 0.2 * 0 + 0.8 * 127 = 102
        expect(blended.r).toBeGreaterThanOrEqual(120);
        expect(blended.g).toBeGreaterThanOrEqual(90);
        expect(blended.g).toBeLessThanOrEqual(115);
      } finally {
        wasm.set_config(saved);
      }
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
      // (α=0.85 → 赤タイルの R 成分が残り、G/B はゼロ除算ガードで 0 のまま)
      expect(composed.some((b) => b > 0)).toBe(true);

      wasm.set_block_size(12); // composed はクリア
      const exported = wasm.export_main_image();
      expect(Array.from(exported)).toEqual(Array.from(main));
    });
  });

  describe('差分再マッチ(M6: タイル追加・削除の追随)', () => {
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

    /** 左半分赤・右半分青のメイン画像(48x24 = 2x1 ブロック・block 24) */
    const redBlueMain = (): Uint8Array => {
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
      return main;
    };

    /** begin から step ループまで(rematch / run 由来を問わず)駆動する */
    const driveSteps = (): number => {
      let events = 0;
      let clock = 0;
      for (;;) {
        const out = wasm.step_run(++clock * 20);
        // take 系ゲッターは 1 回の参照で消費するため、まず変数へ受ける
        const done = out.done;
        const progress = out.progress;
        if (progress) {
          events += 1;
          progress.free();
        }
        const result = out.result;
        if (result) {
          result.free();
        }
        out.free();
        if (done) break;
      }
      return events;
    };

    afterEach(() => {
      wasm.clear_tiles();
      wasm.clear_main_image();
    });

    it('タイル追加後の rematch で差し替え評価が行われ、出力が追従する', () => {
      wasm.set_main_image(redBlueMain(), 48, 24);
      // 遠いタイルのみ(青系を欠く)
      wasm.add_tile(1n, featureThumb(40, 0, 0), composeThumb(64, 64, [40, 0, 0]), 64, 64);
      wasm.run();
      const before = wasm.export_main_image();

      // 青タイルを追加して差分再マッチ: 右ブロック(青)の割当が改善される
      wasm.add_tile(2n, featureThumb(0, 0, 255), composeThumb(64, 64, [0, 0, 255]), 64, 64);
      wasm.begin_rematch();
      driveSteps();

      const after = wasm.export_main_image();
      expect(after.length).toBe(before.length);
      // 出力が変化する(青ブロックの合成がタイル 2 で置き換わる)
      expect(Array.from(after)).not.toEqual(Array.from(before));
      // 右ブロックの中心が青系になる(追加タイルで差し替えられている)
      const blueCenter = after[(12 * 48 + 36) * 4];
      expect(blueCenter).toBeLessThan(55);
    });

    it('タイル削除後の rematch で該当ブロックが現プールで再割当てされる', () => {
      wasm.set_main_image(redBlueMain(), 48, 24);
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]), 64, 64);
      wasm.add_tile(2n, featureThumb(0, 0, 255), composeThumb(64, 64, [0, 0, 255]), 64, 64);
      wasm.run();
      const before = wasm.export_main_image();
      const blueCenterBefore = before[(12 * 48 + 36) * 4];
      expect(blueCenterBefore).toBeLessThan(55);

      // 青タイルを削除 → 差分再マッチ: 右ブロックは残ったタイル 1 で再割当てされる
      wasm.remove_tile(2n);
      wasm.begin_rematch();
      driveSteps();
      const after = wasm.export_main_image();
      // 出力は変化する(右ブロックが再合成される)
      expect(Array.from(after)).not.toEqual(Array.from(before));
      // 参照検証: 現プール(タイル 1 のみ)でのフル run の出力と一致する
      // (α=0.85 の色補正で各ブロックのトーンは保有されるため、block 単位の
      // 色の直接比較ではなく決定的な参照出力で確認する)
      wasm.clear_tiles();
      wasm.set_main_image(redBlueMain(), 48, 24);
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]), 64, 64);
      wasm.run();
      const reference = wasm.export_main_image();
      expect(Array.from(after)).toEqual(Array.from(reference));
    });

    it('差分再マッチの開始時に使用回数が現割当表から再集計される(回帰: ペナルティの連続性)', () => {
      // 詳細設計書 4.4「使用回数 usage は再マッチ後に現割当表から再集計する。
      // ペナルティの連続性を保つ」の回帰テスト。begin_rematch が再集計に空の
      // 割当表を渡すと差分再マッチのたびに usage がゼロリセットされ、使用
      // ペナルティが効かなくなる(同じタイルが選ばれ続ける)。
      //
      // 条件(決定的): 上 4 行 12 ブロックは明るいグレー(A)、下 1 行 3 ブロックは
      // 暗いグレー(B)。タイル 1(A から ΔE 約 2.5)は初回ランで A の 12 ブロック
      // すべてに選ばれる(タイル 3 は A から ΔE 約 8.7)。B に対しては t1(ΔE 約
      // 2.7)が t3(ΔE 約 3.5)より近い → usage がゼロリセットなら B も t1 が
      // 選ばれる。現割当表から再集計(u1 = 12 → ペナルティ 4.2)されていれば
      // B は t3 が選ばれる(下段が緑になる)
      const grayThumb = (v: number): Uint8Array => {
        const data = new Uint8Array(32 * 32 * 4);
        for (let offset = 0; offset < data.length; offset += 4) {
          data[offset] = v;
          data[offset + 1] = v;
          data[offset + 2] = v;
          data[offset + 3] = 255;
        }
        return data;
      };
      /** グレー v 基調で black/256 の画素を黒に混ぜた特徴量サムネイル(L* を下げる) */
      const mixedThumb = (v: number, black: number): Uint8Array => {
        const data = grayThumb(v);
        for (let i = 0; i < 32 * 32; i++) {
          if (i % 256 < black) {
            data[i * 4] = 0;
            data[i * 4 + 1] = 0;
            data[i * 4 + 2] = 0;
          }
        }
        return data;
      };
      /** 上 96px 行が sRGB 127・下 24px 行が sRGB 114 の 72x120 メイン画像 */
      const twoToneMain = (): Uint8Array => {
        const data = new Uint8Array(72 * 120 * 4);
        for (let y = 0; y < 120; y++) {
          const v = y < 96 ? 127 : 114;
          for (let x = 0; x < 72; x++) {
            const offset = (y * 72 + x) * 4;
            data[offset] = v;
            data[offset + 1] = v;
            data[offset + 2] = v;
            data[offset + 3] = 255;
          }
        }
        return data;
      };
      const at = (rgba: Uint8Array, x: number, y: number) => rgba[(y * 72 + x) * 4];
      const atG = (rgba: Uint8Array, x: number, y: number) => rgba[(y * 72 + x) * 4 + 1];

      const saved = wasm.get_config();
      try {
        // 5 ブロック行を 4+1 に分ける(row_batch=4)。1 バッチ目でマッチを止めて
        // 差分再マッチ(FillUnmatched)を発生させる
        wasm.set_config(JSON.stringify({ ...JSON.parse(saved), row_batch: 4 }));
        wasm.set_main_image(twoToneMain(), 72, 120);
        // t1: A から ΔE 約 2.5 / B から約 2.7(赤で描く)。t3: A から約 8.7 /
        // B から約 3.5(緑で描く)。両者は ΔE 約 6.2 で別グループ
        wasm.add_tile(1n, mixedThumb(127, 27), composeThumb(64, 64, [200, 60, 60]), 64, 64);
        wasm.add_tile(3n, mixedThumb(127, 85), composeThumb(64, 64, [60, 200, 60]), 64, 64);

        wasm.begin_run();
        const first = wasm.step_run(20);
        const firstDone = first.done;
        first.free();
        expect(firstDone).toBe(false); // 1 バッチ目(上 4 行)のみマッチ済み

        wasm.cancel();
        wasm.begin_rematch();
        driveSteps();

        // 下段(未確定だった 3 ブロック): 再集計された使用ペナルティで t3 が
        // 選ばれる(ゼロリセットされていれば t1 の赤になる)
        const composed = wasm.export_main_image();
        expect(atG(composed, 12, 108)).toBeGreaterThan(150); // 緑
        expect(at(composed, 12, 108)).toBeLessThan(100);
        expect(atG(composed, 60, 108)).toBeGreaterThan(150);
        expect(atG(composed, 12, 116)).toBeGreaterThan(150);
      } finally {
        // 後続テストは既定設定を前提とするため復元する
        wasm.set_config(saved);
      }
    });

    it('再マッチ不要な rematch(import なし・未確定なし)は即時に完了する', () => {
      wasm.set_main_image(redBlueMain(), 48, 24);
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]), 64, 64);
      wasm.run();
      const before = Array.from(wasm.export_main_image());

      wasm.begin_rematch();
      // 2 ブロックは 1 バッチで走査が完了し、合成対象なしで即時完了する
      let steps = 0;
      for (;;) {
        const out = wasm.step_run(++steps * 20);
        const done = out.done;
        const progress = out.progress;
        if (progress) {
          progress.free();
        }
        const result = out.result;
        if (result) {
          result.free();
        }
        out.free();
        if (done) break;
      }
      expect(steps).toBeLessThanOrEqual(2);
      // 合成結果は変化しない
      expect(Array.from(wasm.export_main_image())).toEqual(before);
    });

    it('タイルプール空での begin_rematch はエラーになる', () => {
      wasm.set_main_image(redBlueMain(), 48, 24);
      expect(() => wasm.begin_rematch()).toThrow(/tile pool is empty/);
    });

    it('set_block_size 後の rematch は全ブロックを再マッチする(フル扱い)', () => {
      wasm.set_main_image(redBlueMain(), 48, 24);
      wasm.add_tile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]), 64, 64);
      wasm.add_tile(2n, featureThumb(0, 0, 255), composeThumb(64, 64, [0, 0, 255]), 64, 64);
      wasm.run();
      wasm.set_block_size(12); // 4x2 ブロック・割当表クリア
      wasm.begin_rematch();
      const events = driveSteps();
      // フルマッチと同一の進捗が流れる(最後に合成フェーズへ到達する)
      expect(events).toBeGreaterThan(0);
      // 完成画像が得られる(全ブロック確定)
      const exported = wasm.export_main_image();
      expect(exported.length).toBe(48 * 24 * 4);
    });
  });

  describe('行バッチ実行(M5: 進捗・部分結果・キャンセル)', () => {
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

    /** 左半分黒・右半分白の合成用サムネイル(扱いやすいコントラスト付き) */
    const composeThumb = (w: number, h: number): Uint8Array => new Uint8Array(w * h * 4);

    /** ブロックインデックス i に応じて色が変わるメイン画像を生成する */
    const patternMain = (width: number, height: number): Uint8Array => {
      const main = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          const v = ((x * 7 + y * 13) % 256) as number;
          main[offset] = v;
          main[offset + 1] = v;
          main[offset + 2] = v;
          main[offset + 3] = 255;
        }
      }
      return main;
    };

    afterEach(() => {
      wasm.clear_tiles();
      wasm.clear_main_image();
    });

    it('begin_run / step_run で進捗と部分結果が逐次得られ、完了後に export できる', () => {
      // メイン 96x768(ブロック行 32)/ block 24 → 4x32、row_batch 8 は既定
      const width = 96;
      const height = 768;
      wasm.set_main_image(patternMain(width, height), width, height);
      wasm.add_tile(1n, featureThumb(120, 120, 120), composeThumb(64, 64), 64, 64);

      wasm.begin_run();

      const events: wasm.JsProgressEvent[] = [];
      const batches: wasm.JsResultBatch[] = [];
      let clock = 0;
      for (;;) {
        const out = wasm.step_run(++clock * 20);
        // 取り出し系 getter(take)は 1 回の実行で消費するため、まず変数へ受ける
        const progress = out.progress;
        if (progress) events.push(progress);
        const result = out.result;
        if (result) batches.push(result);
        const done = out.done;
        out.free();
        if (done) break;
      }

      // 進捗: マッチング→合成の両フェーズを経由し、最終イベントは 100%
      expect(events.length).toBeGreaterThan(0);
      const phases = new Set(events.map((e) => e.phase_code));
      expect(phases.has('match')).toBe(true);
      expect(phases.has('compose')).toBe(true);
      const last = events[events.length - 1];
      if (!last) return;
      expect(last.assigned_blocks).toBe(4 * 32);
      expect(last.overall_ratio).toBeCloseTo(1.0, 5);
      // 割当済みブロック数は単調増加
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const current = events[i];
        if (!prev || !current) {
          continue;
        }
        expect(current.assigned_blocks).toBeGreaterThanOrEqual(prev.assigned_blocks);
      }
      events.forEach((e) => e.free());

      // 部分結果: 行バッチが行番号昇順で、結合すると export と一致する
      expect(batches.length).toBe(4); // 32 行 / 8 行
      let begin = 0;
      for (const batch of batches) {
        expect(batch.row_begin).toBe(begin);
        begin = batch.row_end;
        expect(batch.block_size).toBe(24);
        expect(batch.width).toBe(width);
        expect(batch.rgba.length).toBe(width * (batch.row_end - batch.row_begin) * 24 * 4);
      }
      expect(begin).toBe(32);

      const exported = wasm.export_main_image();
      expect(exported.length).toBe(width * height * 4);
      let offset = 0;
      for (const batch of batches) {
        for (const byte of batch.rgba) {
          expect(exported[offset]).toBe(byte);
          offset += 1;
        }
        batch.free();
      }
      expect(offset).toBe(exported.length);
    });

    it('cancel はバッチ境界で効き、以降の step はエラーになる', () => {
      // メイン 96x384(ブロック行 16)→ row_batch 8 で 2 バッチ以上ある
      const width = 96;
      const height = 384;
      const main = patternMain(width, height);
      wasm.set_main_image(main, width, height);
      wasm.add_tile(1n, featureThumb(120, 120, 120), composeThumb(64, 64), 64, 64);

      wasm.begin_run();
      wasm.step_run(0);
      wasm.step_run(20);
      wasm.cancel();
      // 以降の step はエラー(呼び出し側はループを停止する)
      expect(() => wasm.step_run(40)).toThrow(/run is not started/);
    });

    it('step_run は run 開始前にはエラーになる', () => {
      // main image 未設定環境では先にそちらのエラーになるため、双方を受け付ける
      expect(() => wasm.step_run(0)).toThrow(/run is not started|main image is not set/);
    });

    it('メイン画像未設定・プール空の begin_run はエラーになる', () => {
      expect(() => wasm.begin_run()).toThrow(/main image is not set/);
      wasm.set_main_image(patternMain(24, 24), 24, 24);
      expect(() => wasm.begin_run()).toThrow(/tile pool is empty/);
    });
  });

  describe('メトリクス(M7: getMetrics・計測の常時化)', () => {
    afterEach(() => {
      wasm.clear_tiles();
      wasm.clear_main_image();
    });

    it('run の完了後、フェーズ別の所要・スパン・メモリを JSON で返す', () => {
      const main = new Uint8Array(48 * 24 * 4);
      wasm.set_main_image(main, 48, 24);
      const mk = (value: number): Uint8Array => {
        const d = new Uint8Array(32 * 32 * 4);
        for (let o = 0; o < d.length; o += 4) {
          d[o] = value;
          d[o + 1] = value;
          d[o + 2] = value;
          d[o + 3] = 255;
        }
        return d;
      };
      wasm.add_tile(1n, mk(200), new Uint8Array(64 * 64 * 4), 64, 64);
      wasm.run();

      const metrics = JSON.parse(wasm.get_metrics()) as {
        core_version: string;
        runs: Array<{
          run_id: number;
          trigger: string;
          started_at_ms: number;
          phases: Record<string, { ms: number; tiles?: number; batches?: number }>;
          spans: Record<string, { count: number; avg_ms: number; max_ms: number }>;
          memory: { tiles_bytes: number };
          config: { block_size: number };
        }>;
      };
      expect(metrics.core_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(metrics.runs.length).toBeGreaterThan(0);
      const run = metrics.runs[metrics.runs.length - 1];
      if (!run || !run.phases) return;
      const phases = run.phases;
      expect(run.trigger).toBe('tile_added');
      // フェーズ欄(handoff/05 §4 スキーマ)
      expect(phases.P1_MAIN_ANALYZE?.ms).toBeGreaterThanOrEqual(0);
      expect(phases.P2_TILE_ANALYZE?.tiles).toBe(1);
      expect(phases.P3_MATCH?.batches).toBeGreaterThan(0);
      expect(phases.P4_COMPOSE?.batches).toBeGreaterThan(0);
      // スパン欄(バッチ境界の計測点)
      const matchBatch = run.spans.p3_match_batch;
      if (matchBatch) {
        expect(matchBatch.count).toBeGreaterThan(0);
        expect(matchBatch.max_ms).toBeGreaterThanOrEqual(0);
      }
      // メモリ欄(合成サムネイル 64×64 × 1 枚)
      expect(run.memory.tiles_bytes).toBe(64 * 64 * 4);
      expect(run.config.block_size).toBe(24);
    });

    it('get_metrics は JSON として常にパースできる(共有モジュール内の履歴を含む)', () => {
      // 同一 wasm モジュールはテスト群で共有されるため、履歴に既存 run が
      // 入りうる。スキーマ構造(JSON 正常解析・必須欄)の成立のみを確認する
      const metrics = JSON.parse(wasm.get_metrics()) as {
        core_version: string;
        runs: Array<{ run_id: number; trigger: string }>;
      };
      expect(Array.isArray(metrics.runs)).toBe(true);
      for (const run of metrics.runs) {
        expect(run.run_id).toBeGreaterThan(0);
        expect(run.trigger.length).toBeGreaterThan(0);
      }
    });
  });
});
