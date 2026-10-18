/**
 * コア呼び出しラッパ。
 *
 * handoff/04(M2): メイン画像解析(P1)を WASM で行う。
 * - wasm-pack 生成物(web/src/wasm/)を動的ロードする(ロードは 1 回のみ)
 * - ロードに失敗した環境ではモックへフォールバックする(UI 開発をブロックしない)
 * - コアの状態(メイン画像・ブロック特徴量)は WASM 内に保持される
 */
import { createMockCore } from './mockCore';
import type { CoreBridge, GridInfo, ProgressCallback, ProgressEvent, TileInfo } from './types';

/** コア実装の種類(デバッグ表示用) */
export type CoreImplementation = 'mock' | 'wasm';

let currentImplementation: CoreImplementation = 'mock';

export function getCoreImplementation(): CoreImplementation {
  return currentImplementation;
}

/** wasm-bindgen の JsGridInfo を型付き GridInfo へ写す(寿命管理のため free する) */
function toGridInfo(info: {
  free(): void;
  readonly width: number;
  readonly height: number;
  readonly block_size: number;
  readonly cols: number;
  readonly rows: number;
  readonly total_blocks: number;
}): GridInfo {
  const grid: GridInfo = {
    width: info.width,
    height: info.height,
    blockSize: info.block_size,
    cols: info.cols,
    rows: info.rows,
    totalBlocks: info.total_blocks,
  };
  info.free();
  return grid;
}

/** wasm-bindgen の JsTileInfo を型付き TileInfo へ写す(寿命管理のため free する) */
function toTileInfo(info: {
  free(): void;
  readonly id: bigint;
  readonly thumb_w: number;
  readonly thumb_h: number;
  readonly mean_lab: Float32Array;
  readonly detail: number;
  readonly usage: number;
}): TileInfo {
  const tile: TileInfo = {
    id: info.id,
    thumbWidth: info.thumb_w,
    thumbHeight: info.thumb_h,
    // mean_lab はコアの [f32; 3] 固定(詳細設計書 3 章)なので 3 要素は常に存在する
    meanLab: [info.mean_lab[0] as number, info.mean_lab[1] as number, info.mean_lab[2] as number],
    detail: info.detail,
    usage: info.usage,
  };
  info.free();
  return tile;
}

/** WASM 実装をロードして構築する(失敗時は例外を投げ、呼び出し側でモックへフォールバック) */
async function createWasmCore(): Promise<CoreBridge> {
  const wasm = await import('../wasm/photomosaic_core_wasm.js');
  await wasm.default();
  // 初期化が済んだことを往復サンプルで確認する(handoff/02 検収基準)
  wasm.add(1, 1);

  // 直近のグリッド情報(exportImage の寸法に使用。コア内状態のミラー)
  let lastGrid: GridInfo | null = null;

  const progressListeners = new Set<ProgressCallback>();
  const emit = (event: ProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  return {
    async getVersion(): Promise<string> {
      return wasm.get_version();
    },

    async setMainImage(image): Promise<GridInfo> {
      // Vec<u8> 引数への転送は wasm-bindgen がコピー 1 回で行う(handoff/02 2.4)
      const rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      const info = wasm.set_main_image(rgba, image.width, image.height);
      lastGrid = toGridInfo(info);
      return lastGrid;
    },

    async setBlockSize(px): Promise<GridInfo> {
      const info = wasm.set_block_size(px);
      lastGrid = toGridInfo(info);
      return lastGrid;
    },

    getBlockMeanColors(): Uint8Array {
      return wasm.get_block_mean_colors();
    },

    async addTile(id: bigint, feature, compose): Promise<TileInfo> {
      // Vec<u8> 引数への転送は wasm-bindgen がコピー 1 回で行う(handoff/02 2.4)
      const featureBytes = new Uint8Array(
        feature.data.buffer,
        feature.data.byteOffset,
        feature.data.byteLength,
      );
      const composeBytes = new Uint8Array(
        compose.data.buffer,
        compose.data.byteOffset,
        compose.data.byteLength,
      );
      const info = wasm.add_tile(id, featureBytes, composeBytes, compose.width, compose.height);
      return toTileInfo(info);
    },

    async removeTile(id: bigint): Promise<void> {
      wasm.remove_tile(id);
    },

    clearTiles(): void {
      wasm.clear_tiles();
    },

    getTileCount(): number {
      return wasm.get_tile_count();
    },

    getTilesMemoryBytes(): number {
      return wasm.get_tiles_memory_bytes();
    },

    clearMainImage(): void {
      wasm.clear_main_image();
      lastGrid = null;
    },

    async exportImage(): Promise<import('./types').RgbaImage> {
      // メイン画像はコア内に保持されている(M4 で合成結果の返却に差し替わる)
      if (!lastGrid) {
        throw new Error('main image is not set');
      }
      const rgba = wasm.export_main_image();
      // Uint8Array(ArrayBufferLike)から型付きバッファへ複製する(エクスポートは低頻度)
      const data = new Uint8ClampedArray(rgba.length);
      data.set(rgba);
      return { width: lastGrid.width, height: lastGrid.height, data };
    },

    onProgress(callback: ProgressCallback): void {
      progressListeners.add(callback);
    },

    runProgressDemo(durationMs = 1000): Promise<void> {
      if (durationMs <= 0) {
        return Promise.resolve();
      }
      // コア(Rust)のスロットラーが発火を判定し、発火したバッチだけ UI へ届く。
      // JS の setInterval はバッチ境界の駆動役(M5 でコア駆動の本実装に置き換わる)
      const demo = new wasm.ProgressDemo(1000);
      const start = performance.now();
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const step = (): void => {
          const elapsed = performance.now() - start;
          const ratio = Math.min(1, elapsed / durationMs);
          const event = demo.tick(elapsed, ratio);
          if (event !== undefined) {
            emit({
              phaseCode: event.phase_code,
              phaseRatio: event.phase_ratio,
              overallRatio: event.overall_ratio,
              assignedBlocks: event.assigned_blocks,
              totalBlocks: event.total_blocks,
            });
            event.free();
          }
          if (ratio >= 1) {
            if (timer !== null) {
              clearInterval(timer);
              timer = null;
            }
            demo.free();
            resolve();
          }
        };
        step(); // 開始時点(0%)を即時に通知する
        timer = setInterval(step, 16);
      });
    },
  };
}

/** WASM 初期化の結果をキャッシュする(1 回だけ試行。失敗時はモックへフォールバック) */
let wasmInit: Promise<CoreBridge> | null = null;

/**
 * コアブリッジを生成する。
 * WASM のロードに成功したら実装('wasm')を返し、失敗したらモック('mock')に
 * フォールバックする。実装の種類は getCoreImplementation() で確認できる。
 */
export async function createCoreBridge(): Promise<CoreBridge> {
  if (wasmInit === null) {
    wasmInit = createWasmCore()
      .then((core) => {
        currentImplementation = 'wasm';
        return core;
      })
      .catch((err: unknown) => {
        console.warn('WASM core failed to load, falling back to mock core', err);
        currentImplementation = 'mock';
        wasmInit = null; // 次回の呼び出しで再試行できるようにする
        return createMockCore();
      });
  }
  return wasmInit;
}
