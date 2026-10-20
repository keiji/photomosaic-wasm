/**
 * 純 TypeScript コアと WASM コアのパリティテスト。
 * 同じ入力に対して P1/P2/P3/P4 の結果が一致することを確認する。
 *
 * WASM 生成物が無い環境ではスキップする(`npm run wasm:build` で再生成)。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as wasm from '../wasm/photomosaic_core_wasm.js';
import { createJsCore } from './jsCore';
import type { RgbaImage } from './types';

const wasmBinaryUrl = new URL('../wasm/photomosaic_core_wasm_bg.wasm', import.meta.url);
const hasWasmBinary = existsSync(wasmBinaryUrl);

const featureThumb = (r: number, g: number, b: number): RgbaImage => {
  const data = new Uint8ClampedArray(32 * 32 * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }
  return { width: 32, height: 32, data };
};

const composeThumb = (w: number, h: number, rgb: [number, number, number]): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
  }
  return { width: w, height: h, data };
};

const patternMain = (width: number, height: number): RgbaImage => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 7 + y * 13) % 256;
      data[offset + 1] = (x * 5 + y * 11 + 64) % 256;
      data[offset + 2] = (x * 3 + y * 17 + 128) % 256;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
};

const redBlueMain = (): RgbaImage => {
  const width = 48;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const rgb: [number, number, number] = x < 24 ? [255, 0, 0] : [0, 0, 255];
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
};

const toWasmBytes = (data: Uint8ClampedArray): Uint8Array =>
  new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const clearWasm = (): void => {
  wasm.clear_tiles();
  wasm.clear_main_image();
};

describe.skipIf(!hasWasmBinary)('純 TypeScript コアと WASM コアのパリティ', () => {
  beforeAll(async () => {
    const bytes = await readFile(wasmBinaryUrl);
    await wasm.default(new Uint8Array(bytes));
  });

  afterEach(() => {
    clearWasm();
  });

  it('P1: グリッドとブロック平均色が一致する', async () => {
    const image = patternMain(32, 32);
    const wasmInfo = wasm.set_main_image(toWasmBytes(image.data), 32, 32);
    const jsCore = createJsCore();
    const jsInfo = await jsCore.setMainImage(image);
    try {
      expect({
        width: wasmInfo.width,
        height: wasmInfo.height,
        block_size: wasmInfo.block_size,
        cols: wasmInfo.cols,
        rows: wasmInfo.rows,
        total_blocks: wasmInfo.total_blocks,
      }).toEqual({
        width: jsInfo.width,
        height: jsInfo.height,
        block_size: jsInfo.blockSize,
        cols: jsInfo.cols,
        rows: jsInfo.rows,
        total_blocks: jsInfo.totalBlocks,
      });
    } finally {
      wasmInfo.free();
    }
    expect(Array.from(jsCore.getBlockMeanColors())).toEqual(
      Array.from(wasm.get_block_mean_colors()),
    );
  });

  it('P2: タイル特徴量が一致する', async () => {
    const feature = featureThumb(200, 130, 60);
    const compose = composeThumb(64, 32, [200, 130, 60]);
    const wasmInfo = wasm.add_tile(
      1n,
      toWasmBytes(feature.data),
      toWasmBytes(compose.data),
      64,
      32,
    );
    const jsCore = createJsCore();
    const jsInfo = await jsCore.addTile(1n, feature, compose);
    try {
      expect(jsInfo.id).toBe(wasmInfo.id);
      expect(jsInfo.thumbWidth).toBe(wasmInfo.thumb_w);
      expect(jsInfo.thumbHeight).toBe(wasmInfo.thumb_h);
      for (let i = 0; i < 3; i++) {
        expect(jsInfo.meanLab[i]).toBeCloseTo(wasmInfo.mean_lab[i] as number, 6);
      }
      expect(jsInfo.detail).toBeCloseTo(wasmInfo.detail, 6);
      expect(jsInfo.usage).toBe(wasmInfo.usage);
    } finally {
      wasmInfo.free();
    }
    expect(jsCore.getTilesMemoryBytes()).toBe(wasm.get_tiles_memory_bytes());
  });

  it('P3/P4: フル生成の出力 RGBA が一致する', async () => {
    const main = redBlueMain();
    const redFeature = featureThumb(255, 0, 0);
    const redCompose = composeThumb(64, 64, [255, 0, 0]);
    const blueFeature = featureThumb(0, 0, 255);
    const blueCompose = composeThumb(64, 64, [0, 0, 255]);

    wasm.set_main_image(toWasmBytes(main.data), main.width, main.height);
    wasm.add_tile(1n, toWasmBytes(redFeature.data), toWasmBytes(redCompose.data), 64, 64);
    wasm.add_tile(2n, toWasmBytes(blueFeature.data), toWasmBytes(blueCompose.data), 64, 64);
    wasm.run();
    const wasmOutput = wasm.export_main_image();

    const jsCore = createJsCore();
    await jsCore.setMainImage(main);
    await jsCore.addTile(1n, redFeature, redCompose);
    await jsCore.addTile(2n, blueFeature, blueCompose);
    await jsCore.run();
    const jsOutput = await jsCore.exportImage();

    expect(jsOutput.width).toBe(48);
    expect(jsOutput.height).toBe(24);
    expect(Array.from(jsOutput.data)).toEqual(Array.from(wasmOutput));
  });

  it('P3/P4: 差分再マッチの出力 RGBA が一致する', async () => {
    const main = redBlueMain();
    const redFeature = featureThumb(40, 0, 0);
    const redCompose = composeThumb(64, 64, [40, 0, 0]);
    const blueFeature = featureThumb(0, 0, 255);
    const blueCompose = composeThumb(64, 64, [0, 0, 255]);

    wasm.set_main_image(toWasmBytes(main.data), main.width, main.height);
    wasm.add_tile(1n, toWasmBytes(redFeature.data), toWasmBytes(redCompose.data), 64, 64);
    wasm.run();
    wasm.add_tile(2n, toWasmBytes(blueFeature.data), toWasmBytes(blueCompose.data), 64, 64);
    wasm.begin_rematch();
    for (;;) {
      const out = wasm.step_run(0);
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
      if (done) {
        break;
      }
    }
    const wasmOutput = wasm.export_main_image();

    const jsCore = createJsCore();
    await jsCore.setMainImage(main);
    await jsCore.addTile(1n, redFeature, redCompose);
    await jsCore.run();
    await jsCore.addTile(2n, blueFeature, blueCompose);
    await jsCore.rematch();
    const jsOutput = await jsCore.exportImage();

    expect(Array.from(jsOutput.data)).toEqual(Array.from(wasmOutput));
  });

  it('P3/P4: 複数タイル・類似タイルを含む生成の出力 RGBA が一致する', async () => {
    const main = patternMain(96, 96);
    const tiles: Array<{
      id: bigint;
      feature: RgbaImage;
      compose: RgbaImage;
    }> = [
      { id: 1n, feature: featureThumb(255, 0, 0), compose: composeThumb(64, 64, [255, 0, 0]) },
      { id: 2n, feature: featureThumb(0, 255, 0), compose: composeThumb(64, 64, [0, 255, 0]) },
      { id: 3n, feature: featureThumb(0, 0, 255), compose: composeThumb(64, 64, [0, 0, 255]) },
      {
        id: 4n,
        feature: featureThumb(128, 128, 128),
        compose: composeThumb(64, 64, [128, 128, 128]),
      },
      { id: 5n, feature: featureThumb(254, 0, 0), compose: composeThumb(64, 64, [254, 0, 0]) },
    ];

    wasm.set_main_image(toWasmBytes(main.data), main.width, main.height);
    for (const tile of tiles) {
      wasm.add_tile(
        tile.id,
        toWasmBytes(tile.feature.data),
        toWasmBytes(tile.compose.data),
        tile.compose.width,
        tile.compose.height,
      );
    }
    wasm.run();
    const wasmOutput = wasm.export_main_image();

    const jsCore = createJsCore();
    await jsCore.setMainImage(main);
    for (const tile of tiles) {
      await jsCore.addTile(tile.id, tile.feature, tile.compose);
    }
    await jsCore.run();
    const jsOutput = await jsCore.exportImage();

    expect(Array.from(jsOutput.data)).toEqual(Array.from(wasmOutput));
  });

  it('P3/P4: タイル削除後の差分再マッチの出力 RGBA が一致する', async () => {
    const main = redBlueMain();
    const redFeature = featureThumb(255, 0, 0);
    const redCompose = composeThumb(64, 64, [255, 0, 0]);
    const blueFeature = featureThumb(0, 0, 255);
    const blueCompose = composeThumb(64, 64, [0, 0, 255]);

    wasm.set_main_image(toWasmBytes(main.data), main.width, main.height);
    wasm.add_tile(1n, toWasmBytes(redFeature.data), toWasmBytes(redCompose.data), 64, 64);
    wasm.add_tile(2n, toWasmBytes(blueFeature.data), toWasmBytes(blueCompose.data), 64, 64);
    wasm.run();
    wasm.remove_tile(2n);
    wasm.begin_rematch();
    for (;;) {
      const out = wasm.step_run(0);
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
      if (done) {
        break;
      }
    }
    const wasmOutput = wasm.export_main_image();

    const jsCore = createJsCore();
    await jsCore.setMainImage(main);
    await jsCore.addTile(1n, redFeature, redCompose);
    await jsCore.addTile(2n, blueFeature, blueCompose);
    await jsCore.run();
    await jsCore.removeTile(2n);
    await jsCore.rematch();
    const jsOutput = await jsCore.exportImage();

    expect(Array.from(jsOutput.data)).toEqual(Array.from(wasmOutput));
  });

  it('M7: メトリクスの trigger・回数・メモリ・設定が一致する', async () => {
    const main = redBlueMain();
    const redFeature = featureThumb(255, 0, 0);
    const redCompose = composeThumb(64, 64, [255, 0, 0]);
    const blueFeature = featureThumb(0, 0, 255);
    const blueCompose = composeThumb(64, 64, [0, 0, 255]);

    wasm.set_main_image(toWasmBytes(main.data), main.width, main.height);
    wasm.add_tile(1n, toWasmBytes(redFeature.data), toWasmBytes(redCompose.data), 64, 64);
    wasm.add_tile(2n, toWasmBytes(blueFeature.data), toWasmBytes(blueCompose.data), 64, 64);
    wasm.run();
    const wasmMetrics = JSON.parse(wasm.get_metrics()) as {
      runs: Array<{
        trigger: string;
        phases: {
          P2_TILE_ANALYZE: { tiles: number };
          P3_MATCH: { batches: number };
          P4_COMPOSE: { batches: number };
        };
        memory: { tiles_bytes: number };
        config: Record<string, number>;
      }>;
    };
    const wasmRun = wasmMetrics.runs[wasmMetrics.runs.length - 1];

    const jsCore = createJsCore();
    await jsCore.setMainImage(main);
    await jsCore.addTile(1n, redFeature, redCompose);
    await jsCore.addTile(2n, blueFeature, blueCompose);
    await jsCore.run();
    const jsMetrics = await jsCore.getMetrics();
    const jsRun = jsMetrics[jsMetrics.length - 1];

    expect(jsRun?.trigger).toBe(wasmRun?.trigger);
    expect(jsRun?.phases.P2_TILE_ANALYZE.tiles).toBe(wasmRun?.phases.P2_TILE_ANALYZE.tiles);
    expect(jsRun?.phases.P3_MATCH.batches).toBe(wasmRun?.phases.P3_MATCH.batches);
    expect(jsRun?.phases.P4_COMPOSE.batches).toBe(wasmRun?.phases.P4_COMPOSE.batches);
    expect(jsRun?.memory.tilesBytes).toBe(wasmRun?.memory.tiles_bytes);
    expect(jsRun?.config.block_size).toBe(wasmRun?.config.block_size);
    expect(jsRun?.config.w_c).toBeCloseTo(wasmRun?.config.w_c ?? 0, 5);
    expect(jsRun?.config.w_d).toBeCloseTo(wasmRun?.config.w_d ?? 0, 5);
    expect(jsRun?.config.alpha).toBeCloseTo(wasmRun?.config.alpha ?? 0, 5);
    expect(jsRun?.config.row_batch).toBe(wasmRun?.config.row_batch);
  });

  it('設定の既定値が一致する', async () => {
    const wasmConfig = JSON.parse(wasm.get_config()) as Record<string, number | boolean>;
    const jsConfig = await createJsCore().getConfig();
    for (const [key, value] of Object.entries(jsConfig)) {
      if (typeof value === 'boolean') {
        expect(wasmConfig[key]).toBe(value);
      } else {
        expect(wasmConfig[key]).toBeCloseTo(value, 5);
      }
    }
  });
});
